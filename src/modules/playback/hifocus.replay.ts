/**
 * hifocus.replay.ts
 *
 * Handles HiFocus NVR playback URL generation.
 *
 * KEY FINDING from diagnostic:
 *   GetReplayUri returns: rtsp://ip:554/chID=1&date=YYYY-MM-DD&time=HH:MM:SS&timelen=N&streamType=main&linkType=tcp
 *   - date/time are in NVR LOCAL time (not UTC)
 *   - timelen is duration in seconds from that start point
 *
 * SEEK ARCHITECTURE (re-resolve on seek — industry standard):
 *   1. First call for a given NVR: GetReplayUri + GetRecordingInformation to
 *      calibrate the NVR's timezone offset against the token's TRUE,
 *      unclipped earliest-recording time (NOT the requested/seek startTime —
 *      calibrating against a moving target makes the offset self-cancelling,
 *      which was the root cause of "playback/seek always starts from the
 *      first recording" regardless of what startTime was requested).
 *   2. That offset is cached per NVR (ip:httpPort) for TZ_OFFSET_CACHE_TTL_MS,
 *      since an NVR's clock/timezone essentially never changes mid-session.
 *   3. On every call (initial + seeks): GetReplayUri is still invoked to
 *      arm/authorize the recording token on the NVR, but the offset itself
 *      is only recalibrated when the cache is cold/expired.
 *   4. Backend builds the actual playback URL from (requested startTime +
 *      cached offset) — this is what makes seeking land on the correct
 *      point instead of snapping back to the recording start.
 */
import http from "http";
import crypto from "crypto";

import { searchHifocusRecordings, getRecordingTimeRange } from "./hifocus.search.js";

// ── WS-Security envelope ──────────────────────────────────────────────────────

const buildEnvelope = (
  username: string,
  password: string,
  body: string,
): string => {
  const timestamp = new Date().toISOString();
  const nonce = crypto.randomBytes(16);
  const digest = crypto
    .createHash("sha1")
    .update(
      Buffer.concat([
        nonce,
        Buffer.from(timestamp, "ascii"),
        Buffer.from(password, "ascii"),
      ]),
    )
    .digest("base64");

  const security =
    '<Security s:mustUnderstand="1" ' +
    'xmlns="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd">' +
    "<UsernameToken>" +
    `<Username>${username}</Username>` +
    `<Password Type="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-username-token-profile-1.0#PasswordDigest">${digest}</Password>` +
    `<Nonce EncodingType="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-soap-message-security-1.0#Base64Binary">${nonce.toString("base64")}</Nonce>` +
    `<Created xmlns="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-utility-1.0.xsd">${timestamp}</Created>` +
    "</UsernameToken></Security>";

  return (
    '<s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope">' +
    `<s:Header>${security}</s:Header>` +
    '<s:Body xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" ' +
    'xmlns:xsd="http://www.w3.org/2001/XMLSchema">' +
    body +
    "</s:Body></s:Envelope>"
  );
};

// ── Raw SOAP POST ─────────────────────────────────────────────────────────────

const soapPost = (
  ip: string,
  port: number,
  path: string,
  envelope: string,
): Promise<{ status: number; body: string }> => {
  const buf = Buffer.from(envelope, "utf-8");
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: ip,
        port,
        path,
        method: "POST",
        headers: {
          "Content-Type": "application/soap+xml; charset=utf-8",
          "Content-Length": buf.length,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf-8"),
          }),
        );
      },
    );
    req.setTimeout(15000, () => req.destroy(new Error("GetReplayUri timeout")));
    req.on("error", reject);
    req.write(buf);
    req.end();
  });
};

// ── URI extraction ────────────────────────────────────────────────────────────

const extractUri = (xml: string): string | null => {
  const match =
    xml.match(
      /<(?:[a-z]+:)?Uri[^>]*><!\[CDATA\[([^\]]+)\]\]><\/(?:[a-z]+:)?Uri>/i,
    ) ?? xml.match(/<(?:[a-z]+:)?Uri[^>]*>([^<]+)<\/(?:[a-z]+:)?Uri>/i);
  return match?.[1]?.trim() ?? null;
};

