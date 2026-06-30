import { createRequire } from 'module'
import { Cam } from 'onvif'
import logger from '../../utils/logger.js'
import type { RecordingSegment } from './hikvision.search.js'

const require = createRequire(import.meta.url)
const linerase: (data: any) => any = require('onvif/lib/utils').linerase

// ── Connect ───────────────────────────────────────────────────────────────────

const connectToNVR = (
  hostname: string,
  username: string,
  password: string,
  port: number
): Promise<Cam> =>
  new Promise((resolve) => {
    // Never reject — the GetSystemDateAndTime / timeShift error is non-fatal on
    // many HiFocus NVRs. The cam object is fully usable even when this fails.
    new Cam({ hostname, username, password, port }, function (this: Cam, err) {
      if (err) {
        logger.warn(`Hifocus ${hostname}: connect warning (non-fatal): ${String(err)}`)
      }
      resolve(this)
    })
  })

// ── GetRecordingSummary ───────────────────────────────────────────────────────

const getRecordingSummary = (cam: Cam): Promise<{
  dataFrom: Date
  dataUntil: Date
  numberRecordings: number
} | null> =>
  new Promise((resolve) => {
    ;(cam as any).getRecordingSummary((err: Error | null, result: any) => {
      if (err) {
        logger.debug(`Hifocus GetRecordingSummary failed: ${String(err)}`)
        resolve(null)
      } else {
        resolve(result)
      }
    })
  })

// ── GetRecordings ─────────────────────────────────────────────────────────────

const getRecordings = (cam: Cam): Promise<any[]> =>
  new Promise((resolve, reject) => {
    ;(cam as any).getRecordings((err: Error | null, items: any) => {
      if (err) reject(err)
      else resolve(items ? (Array.isArray(items) ? items : [items]) : [])
    })
  })

// ── GetRecordingInformation (fixed) ──────────────────────────────────────────
// onvif 0.8.1 bug: getRecordingInformation() reads the wrong response key.
// Fixed by calling cam._request() directly with the correct response key.

const getRecordingInformation = (
  cam: Cam,
  recordingToken: string
): Promise<{ earliestRecording?: Date; latestRecording?: Date } | null> =>
  new Promise((resolve) => {
    const camAny = cam as any

    camAny._request(
      {
        service: 'search',
        body:
          camAny._envelopeHeader() +
          '<GetRecordingInformation xmlns="http://www.onvif.org/ver10/search/wsdl">' +
          '<RecordingToken>' + recordingToken + '</RecordingToken>' +
          '</GetRecordingInformation>' +
          camAny._envelopeFooter(),
      },
      (err: Error | null, data: any) => {
        if (err) {
          logger.warn(`Hifocus GetRecordingInformation failed for "${recordingToken}": ${String(err)}`)
          resolve(null)
          return
        }
        try {
          const info = linerase(data)?.getRecordingInformationResponse?.recordingInformation
          resolve(info ?? null)
        } catch (parseErr) {
          logger.warn(`Hifocus GetRecordingInformation parse error for "${recordingToken}": ${String(parseErr)}`)
          resolve(null)
        }
      }
    )
  })

// ── Main export ───────────────────────────────────────────────────────────────

export const searchHifocusRecordings = async (
  ip: string,
  httpPort: number,
  username: string,
  password: string,
  channel: number,
  startTime: Date,
  endTime: Date
): Promise<RecordingSegment[]> => {
  logger.info(
    `Hifocus search: http://${ip}:${httpPort} ch${channel} ` +
      `range=${startTime.toISOString()}→${endTime.toISOString()}`
  )

  let cam: Cam
  try {
    cam = await connectToNVR(ip, username, password, httpPort)
  } catch (err) {
    logger.error(`Hifocus: cannot connect to ${ip}:${httpPort}: ${String(err)}`)
    throw new Error(`Cannot connect to HiFocus NVR at ${ip}: ${String(err)}`)
  }

  // GetRecordingSummary — used as fallback time range
  const summary = await getRecordingSummary(cam)
  let summaryFrom:  Date | null = null
  let summaryUntil: Date | null = null

  if (summary) {
    summaryFrom  = summary.dataFrom  instanceof Date ? summary.dataFrom  : new Date(summary.dataFrom)
    summaryUntil = summary.dataUntil instanceof Date ? summary.dataUntil : new Date(summary.dataUntil)
    logger.info(
      `Hifocus ${ip}: ${summary.numberRecordings} recording(s), ` +
        `${summaryFrom.toISOString()} → ${summaryUntil.toISOString()}`
    )
    if (endTime < summaryFrom || startTime > summaryUntil) {
      logger.info(`Hifocus ${ip}: query range is outside available recordings`)
      return []
    }
  }

  let allRecordings: any[]
  try {
    allRecordings = await getRecordings(cam)
  } catch (err) {
    logger.error(`Hifocus GetRecordings failed for ${ip}: ${String(err)}`)
    throw new Error(`HiFocus GetRecordings failed: ${String(err)}`)
  }

  logger.info(`Hifocus ${ip}: ${allRecordings.length} total recording token(s)`)
  if (allRecordings.length === 0) return []

  const segments: RecordingSegment[] = []

  for (const rec of allRecordings) {
    const token: string = rec?.recordingToken ?? rec?.$?.token
    if (!token) continue

    const info = await getRecordingInformation(cam, token)

    let recStart: Date | null = null
    let recEnd:   Date | null = null

    if (info?.earliestRecording) {
      recStart = info.earliestRecording instanceof Date ? info.earliestRecording : new Date(info.earliestRecording)
    }
    if (info?.latestRecording) {
      recEnd = info.latestRecording instanceof Date ? info.latestRecording : new Date(info.latestRecording)
    }

    // Fallback to summary range if GetRecordingInformation returns no dates
    if (!recStart || isNaN(recStart.getTime())) recStart = summaryFrom
    if (!recEnd   || isNaN(recEnd.getTime()))   recEnd   = summaryUntil

    if (!recStart || !recEnd) {
      logger.warn(`Hifocus ${ip}: no time range for token "${token}" — skipping`)
      continue
    }

    if (recEnd < startTime || recStart > endTime) continue

    const clippedStart = recStart < startTime ? startTime : recStart
    const clippedEnd   = recEnd   > endTime   ? endTime   : recEnd

    logger.info(`Hifocus ${ip}: matched token "${token}" → ${clippedStart.toISOString()}→${clippedEnd.toISOString()}`)
    segments.push({ channel, startTime: clippedStart, endTime: clippedEnd })
  }

  logger.info(`Hifocus ${ip} ch${channel}: returning ${segments.length} segment(s)`)
  return segments
}