import prisma from '../../config/db.js'
import { AppError } from '../../middleware/errorHandler.js'
import { decrypt } from '../../utils/crypto.js'
import { env } from '../../config/env.js'
import { generatePlaybackRTSP } from './playback.generator.js'
import { getHifocusReplayInfo, buildHifocusRtspUrl } from './hifocus.replay.js'
import { provisionPath, removePath, waitForPathReady } from '../streams/mediamtx.client.js'
import { searchHikvisionRecordings } from './hikvision.search.js'
import { searchHifocusRecordings } from './hifocus.search.js'
import type { RecordingSegment } from './hikvision.search.js'
import logger from '../../utils/logger.js'

// ─── Resolve Playback ────────────────────────────────────────────────────────

export interface PlaybackResult {
  whepUrl: string
  hlsUrl: string
  pathName: string
  durationSeconds: number
  tzOffsetMs?: number
}

export const resolvePlayback = async (
  nvrId: string,
  channel: number,
  startTime: Date,
  endTime: Date
): Promise<PlaybackResult> => {
  const nvr = await prisma.nVR.findUnique({ where: { id: nvrId } })
  if (!nvr) throw new AppError(404, `NVR ${nvrId} not found.`)

  const camera = await prisma.camera.findUnique({
    where: { nvrId_channel: { nvrId, channel } },
  })
  if (!camera) throw new AppError(404, `No camera on channel ${channel}.`)
  if (!camera.isActive) throw new AppError(400, `Camera on channel ${channel} is inactive.`)

  const decryptedPassword = decrypt(nvr.password)

  let rtspUrl: string
  let tzOffsetMs: number | undefined

  if (nvr.type === 'HIKVISION') {
    rtspUrl = generatePlaybackRTSP(
      { username: nvr.username, password: decryptedPassword, ip: nvr.ip, rtspPort: nvr.rtspPort, type: nvr.type },
      channel, startTime, endTime
    )
  } else if (nvr.type === 'HIFOCUS') {
    const info = await getHifocusReplayInfo(
      nvr.ip, nvr.httpPort, nvr.rtspPort,
      nvr.username, decryptedPassword,
      channel, startTime, endTime
    )
    rtspUrl    = info.rtspUrl
    tzOffsetMs = info.tzOffsetMs
  } else {
    throw new AppError(400, `Unsupported NVR type: ${nvr.type}`)
  }

  const timestamp = Date.now()
  const pathName  = `${nvrId}-ch${channel}-pb-${timestamp}`

  await provisionPath(pathName, rtspUrl, { sourceOnDemandCloseAfter: '120s' })

  const ready = await waitForPathReady(pathName)
  if (!ready) {
    logger.warn(`Playback path "${pathName}" not ready after timeout — NVR may be slow or unreachable`)
  }

  const whepUrl = `${env.MEDIAMTX_WEBRTC_URL}/${pathName}/whep`
  const hlsUrl  = `${env.MEDIAMTX_HLS_URL}/${pathName}/index.m3u8`
  const durationSeconds = Math.round((endTime.getTime() - startTime.getTime()) / 1000)

  return { whepUrl, hlsUrl, pathName, durationSeconds, tzOffsetMs }
}

// ─── Seek Playback (re-resolve to new time position) ─────────────────────────

export const seekPlayback = async (
  nvrId: string,
  channel: number,
  startTime: Date,
  endTime: Date,
  oldPathName: string,
  tzOffsetMs: number
): Promise<PlaybackResult> => {
  const nvr = await prisma.nVR.findUnique({ where: { id: nvrId } })
  if (!nvr) throw new AppError(404, `NVR ${nvrId} not found.`)

  const decryptedPassword = decrypt(nvr.password)

  let rtspUrl: string

  if (nvr.type === 'HIKVISION') {
    rtspUrl = generatePlaybackRTSP(
      { username: nvr.username, password: decryptedPassword, ip: nvr.ip, rtspPort: nvr.rtspPort, type: nvr.type },
      channel, startTime, endTime
    )
  } else if (nvr.type === 'HIFOCUS') {
    rtspUrl = buildHifocusRtspUrl(
      nvr.ip, nvr.rtspPort, nvr.username, decryptedPassword,
      channel, startTime, endTime, tzOffsetMs
    )
  } else {
    throw new AppError(400, `Unsupported NVR type: ${nvr.type}`)
  }

  const timestamp = Date.now()
  const pathName  = `${nvrId}-ch${channel}-pb-${timestamp}`

  // Remove the old path FIRST — the NVR only allows one RTSP playback
  // connection per channel at a time. If the old session is still open
  // when waitForPathReady fires its warmup fetch, the NVR rejects the
  // new connection with 302 ("not enough bandwidth").
  removePath(oldPathName).catch(() => {})

  // Give the NVR 300ms to fully tear down the old RTSP session before
  // the new one tries to connect. Without this gap, some NVRs still
  // reject the second connection even after the first is removed.
  await new Promise(resolve => setTimeout(resolve, 300))

  await provisionPath(pathName, rtspUrl, { sourceOnDemandCloseAfter: '120s' })

  const ready = await waitForPathReady(pathName)
  if (!ready) {
    logger.warn(`Seek path "${pathName}" not ready after timeout`)
  }

  const whepUrl = `${env.MEDIAMTX_WEBRTC_URL}/${pathName}/whep`
  const hlsUrl  = `${env.MEDIAMTX_HLS_URL}/${pathName}/index.m3u8`
  const durationSeconds = Math.round((endTime.getTime() - startTime.getTime()) / 1000)

  return { whepUrl, hlsUrl, pathName, durationSeconds, tzOffsetMs }
}

// ─── Stop Playback ───────────────────────────────────────────────────────────

export const stopPlayback = async (pathName: string): Promise<void> => {
  if (!pathName.includes('-pb-')) throw new AppError(400, 'Invalid playback path name.')
  await removePath(pathName)
}

// ─── Search Recordings ───────────────────────────────────────────────────────

export const getRecordings = async (
  nvrId: string,
  channel: number,
  date: string
): Promise<RecordingSegment[]> => {
  const nvr = await prisma.nVR.findUnique({ where: { id: nvrId } })
  if (!nvr) throw new AppError(404, `NVR ${nvrId} not found.`)

  const startTime = new Date(`${date}T00:00:00Z`)
  const endTime   = new Date(`${date}T23:59:59Z`)

  if (isNaN(startTime.getTime())) throw new AppError(400, 'Invalid date format. Expected YYYY-MM-DD.')

  const decryptedPassword = decrypt(nvr.password)

  if (nvr.type === 'HIKVISION') {
    return searchHikvisionRecordings(nvr.ip, nvr.httpPort, nvr.username, decryptedPassword, channel, startTime, endTime)
  }
  if (nvr.type === 'HIFOCUS') {
    return searchHifocusRecordings(nvr.ip, nvr.httpPort, nvr.username, decryptedPassword, channel, startTime, endTime)
  }

  throw new AppError(400, `Unsupported NVR type: ${nvr.type}`)
}