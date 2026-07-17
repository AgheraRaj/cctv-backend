// src/modules/playback/hifocus.search.ts
//
// PERFORMANCE NOTE (playback-start latency fix):
//   getRecords() (full catalog dump) + per-token getRecordingInformation()
//   were the two most expensive calls in the whole HiFocus playback-start
//   path, and both were being redone from scratch on every single session
//   create — plus a second full ONVIF Cam handshake was happening inside
//   getRecordingTimeRange() for TZ calibration, re-fetching info for a token
//   already resolved moments earlier in the same request.
//
//   Fix: a per-NVR token cache (5 min TTL) built once via connect +
//   GetRecordingSummary + GetRecordings + N x GetRecordingInformation, and a
//   warm-connection cache (30 min TTL) so the ONVIF handshake itself isn't
//   repeated either. searchHifocusRecordings() and getRecordingTimeRange()
//   keep their exact original signatures/behavior — callers (hifocus.replay.ts,
//   hifocus.adapter.ts) need zero changes.

import { createRequire } from "module";
import { Cam } from "onvif";
import { env } from "../../config/env.js";
import {
  withRetry,
  withTimeout,
  mapWithConcurrency,
} from "../../utils/retry.js";
import logger from "../../utils/logger.js";
import type { RecordingSegment } from "./hikvision.search.js";

const require = createRequire(import.meta.url);
const linerase: (data: any) => any = require("onvif/lib/utils").linerase;

// ── Connect ───────────────────────────────────────────────────────────────────

const connectToNVR = (
  hostname: string,
  username: string,
  password: string,
  port: number,
): Promise<Cam> =>
  new Promise((resolve) => {
    // Never reject — the GetSystemDateAndTime / timeShift error is non-fatal on
    // many HiFocus NVRs. The cam object is fully usable even when this fails.
    new Cam({ hostname, username, password, port }, function (this: Cam, err) {
      if (err) {
        logger.warn(
          `Hifocus ${hostname}: connect warning (non-fatal): ${String(err)}`,
        );
      }
      resolve(this);
    });
  });

// ── Warm connection cache ────────────────────────────────────────────────────
// The onvif `Cam` constructor pays for its own capability/profile-discovery
// handshake — expensive to repeat on every request. Reused across search +
// replay calls for the same NVR.

const CAM_CACHE_TTL_MS = 30 * 60 * 1000; // 30 min — periodic refresh as a safety net against a silently-dead socket
const camCache = new Map<string, { cam: Cam; expiresAt: number }>();

const camCacheKey = (ip: string, httpPort: number): string => `${ip}:${httpPort}`;

const getOrConnectCam = async (
  ip: string,
  username: string,
  password: string,
  httpPort: number,
): Promise<Cam> => {
  const key = camCacheKey(ip, httpPort);
  const cached = camCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.cam;

  const cam = await connectToNVR(ip, username, password, httpPort);
  camCache.set(key, { cam, expiresAt: Date.now() + CAM_CACHE_TTL_MS });
  return cam;
};

const invalidateCam = (ip: string, httpPort: number): void => {
  camCache.delete(camCacheKey(ip, httpPort));
};

// Run an operation against the warm cam; on failure, drop the cached
// connection and retry once against a freshly-constructed one. connectToNVR()
// never rejects (errors there are logged, not thrown), so a downstream
// failure is the only real signal that the cached socket has gone stale.
const withCam = async <T>(
  ip: string,
  httpPort: number,
  username: string,
  password: string,
  fn: (cam: Cam) => Promise<T>,
): Promise<T> => {
  const cam = await getOrConnectCam(ip, username, password, httpPort);
  try {
    return await fn(cam);
  } catch (err) {
    logger.warn(`Hifocus ${ip}: cached ONVIF connection failed, reconnecting: ${String(err)}`);
    invalidateCam(ip, httpPort);
    const freshCam = await getOrConnectCam(ip, username, password, httpPort);
    return fn(freshCam);
  }
};

