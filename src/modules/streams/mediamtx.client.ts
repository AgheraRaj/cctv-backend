import { env } from '../../config/env.js'
import { AppError } from '../../middleware/errorHandler.js'

interface MediaMTXPath {
  name: string
  source?: { type: string }
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
  options: { sourceOnDemandCloseAfter?: string } = {}
): Promise<void> => {
  const response = await fetch(
    `${env.MEDIAMTX_API_URL}/v3/config/paths/add/${pathName}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        source: rtspUrl,
        sourceOnDemand: true,
        sourceOnDemandStartTimeout: '30s',
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