// ── Parse NVR timezone offset from returned URL ───────────────────────────────
// The NVR URL contains local date/time for the resolved RecordingToken.
// `recordingStartUtc` MUST be the token's true, unclipped earliest-recording
// UTC timestamp (from getRecordingTimeRange) — NOT the requested playback/
// seek startTime. GetReplayUri's returned local time corresponds to the
// recording's actual start, so anchoring against anything else (especially
// the very value the caller is trying to solve for) makes this offset
// self-cancelling: build the URL back from it and you always land on the
// same instant regardless of what was requested. See file header for the
// full explanation of the bug this fixes.

const parseOffsetFromUrl = (
  replayUrl: string,
  recordingStartUtc: Date,
): number => {
  const dateMatch = replayUrl.match(/date=(\d{4}-\d{2}-\d{2})/);
  const timeMatch = replayUrl.match(/time=(\d{2}:\d{2}:\d{2})/);
  if (!dateMatch || !timeMatch) return 0;

  const localDt = new Date(`${dateMatch[1]}T${timeMatch[1]}Z`); // parse as if UTC to get ms
  const offset = localDt.getTime() - recordingStartUtc.getTime();

  console.log(
    `Hifocus timezone offset: ${offset / 1000}s (${offset / 3600000}h)`,
  );
  return offset; // milliseconds
};

// ── Inject credentials into URL ───────────────────────────────────────────────

const injectCredentials = (
  uri: string,
  username: string,
  password: string,
): string => {
  return uri.replace(
    /^(rtsp:\/\/)/,
    `$1${encodeURIComponent(username)}:${encodeURIComponent(password)}@`,
  );
};

// ── Build playback URL from UTC time using known offset ───────────────────────

export const buildHifocusRtspUrl = (
  ip: string,
  rtspPort: number,
  username: string,
  password: string,
  channel: number,
  startTimeUtc: Date,
  endTimeUtc: Date,
  tzOffsetMs: number, // from getNvrTimezoneOffset()
): string => {
  // Convert UTC → NVR local time using the offset
  const localStart = new Date(startTimeUtc.getTime() + tzOffsetMs);
  const localEnd = new Date(endTimeUtc.getTime() + tzOffsetMs);

  const date = localStart.toISOString().split("T")[0]; // YYYY-MM-DD
  const time = localStart.toISOString().split("T")[1].slice(0, 8); // HH:MM:SS
  const timelen = Math.round(
    (localEnd.getTime() - localStart.getTime()) / 1000,
  );

  const url = `rtsp://${ip}:${rtspPort}/chID=${channel}&date=${date}&time=${time}&timelen=${timelen}&streamType=main&linkType=tcp`;
  return injectCredentials(url, username, password);
};

// ── Per-NVR timezone offset cache ─────────────────────────────────────────────
// Calibration requires an extra GetRecordingInformation round-trip, so we do
// it once per NVR and reuse the result — an NVR's clock/timezone doesn't
// change mid-session, and this is what makes repeated seeks fast instead of
// re-deriving (and re-corrupting) the offset on every request.
const TZ_OFFSET_CACHE_TTL_MS = 24 * 60 * 60 * 1000 // 24h — re-calibrate daily in case of NVR clock/config drift
const tzOffsetCache = new Map<string, { offsetMs: number; expiresAt: number }>()

const tzOffsetCacheKey = (ip: string, httpPort: number): string => `${ip}:${httpPort}`

// ── Public: get replay URI + timezone offset (called once per session) ────────

export interface HifocusReplayInfo {
  rtspUrl: string; // ready-to-use RTSP URL with credentials
  tzOffsetMs: number; // NVR local time offset from UTC in milliseconds
}