// ── GetRecordingSummary ───────────────────────────────────────────────────────
// Retried on failure — a transient SOAP/network fault here shouldn't abort
// the whole search when a retry is cheap and safe (read-only, idempotent).

const getRecordingSummary = (
  cam: Cam,
): Promise<{
  dataFrom: Date;
  dataUntil: Date;
  numberRecordings: number;
} | null> =>
  withRetry(
    () =>
      new Promise<{
        dataFrom: Date;
        dataUntil: Date;
        numberRecordings: number;
      }>((resolve, reject) => {
        (cam as any).getRecordingSummary((err: Error | null, result: any) => {
          if (err) reject(err);
          else resolve(result);
        });
      }),
    {
      retries: env.PLAYBACK_SEARCH_RETRIES,
      baseDelayMs: 500,
      label: "Hifocus GetRecordingSummary",
    },
  ).catch((err) => {
    logger.debug(
      `Hifocus GetRecordingSummary failed after retries: ${String(err)}`,
    );
    return null;
  });

// ── GetRecordings ─────────────────────────────────────────────────────────────

const getRecordings = (cam: Cam): Promise<any[]> =>
  withRetry(
    () =>
      new Promise<any[]>((resolve, reject) => {
        (cam as any).getRecordings((err: Error | null, items: any) => {
          if (err) reject(err);
          else resolve(items ? (Array.isArray(items) ? items : [items]) : []);
        });
      }),
    {
      retries: env.PLAYBACK_SEARCH_RETRIES,
      baseDelayMs: 500,
      label: "Hifocus GetRecordings",
    },
  );

// ── GetRecordingInformation (fixed) ──────────────────────────────────────────
// onvif 0.8.1 bug: getRecordingInformation() reads the wrong response key.
// Fixed by calling cam._request() directly with the correct response key.
//
// Wrapped in an explicit timeout (the underlying onvif lib's _request has no
// visible timeout of its own) so one unresponsive token can't hang the whole
// search indefinitely.

const getRecordingInformation = (
  cam: Cam,
  recordingToken: string,
): Promise<{ earliestRecording?: Date; latestRecording?: Date } | null> => {
  const camAny = cam as any;

  const request = new Promise<{
    earliestRecording?: Date;
    latestRecording?: Date;
  } | null>((resolve) => {
    camAny._request(
      {
        service: "search",
        body:
          camAny._envelopeHeader() +
          '<GetRecordingInformation xmlns="http://www.onvif.org/ver10/search/wsdl">' +
          "<RecordingToken>" +
          recordingToken +
          "</RecordingToken>" +
          "</GetRecordingInformation>" +
          camAny._envelopeFooter(),
      },
      (err: Error | null, data: any) => {
        if (err) {
          logger.warn(
            `Hifocus GetRecordingInformation failed for "${recordingToken}": ${String(err)}`,
          );
          resolve(null);
          return;
        }
        try {
          const info =
            linerase(data)?.getRecordingInformationResponse
              ?.recordingInformation;
          resolve(info ?? null);
        } catch (parseErr) {
          logger.warn(
            `Hifocus GetRecordingInformation parse error for "${recordingToken}": ${String(parseErr)}`,
          );
          resolve(null);
        }
      },
    );
  });

  return withTimeout(
    request,
    env.PLAYBACK_RECORDING_INFO_TIMEOUT_MS,
    `GetRecordingInformation(${recordingToken})`,
  ).catch((err) => {
    logger.warn(
      `Hifocus GetRecordingInformation timed out for "${recordingToken}": ${String(err)}`,
    );
    return null;
  });
};

// ── Per-NVR token cache ──────────────────────────────────────────────────────
// THE fix for playback-start latency. Cached per-NVR (not per-channel) since
// GetRecordings returns every channel's tokens in one call anyway — build
// once, filter by channel in-memory on every read. Channel resolution
// (SourceId → channel number, with the same string-matching fallback the
// original code used) happens ONCE here at build time, which is what lets a
// cache HIT skip needing `cam` — and therefore any NVR round-trip — entirely.

