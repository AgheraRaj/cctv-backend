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

  // Wait for MediaMTX to actually finish connecting to the NVR and produce
  // the first HLS segment BEFORE handing the URL to the frontend. This
  // eliminates the race condition that causes intermittent 500s on index.m3u8.
  const ready = await waitForPathReady(pathName)
  if (!ready) {
    logger.warn(`Playback path "${pathName}" not ready after timeout — NVR may be slow or unreachable`)
    // Don't throw — return the URL anyway. The frontend retry logic will
    // handle the remaining cases (e.g. very slow NVR disk seeks).
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

  await provisionPath(pathName, rtspUrl, { sourceOnDemandCloseAfter: '120s' })

  // Same readiness wait as resolvePlayback — seeks are just as susceptible
  // to this race condition since they also provision a brand new path.
  const ready = await waitForPathReady(pathName)
  if (!ready) {
    logger.warn(`Seek path "${pathName}" not ready after timeout`)
  }

  // Only remove the old path AFTER the new one is confirmed ready — avoids
  // a gap where neither stream is available.
  removePath(oldPathName).catch(() => {})

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