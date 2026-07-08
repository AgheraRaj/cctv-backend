import { createRequire } from 'module'
import { Cam } from 'onvif'
import { env } from '../../config/env.js'
import { withRetry, withTimeout, mapWithConcurrency } from '../../utils/retry.js'
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
// Retried on failure — a transient SOAP/network fault here shouldn't abort
// the whole search when a retry is cheap and safe (read-only, idempotent).

const getRecordingSummary = (cam: Cam): Promise<{
  dataFrom: Date
  dataUntil: Date
  numberRecordings: number
} | null> =>
  withRetry(
    () =>
      new Promise<{ dataFrom: Date; dataUntil: Date; numberRecordings: number }>((resolve, reject) => {
        ;(cam as any).getRecordingSummary((err: Error | null, result: any) => {
          if (err) reject(err)
          else resolve(result)
        })
      }),
    { retries: env.PLAYBACK_SEARCH_RETRIES, baseDelayMs: 500, label: 'Hifocus GetRecordingSummary' }
  ).catch((err) => {
    logger.debug(`Hifocus GetRecordingSummary failed after retries: ${String(err)}`)
    return null
  })

// ── GetRecordings ─────────────────────────────────────────────────────────────

const getRecordings = (cam: Cam): Promise<any[]> =>
  withRetry(
    () =>
      new Promise<any[]>((resolve, reject) => {
        ;(cam as any).getRecordings((err: Error | null, items: any) => {
          if (err) reject(err)
          else resolve(items ? (Array.isArray(items) ? items : [items]) : [])
        })
      }),
    { retries: env.PLAYBACK_SEARCH_RETRIES, baseDelayMs: 500, label: 'Hifocus GetRecordings' }
  )

// ── GetRecordingInformation (fixed) ──────────────────────────────────────────
// onvif 0.8.1 bug: getRecordingInformation() reads the wrong response key.
// Fixed by calling cam._request() directly with the correct response key.
//
// Wrapped in an explicit timeout (the underlying onvif lib's _request has no
// visible timeout of its own) so one unresponsive token can't hang the whole
// search indefinitely (Phase 5).

const getRecordingInformation = (
  cam: Cam,
  recordingToken: string
): Promise<{ earliestRecording?: Date; latestRecording?: Date } | null> => {
  const camAny = cam as any

  const request = new Promise<{ earliestRecording?: Date; latestRecording?: Date } | null>((resolve) => {
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

  return withTimeout(request, env.PLAYBACK_RECORDING_INFO_TIMEOUT_MS, `GetRecordingInformation(${recordingToken})`).catch(
    (err) => {
      logger.warn(`Hifocus GetRecordingInformation timed out for "${recordingToken}": ${String(err)}`)
      return null
    }
  )
}

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
  let summaryFrom: Date | null = null
  let summaryUntil: Date | null = null

  if (summary) {
    summaryFrom = summary.dataFrom instanceof Date ? summary.dataFrom : new Date(summary.dataFrom)
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

  // Parallelized per-token lookups (bounded concurrency) — this was the
  // single biggest HiFocus search latency win identified in Phase 5/9:
  // previously strictly sequential, now up to
  // env.PLAYBACK_SEARCH_MAX_CONCURRENCY in flight at once.
  const tokens = allRecordings
    .map((rec) => (rec?.recordingToken ?? rec?.$?.token) as string | undefined)
    .filter((t): t is string => Boolean(t))

  const infos = await mapWithConcurrency(tokens, env.PLAYBACK_SEARCH_MAX_CONCURRENCY, (token) =>
    getRecordingInformation(cam, token).then((info) => ({ token, info }))
  )

  const segments: RecordingSegment[] = []

  for (const { token, info } of infos) {
    let recStart: Date | null = null
    let recEnd: Date | null = null

    if (info?.earliestRecording) {
      recStart = info.earliestRecording instanceof Date ? info.earliestRecording : new Date(info.earliestRecording)
    }
    if (info?.latestRecording) {
      recEnd = info.latestRecording instanceof Date ? info.latestRecording : new Date(info.latestRecording)
    }

    // Fallback to summary range if GetRecordingInformation returns no dates
    if (!recStart || isNaN(recStart.getTime())) recStart = summaryFrom
    if (!recEnd || isNaN(recEnd.getTime())) recEnd = summaryUntil

    if (!recStart || !recEnd) {
      logger.warn(`Hifocus ${ip}: no time range for token "${token}" — skipping`)
      continue
    }

    if (recEnd < startTime || recStart > endTime) continue

    const clippedStart = recStart < startTime ? startTime : recStart
    const clippedEnd = recEnd > endTime ? endTime : recEnd

    logger.info(`Hifocus ${ip}: matched token "${token}" → ${clippedStart.toISOString()}→${clippedEnd.toISOString()}`)
    segments.push({ channel, startTime: clippedStart, endTime: clippedEnd })
  }

  logger.info(`Hifocus ${ip} ch${channel}: returning ${segments.length} segment(s)`)
  return segments
}