export interface HifocusTokenInfo {
  token: string;
  channel: number;
  earliestRecording: Date | null;
  latestRecording: Date | null;
}

export interface NvrTokenCacheEntry {
  tokens: HifocusTokenInfo[];
  summaryFrom: Date | null;
  summaryUntil: Date | null;
  expiresAt: number;
}

const TOKEN_CACHE_TTL_MS = 5 * 60 * 1000; // 5 min — recording tokens for a channel don't churn faster than this
const tokenCache = new Map<string, NvrTokenCacheEntry>();

const tokenCacheKey = (ip: string, httpPort: number): string => `${ip}:${httpPort}`;

const toDate = (v: unknown): Date | null => {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(v as string);
  return isNaN(d.getTime()) ? null : d;
};

// Builds the full per-NVR token cache from scratch — the expensive path
// (connect + GetRecordingSummary + GetRecordings + N x
// GetRecordingInformation). Only runs on a cold/expired cache.
const buildTokenCache = async (
  ip: string,
  httpPort: number,
  username: string,
  password: string,
): Promise<NvrTokenCacheEntry> =>
  withCam(ip, httpPort, username, password, async (cam) => {
    const summary = await getRecordingSummary(cam);
    const summaryFrom = summary ? toDate(summary.dataFrom) : null;
    const summaryUntil = summary ? toDate(summary.dataUntil) : null;

    if (summary) {
      logger.info(
        `Hifocus ${ip}: ${summary.numberRecordings} recording(s), ` +
          `${summaryFrom?.toISOString()} → ${summaryUntil?.toISOString()}`,
      );
    }

    const allRecordings = await getRecordings(cam);
    logger.info(`Hifocus ${ip}: ${allRecordings.length} total recording token(s)`);

    const videoSourceTokens = Object.keys((cam as any).videoSources || {});

    const withChannel = allRecordings
      .map((rec) => {
        const tokenStr = (rec?.recordingToken ?? rec?.$?.token) as string | undefined;
        if (!tokenStr) return null;

        const sourceId = rec?.Configuration?.Source?.SourceId;
        let channel = sourceId ? videoSourceTokens.indexOf(sourceId) + 1 : 0;

        if (channel < 1) {
          // Fallback: infer from the token string itself (same heuristic the
          // original per-request filter used).
          const found = videoSourceTokens.findIndex((_, i) => {
            const channelStr = (i + 1).toString().padStart(3, "0");
            return tokenStr.includes(channelStr) || tokenStr.includes(`_${i + 1}`);
          });
          channel = found + 1;
        }

        return channel > 0 ? { token: tokenStr, channel } : null;
      })
      .filter((t): t is { token: string; channel: number } => t !== null);

    const infos = await mapWithConcurrency(
      withChannel,
      env.PLAYBACK_SEARCH_MAX_CONCURRENCY,
      async ({ token, channel }): Promise<HifocusTokenInfo> => {
        const info = await getRecordingInformation(cam, token);
        return {
          token,
          channel,
          earliestRecording: toDate(info?.earliestRecording),
          latestRecording: toDate(info?.latestRecording),
        };
      },
    );

    return {
      tokens: infos,
      summaryFrom,
      summaryUntil,
      expiresAt: Date.now() + TOKEN_CACHE_TTL_MS,
    };
  });

// Public: get the (possibly cached) token list for an NVR.
export const getHifocusTokens = async (
  ip: string,
  httpPort: number,
  username: string,
  password: string,
  forceRefresh: boolean = false,
): Promise<NvrTokenCacheEntry> => {
  const key = tokenCacheKey(ip, httpPort);
  const cached = tokenCache.get(key);
  if (!forceRefresh && cached && cached.expiresAt > Date.now()) {
    return cached;
  }

  const entry = await buildTokenCache(ip, httpPort, username, password);
  tokenCache.set(key, entry);
  return entry;
};

