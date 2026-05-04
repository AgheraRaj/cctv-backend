import prisma from '../../config/db.js'
import { AppError } from '../../middleware/errorHandler.js'
import { decrypt } from '../../utils/crypto.js'
import { getCache, setCache } from '../../utils/cache.js'
import { generateRTSP } from '../nvrs/rtsp.generator.js'
import { getPath, provisionPath } from './mediamtx.client.js'
import { env } from '../../config/env.js'

interface StreamRequest {
  nvrId: string
  channel: number
}

interface StreamResult {
  nvrId: string
  channel: number
  whepUrl: string | null
  error?: string
}

export const resolveStreams = async (
  requests: StreamRequest[]
): Promise<StreamResult[]> => {
  // Process all stream requests concurrently
  const results = await Promise.allSettled(
    requests.map((req) => resolveStream(req.nvrId, req.channel))
  )

  return results.map((result, index) => {
    if (result.status === 'fulfilled') {
      return result.value
    }

    // One stream failing should not fail the entire batch
    return {
      nvrId: requests[index].nvrId,
      channel: requests[index].channel,
      whepUrl: null,
      error: result.reason?.message ?? 'Failed to resolve stream.',
    }
  })
}

const resolveStream = async (
  nvrId: string,
  channel: number
): Promise<StreamResult> => {
  const cacheKey = `stream:${nvrId}:${channel}`

  // 1. Check Redis cache first
  const cached = await getCache<string>(cacheKey)
  if (cached) {
    return { nvrId, channel, whepUrl: cached }
  }

  // 2. Fetch NVR from DB
  const nvr = await prisma.nVR.findUnique({ where: { id: nvrId } })
  if (!nvr) throw new AppError(404, `NVR ${nvrId} not found.`)

  // 3. Verify camera exists and is active on this channel
  const camera = await prisma.camera.findUnique({
    where: { nvrId_channel: { nvrId, channel } },
  })
  if (!camera) throw new AppError(404, `No camera on channel ${channel}.`)
  if (!camera.isActive) throw new AppError(400, `Camera on channel ${channel} is inactive.`)

  // 4. Decrypt NVR password and generate RTSP URL
  const decryptedPassword = decrypt(nvr.password)
  const rtspUrl = generateRTSP(
    {
      username: nvr.username,
      password: decryptedPassword,
      ip: nvr.ip,
      rtspPort: nvr.rtspPort,
      type: nvr.type,
    },
    channel
  )

  // 5. Provision path in MediaMTX if not already there
  const pathName = `${nvrId}-ch${channel}`
  const existing = await getPath(pathName)
  if (!existing) {
    await provisionPath(pathName, rtspUrl)
  }

  // 6. Build WHEP URL and cache it for 5 minutes
  const whepUrl = `${env.MEDIAMTX_WEBRTC_URL}/${pathName}/whep`
  await setCache(cacheKey, whepUrl, 300)

  return { nvrId, channel, whepUrl }
}