export const getHifocusReplayInfo = async (
  ip: string,
  httpPort: number,
  rtspPort: number,
  username: string,
  password: string,
  channel: number,
  startTimeUtc: Date,
  endTimeUtc: Date,
): Promise<HifocusReplayInfo> => {
  let token = `Record_${channel}_0`;

  try {
    const segments = await searchHifocusRecordings(
      ip,
      httpPort,
      username,
      password,
      channel,
      startTimeUtc,
      endTimeUtc
    );
    if (segments.length > 0) {
      const segment = segments.find(s => s.startTime <= startTimeUtc && s.endTime >= startTimeUtc) || segments[0];
      if (segment.token) {
        token = segment.token;
      }
    } else {
      console.warn(`Hifocus GetReplayUri: No segments found for ${startTimeUtc.toISOString()}, using fallback token`);
    }
  } catch (err) {
    console.warn(`Hifocus GetReplayUri: search failed, using fallback token: ${String(err)}`);
  }

  console.log(`Hifocus GetReplayUri: ${ip}:${httpPort} token="${token}"`);

  const body =
    '<GetReplayUri xmlns="http://www.onvif.org/ver10/replay/wsdl">' +
    "<StreamSetup>" +
    '<Stream xmlns="http://www.onvif.org/ver10/schema">RTP-Unicast</Stream>' +
    '<Transport xmlns="http://www.onvif.org/ver10/schema"><Protocol>RTSP</Protocol></Transport>' +
    "</StreamSetup>" +
    `<RecordingToken>${token}</RecordingToken>` +
    "</GetReplayUri>";

  const result = await soapPost(
    ip,
    httpPort,
    "/onvif/Replay",
    buildEnvelope(username, password, body),
  );

   if (result.status !== 200) {
    console.error(`Hifocus GetReplayUri full fault body: ${result.body}`)
    throw new Error(
      `GetReplayUri returned HTTP ${result.status}: ${result.body.slice(0, 200)}`,
    );
  }

  const rawUri = extractUri(result.body);
  if (!rawUri) {
    throw new Error(
      `GetReplayUri returned no URI. Response: ${result.body.slice(0, 200)}`,
    );
  }

  console.log(`Hifocus raw replay URI: ${rawUri}`);

  // ── NVR timezone offset ──────────────────────────────────────────────────
  // Reuse a cached, previously-calibrated offset if we have a fresh one for
  // this NVR. Recalibrating on every call (including every seek) using the
  // requested startTime as the anchor is what caused playback/seeks to
  // always snap back to the same instant — see file header.
  const cacheKey = tzOffsetCacheKey(ip, httpPort);
  const cached = tzOffsetCache.get(cacheKey);
  let tzOffsetMs: number;

  if (cached && cached.expiresAt > Date.now()) {
    tzOffsetMs = cached.offsetMs;
  } else {
    // Calibrate against the token's TRUE, unclipped earliest-recording time
    // — not startTimeUtc, which is just whatever the caller asked for (the
    // very thing we'd be solving for) and is often already clipped to the
    // request window upstream in searchHifocusRecordings().
    let anchor = startTimeUtc; // last-resort fallback if calibration fails
    try {
      const { earliestRecording } = await getRecordingTimeRange(
        ip,
        httpPort,
        username,
        password,
        token,
      );
      if (earliestRecording && !isNaN(earliestRecording.getTime())) {
        anchor = earliestRecording;
      } else {
        console.warn(
          `Hifocus tz calibration: no earliestRecording for token "${token}", falling back to requested startTime (offset may be wrong for seeks)`,
        );
      }
    } catch (err) {
      console.warn(
        `Hifocus tz calibration: getRecordingTimeRange failed, falling back to requested startTime: ${String(err)}`,
      );
    }

    tzOffsetMs = parseOffsetFromUrl(rawUri, anchor);
    tzOffsetCache.set(cacheKey, { offsetMs: tzOffsetMs, expiresAt: Date.now() + TZ_OFFSET_CACHE_TTL_MS });
    console.log(`Hifocus tz offset calibrated for ${cacheKey}: ${tzOffsetMs / 3600000}h (cached ${TZ_OFFSET_CACHE_TTL_MS / 3600000}h)`);
  }

  // Build the actual URL for the requested time range using the offset
  const rtspUrl = buildHifocusRtspUrl(
    ip,
    rtspPort,
    username,
    password,
    channel,
    startTimeUtc,
    endTimeUtc,
    tzOffsetMs,
  );

  console.log(
    `Hifocus playback URL: ${rtspUrl.replace(/:([^@/]+)@/, ":***@")}`,
  );

  return { rtspUrl, tzOffsetMs };
};