import { env } from '../../config/env.js'
import { AppError } from '../../middleware/errorHandler.js'

interface MediaMTXPath {
  name: string
  ready?: boolean
  source?: { type: string }
}

interface ProvisionOptions {
  sourceOnDemandCloseAfter?: string  // e.g. '60s' for playback, '300s' for live
}

// Check if a path already exists in MediaMTX
export const getPath = async (pathName: string): Promise<MediaMTXPath | null> => {
  try {
    const response = await fetch(`${env.MEDIAMTX_API_URL}/v3/paths/get/${pathName}`)
    if (response.status === 404) return null
    if (!response.ok) throw new AppError(502, 'MediaMTX API error.')
    return response.json()
  } catch {
    return null
  }
}

// Provision a new path in MediaMTX with RTSP as source
export const provisionPath = async (
  pathName: string,
  rtspUrl: string,
  options: ProvisionOptions = {}
): Promise<void> => {
  const response = await fetch(
    `${env.MEDIAMTX_API_URL}/v3/config/paths/add/${pathName}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        source: rtspUrl,
        sourceOnDemand: true,
        sourceOnDemandStartTimeout: '10s',
        sourceOnDemandCloseAfter: options.sourceOnDemandCloseAfter ?? '300s',
      }),
    }
  )

  if (!response.ok) {
    const err = await response.text()
    throw new AppError(502, `Failed to provision MediaMTX path: ${err}`)
  }
}

// Remove a path from MediaMTX — called when camera is deleted or playback stops
export const removePath = async (pathName: string): Promise<void> => {
  await fetch(`${env.MEDIAMTX_API_URL}/v3/config/paths/delete/${pathName}`, {
    method: 'DELETE',
  })
}

/**
 * Waits for MediaMTX to actually have a connected, ready source for the path
 * before returning. Eliminates the race condition where the frontend requests
 * index.m3u8 before MediaMTX has finished the RTSP handshake with the NVR
 * (which returns HTTP 500 until the first segment is produced).
 *
 * sourceOnDemand paths only start connecting to the RTSP source on the FIRST
 * HTTP request to them — so we make a throwaway request to trigger that,
 * then poll /v3/paths/get until ready=true or timeout.
 */
export const waitForPathReady = async (
  pathName: string,
  timeoutMs = 8000,
  pollIntervalMs = 300
): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs

  // Trigger MediaMTX to start connecting to the RTSP source.
  // We hit the HLS index endpoint directly — same trigger the frontend uses,
  // but we eat the (possibly 500) response here instead of the browser.
  try {
    await fetch(`${env.MEDIAMTX_HLS_URL}/${pathName}/index.m3u8`)
  } catch {
    // Ignore — this is just the trigger, not a result we depend on
  }

  while (Date.now() < deadline) {
    const path = await getPath(pathName)
    if (path?.ready) return true
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs))
  }

  return false
}