import { env } from '../../config/env.js'
import { AppError } from '../../middleware/errorHandler.js'
import logger from '../../utils/logger.js'

interface MediaMTXPath {
  name: string
  ready?: boolean
  source?: { type: string }
}

export interface ProvisionOptions {
  isPlayback?: boolean               // true = eager connect (no sourceOnDemand)
  sourceOnDemandCloseAfter?: string  // only for live streams
}

// ── Get path info ─────────────────────────────────────────────────────────────

export const getPath = async (pathName: string): Promise<MediaMTXPath | null> => {
  try {
    const response = await fetch(`${env.MEDIAMTX_API_URL}/v3/paths/get/${pathName}`)
    if (response.status === 404) return null
    if (!response.ok) return null
    return response.json()
  } catch {
    return null
  }
}

// ── Get HLS muxer status ──────────────────────────────────────────────────────
// In MediaMTX, the HLS muxer API does NOT expose a 'state' field.
// The mere presence of the muxer object in the API response means it is active.

const getHlsMuxer = async (pathName: string): Promise<Record<string, unknown> | null> => {
  try {
    const response = await fetch(`${env.MEDIAMTX_API_URL}/v3/hlsmuxers/get/${pathName}`)
    if (response.status === 404) return null
    if (!response.ok) return null
    return response.json()
  } catch {
    return null
  }
}

// ── Provision path ────────────────────────────────────────────────────────────

export const provisionPath = async (
  pathName: string,
  rtspUrl: string,
  options: ProvisionOptions = {}
): Promise<void> => {
  const isPlayback = options.isPlayback ?? false

  const body = isPlayback
    ? {
        // PLAYBACK: sourceOnDemand=false — MediaMTX connects to NVR immediately.
        // Do NOT use sourceOnDemand=true for playback — it requires a "trigger"
        // fetch that opens an orphaned HLS reader session, causing 453 errors.
        source: rtspUrl,
        sourceOnDemand: false,
        rtspTransport: 'tcp', // Force TCP to prevent UDP timeout issues
      }
    : {
        // LIVE: lazy connect — only connects when a viewer arrives.
        source: rtspUrl,
        sourceOnDemand: true,
        sourceOnDemandStartTimeout: '10s',
        sourceOnDemandCloseAfter: options.sourceOnDemandCloseAfter ?? '300s',
        rtspTransport: 'tcp', // Force TCP to prevent UDP timeout issues
      }

  const response = await fetch(
    `${env.MEDIAMTX_API_URL}/v3/config/paths/add/${pathName}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }
  )

  if (!response.ok) {
    const err = await response.text()
    throw new AppError(502, `Failed to provision MediaMTX path: ${err}`)
  }
}

// ── Remove path ───────────────────────────────────────────────────────────────

export const removePath = async (pathName: string): Promise<void> => {
  try {
    await fetch(`${env.MEDIAMTX_API_URL}/v3/config/paths/delete/${pathName}`, {
      method: 'DELETE',
    })
  } catch {
    // Non-fatal
  }
}

// ── List configured paths ──────────────────────────────────────────────────────

export const listConfigPaths = async (): Promise<string[]> => {
  try {
    const response = await fetch(`${env.MEDIAMTX_API_URL}/v3/config/paths/list`)
    if (!response.ok) return []
    const data = await response.json()
    if (data && Array.isArray(data.items)) {
      return data.items.map((item: any) => item.name as string)
    }
    return []
  } catch {
    return []
  }
}

// ── Remove path and wait for NVR RTSP slot to be released ────────────────────
// The NVR has a per-channel RTSP connection limit. If we provision a new path
// before the old path's RTSP connection fully closes at the NVR level,
// the NVR rejects the new connection with 453.
//
// Fix: delete old path → confirm it's gone from MediaMTX → wait for NVR teardown.

export const removePathAndWait = async (
  pathName: string,
  nvrSlotReleaseMs = 1500
): Promise<void> => {
  await removePath(pathName)

  const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    const path = await getPath(pathName)
    if (!path) break
    await new Promise((r) => setTimeout(r, 200))
  }

  // Additional buffer: NVR TCP teardown is async and not observable externally
  await new Promise((r) => setTimeout(r, nvrSlotReleaseMs))
  logger.debug(`Path "${pathName}" removed and NVR slot released`)
}

// ── Wait for path + HLS muxer ready ──────────────────────────────────────────
// Two-stage:
//   Stage 1: RTSP source connected (path.ready=true)  ~1s
//   Stage 2: HLS muxer exists in API  ~1-3s for H265
//
// IMPORTANT: MediaMTX's HLS muxer API does NOT expose a 'state' field.
// The mere presence of the muxer object returned by the API means it is active
// and producing segments. We poll for existence, not for a state value.
//
// IMPORTANT #2 — the actual root cause of "did not become ready in time":
// MediaMTX creates the HLS muxer for a path LAZILY, only on the first HTTP
// request to that path's actual HLS endpoint (e.g. GET /{path}/index.m3u8) —
// unless `hlsAlwaysRemux: yes` is set globally in mediamtx.yml. Nothing in
// this flow ever hit that endpoint before Stage 2 previously just polled
// /v3/hlsmuxers/get/{pathName} for a muxer that was never triggered into
// existence, so it looped until timeout regardless of whether the NVR
// stream connected fine. We now proactively "warm" the muxer by requesting
// the playlist ourselves at the start of each poll iteration.
//
// Stage 2 is critical for H265 streams — the HLS muxer must receive
// VPS/SPS/PPS parameter sets before it can write the first segment.
// Without this check we return hlsUrl before the muxer is ready → 404/crash.

const warmHlsMuxer = (pathName: string): void => {
  // Fire-and-forget: MediaMTX spins the muxer up on receiving this request
  // even if the response itself isn't a full playlist yet (e.g. 404/500
  // while segments are still buffering). Errors here are expected and
  // intentionally swallowed — the real signal is getHlsMuxer() below.
  fetch(`${env.MEDIAMTX_HLS_URL}/${pathName}/index.m3u8`).catch(() => {})
}

export const waitForPathReady = async (
  pathName: string,
  timeoutMs = 15000,
  pollIntervalMs = 300
): Promise<{ ready: boolean; stage: 'rtsp' | 'hls' | 'ok' }> => {
  const deadline = Date.now() + timeoutMs

  // Stage 1: RTSP source connected
  let rtspReady = false
  while (Date.now() < deadline) {
    const path = await getPath(pathName)
    if (path?.ready) { rtspReady = true; break }
    await new Promise((r) => setTimeout(r, pollIntervalMs))
  }

  if (!rtspReady) {
    logger.warn(`waitForPathReady: RTSP never connected for "${pathName}" — check NVR reachability/credentials/time range`)
    return { ready: false, stage: 'rtsp' }
  }

  // Stage 2: HLS muxer exists (presence = it is active and producing segments).
  // Warm it up ourselves on every iteration since nothing else will.
  while (Date.now() < deadline) {
    warmHlsMuxer(pathName)

    const muxer = await getHlsMuxer(pathName)
    if (muxer !== null) {
      logger.debug(`waitForPathReady: HLS muxer active for "${pathName}"`)
      return { ready: true, stage: 'ok' }
    }
    await new Promise((r) => setTimeout(r, pollIntervalMs))
  }

  logger.warn(`waitForPathReady: HLS muxer never became active for "${pathName}" — check MediaMTX HLS config/reachability of MEDIAMTX_HLS_URL from this server`)
  return { ready: false, stage: 'hls' }
}