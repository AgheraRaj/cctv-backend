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
 *   1. First call: GetReplayUri to get base URL + extract NVR timezone offset
 *   2. Return offset to frontend alongside hlsUrl
 *   3. On seek: frontend sends new startTime → backend constructs URL using offset
 *   4. No additional ONVIF calls needed for seeking → fast (~1s)
 */
import http from "http";
import crypto from "crypto";
import logger from "../../utils/logger.js";

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
// The NVR URL contains local date/time. We know the UTC recording start
// from GetRecordingSummary. The difference = NVR timezone offset in seconds.

const parseOffsetFromUrl = (
  replayUrl: string,
  recordingStartUtc: Date,
): number => {
  const dateMatch = replayUrl.match(/date=(\d{4}-\d{2}-\d{2})/);
  const timeMatch = replayUrl.match(/time=(\d{2}:\d{2}:\d{2})/);
  if (!dateMatch || !timeMatch) return 0;

  const localDt = new Date(`${dateMatch[1]}T${timeMatch[1]}Z`); // parse as if UTC to get ms
  const offset = localDt.getTime() - recordingStartUtc.getTime();

  logger.info(
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
  const token = `Record_${channel}_0`;

  logger.info(`Hifocus GetReplayUri: ${ip}:${httpPort} token="${token}"`);

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

  logger.info(`Hifocus raw replay URI: ${rawUri}`);

  // Compute NVR timezone offset from the returned URL
  const tzOffsetMs = parseOffsetFromUrl(rawUri, startTimeUtc);

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

  logger.info(
    `Hifocus playback URL: ${rtspUrl.replace(/:([^@/]+)@/, ":***@")}`,
  );

  return { rtspUrl, tzOffsetMs };
};