// ── Unclipped recording range for a single token ──────────────────────────────
// Used by hifocus.replay.ts to calibrate the NVR's timezone offset against
// the token's TRUE earliest recording time — see that file's header for why.
//
// FIX APPLIED HERE: this used to call connectToNVR() + getRecordingInformation()
// fresh every time — a full second ONVIF handshake, duplicating work
// searchHifocusRecordings() (called moments earlier in the same request) had
// already done. Now it reads from the same token cache — on the normal path
// this is an in-memory hit costing zero network round-trips. Signature and
// return type are unchanged, so hifocus.replay.ts needs no changes.

export const getRecordingTimeRange = async (
  ip: string,
  httpPort: number,
  username: string,
  password: string,
  token: string,
): Promise<{ earliestRecording: Date | null; latestRecording: Date | null }> => {
  const { tokens } = await getHifocusTokens(ip, httpPort, username, password);
  const match = tokens.find((t) => t.token === token);
  if (match) {
    return { earliestRecording: match.earliestRecording, latestRecording: match.latestRecording };
  }

  // Token not in cache (rare — e.g. a brand-new recording block that started
  // after the cache was built). Falls back to a single direct lookup rather
  // than forcing a full cache rebuild — still benefits from the warm cam cache.
  logger.debug(`Hifocus ${ip}: token "${token}" not in cache, doing a direct lookup`);
  return withCam(ip, httpPort, username, password, async (cam) => {
    const info = await getRecordingInformation(cam, token);
    return { earliestRecording: toDate(info?.earliestRecording), latestRecording: toDate(info?.latestRecording) };
  });
};

// ── Main export ───────────────────────────────────────────────────────────────
// Filters the (cached) per-NVR token list down to one channel + time window.
// On a warm cache this is pure in-memory filtering — zero NVR round-trips.
// Signature and return shape are identical to the original.

export const searchHifocusRecordings = async (
  ip: string,
  httpPort: number,
  username: string,
  password: string,
  channel: number,
  startTime: Date,
  endTime: Date,
): Promise<RecordingSegment[]> => {
  logger.info(
    `Hifocus search: http://${ip}:${httpPort} ch${channel} ` +
      `range=${startTime.toISOString()}→${endTime.toISOString()}`,
  );

  const { tokens, summaryFrom, summaryUntil } = await getHifocusTokens(ip, httpPort, username, password);

  if (summaryFrom && summaryUntil && (endTime < summaryFrom || startTime > summaryUntil)) {
    logger.info(`Hifocus ${ip}: query range is outside available recordings`);
    return [];
  }

  const channelTokens = tokens.filter((t) => t.channel === channel);
  if (channelTokens.length === 0) {
    logger.info(`Hifocus ${ip}: no recordings found for channel ${channel}`);
    return [];
  }

  const segments: RecordingSegment[] = [];

  for (const { token, earliestRecording, latestRecording } of channelTokens) {
    const recStart = earliestRecording ?? summaryFrom;
    const recEnd = latestRecording ?? summaryUntil;

    if (!recStart || !recEnd) {
      logger.warn(`Hifocus ${ip}: no time range for token "${token}" — skipping`);
      continue;
    }

    if (recEnd < startTime || recStart > endTime) continue;

    const clippedStart = recStart < startTime ? startTime : recStart;
    const clippedEnd = recEnd > endTime ? endTime : recEnd;

    logger.info(
      `Hifocus ${ip}: matched token "${token}" → ${clippedStart.toISOString()}→${clippedEnd.toISOString()}`,
    );
    segments.push({ channel, startTime: clippedStart, endTime: clippedEnd, token });
  }

  logger.info(`Hifocus ${ip} ch${channel}: returning ${segments.length} segment(s)`);
  return segments;
};