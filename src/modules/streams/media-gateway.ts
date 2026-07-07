/**
 * media-gateway.ts
 *
 * MediaGateway — the ONLY component allowed to talk to MediaMTX.
 *
 * Responsibilities (and only these):
 *   - Provision / remove MediaMTX paths
 *   - Wait until a path is actually serving (RTSP connected + HLS muxer live)
 *   - Health-check an existing path
 *   - Reconcile orphaned paths against a caller-supplied "should exist" list
 *
 * It deliberately knows NOTHING about:
 *   - Vendors (Hikvision/HiFocus) — it only ever sees path names + RTSP URLs
 *   - Sessions / Redis / sessionId
 *   - recordingStart/End, currentPositionMs, or any playback concept
 *
 * This is a thin formalization of the existing mediamtx.client.ts, which was
 * already architecturally correct (see project analysis, Phase 1/6) — the
 * underlying provisionPath/removePathAndWait/waitForPathReady logic is
 * UNCHANGED. This file adds: openStream() (consolidating provision+wait+URL
 * build, previously duplicated 3x in playback.service.ts), isPathHealthy(),
 * reconcileOrphans(), and bounded retry around the MediaMTX config-API calls.
 */
import { env } from '../../config/env.js'
import { AppError } from '../../middleware/errorHandler.js'
import { withRetry } from '../../utils/retry.js'
import logger from '../../utils/logger.js'
import {
  getPath,
  provisionPath as rawProvisionPath,
  removePath as rawRemovePath,
  removePathAndWait as rawRemovePathAndWait,
  waitForPathReady as rawWaitForPathReady,
  listConfigPaths,
  type ProvisionOptions,
} from './mediamtx.client.js'

export interface OpenStreamOptions {
  isPlayback?: boolean
  sourceOnDemandCloseAfter?: string
}

export interface OpenedStream {
  hlsUrl: string
  whepUrl: string
}

// ── Retry policy for the local MediaMTX API calls ─────────────────────────────
// This is retrying OUR HTTP call to the local MediaMTX control API, not the
// NVR connection itself — almost always a transient local-network blip, never
// an auth/config problem, so blanket retry here is safe (see Phase 6).

const isMediaMtxApiErrorRetryable = (err: unknown): boolean => {
  // AppError(502, ...) is what provisionPath throws on a non-OK MediaMTX
  // response — treat as retryable; anything else (unexpected exception shape)
  // we still retry since local API calls have no auth-failure mode to worry
  // about protecting against.
  return true
}

const buildHlsUrl = (pathName: string): string => `${env.MEDIAMTX_HLS_URL}/${pathName}/index.m3u8`
const buildWhepUrl = (pathName: string): string => `${env.MEDIAMTX_WEBRTC_URL}/${pathName}/whep`

// ── Open a stream: provision + wait + URL build, in one call ──────────────────

export const openStream = async (
  pathName: string,
  rtspUrl: string,
  options: OpenStreamOptions = {}
): Promise<OpenedStream> => {
  await withRetry(() => rawProvisionPath(pathName, rtspUrl, options as ProvisionOptions), {
    retries: env.PLAYBACK_MEDIAMTX_API_RETRIES,
    baseDelayMs: 300,
    isRetryable: isMediaMtxApiErrorRetryable,
    label: `provisionPath(${pathName})`,
  })

  // NOTE: the NVR-source-connect wait is NOT retried here — if the RTSP
  // source never comes up (dead NVR, wrong credentials), retrying the exact
  // same provision call will fail identically. That decision belongs to
  // PlaybackService (which can choose to re-derive a fresh URL via the
  // adapter), not to the gateway (see Phase 6 "Retry Failed Streams").
  const result = await rawWaitForPathReady(pathName, env.PLAYBACK_PATH_READY_TIMEOUT_MS)

  if (!result.ready) {
    // Tightened vs. the original behavior: previously this only logged a
    // warning and let the caller create a session against a dead stream.
    // Now it throws, so a session can never exist without a working path
    // (Phase 3 §1 / Phase 6 "Wait Until Stream Is Ready").
    await rawRemovePath(pathName) // best-effort cleanup of the half-provisioned path

    const reason =
      result.stage === 'rtsp'
        ? 'the NVR RTSP source never connected (check NVR reachability, credentials, or that the requested time range actually has a recording)'
        : 'the RTSP source connected but MediaMTX never started packaging HLS (check that this server can reach MEDIAMTX_HLS_URL, and MediaMTX\'s HLS settings)'

    throw new AppError(502, `Stream for path "${pathName}" did not become ready in time: ${reason}.`)
  }

  return {
    hlsUrl: buildHlsUrl(pathName),
    whepUrl: buildWhepUrl(pathName),
  }
}

// ── Close a stream ─────────────────────────────────────────────────────────────

export const closeStream = async (pathName: string): Promise<void> => {
  await rawRemovePath(pathName)
}

export const closeStreamAndWait = async (
  pathName: string,
  nvrSlotReleaseMs: number = env.PLAYBACK_NVR_SLOT_RELEASE_MS
): Promise<void> => {
  await rawRemovePathAndWait(pathName, nvrSlotReleaseMs)
}

// ── Health check ────────────────────────────────────────────────────────────────

export const isPathHealthy = async (pathName: string): Promise<boolean> => {
  const path = await getPath(pathName)
  return Boolean(path?.ready)
}

// ── Orphan reconciliation ────────────────────────────────────────────────────────
// Relocated from playback.service.ts's cleanupOrphanedSessions — the diff
// itself is a gateway-level concern (it only needs "what paths currently
// exist" + "what should exist"), the caller just supplies the second half.

export const reconcileOrphans = async (
  activePathNames: string[],
  graceMs: number = env.PLAYBACK_ORPHAN_GRACE_MS
): Promise<string[]> => {
  const configPaths = await listConfigPaths()
  const activeSet = new Set(activePathNames)
  const now = Date.now()

  const orphaned = configPaths.filter((p) => {
    if (!p.includes('-pb-')) return false
    if (activeSet.has(p)) return false
    const ts = parseInt(p.split('-pb-').pop() ?? '', 10)
    return isNaN(ts) || now - ts >= graceMs
  })

  if (orphaned.length > 0) {
    logger.info(`MediaGateway: reconciling ${orphaned.length} orphaned path(s): ${orphaned.join(', ')}`)
    await Promise.all(orphaned.map(closeStream))
  }

  return orphaned
}