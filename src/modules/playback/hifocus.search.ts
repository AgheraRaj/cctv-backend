import { Cam } from 'onvif'
import logger from '../../utils/logger.js'
import { RecordingSegment } from './hikvision.search.js'

// onvif typings are loose — define just what we need
interface OnvifRecordingJob {
  recordingToken?: string
}

interface OnvifRecordingEvent {
  startTime?: string | Date
  stopTime?: string | Date
  trackInformations?: Array<{
    trackToken?: string
  }>
}

const connectToNVR = (
  hostname: string,
  username: string,
  password: string,
  port: number
): Promise<Cam> => {
  return new Promise((resolve, reject) => {
    new Cam(
      { hostname, username, password, port },
      function (this: Cam, err) {
        if (err) reject(err)
        else resolve(this)
      }
    )
  })
}

// Promisify cam.findRecordings
const findRecordings = (cam: Cam): Promise<OnvifRecordingJob[]> => {
  return new Promise((resolve, reject) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(cam as any).findRecordings({}, (err: Error | null, result: OnvifRecordingJob[]) => {
      if (err) reject(err)
      else resolve(result ?? [])
    })
  })
}

// Promisify cam.getRecordingEvents for a specific token + time range
const getRecordingEvents = (
  cam: Cam,
  recordingToken: string,
  startTime: Date,
  endTime: Date
): Promise<OnvifRecordingEvent[]> => {
  return new Promise((resolve, reject) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(cam as any).getRecordingEvents(
      {
        recordingToken,
        startTime: startTime.toISOString(),
        endTime: endTime.toISOString(),
        maxResults: 100,
      },
      (err: Error | null, result: OnvifRecordingEvent[]) => {
        if (err) reject(err)
        else resolve(result ?? [])
      }
    )
  })
}

export const searchHifocusRecordings = async (
  ip: string,
  httpPort: number,
  username: string,
  password: string,
  channel: number,
  startTime: Date,
  endTime: Date
): Promise<RecordingSegment[]> => {
  const cam = await connectToNVR(ip, username, password, httpPort)

  let recordings: OnvifRecordingJob[]
  try {
    recordings = await findRecordings(cam)
  } catch (err) {
    logger.error(`Hifocus findRecordings failed for ${ip}: ${String(err)}`)
    return []
  }

  const segments: RecordingSegment[] = []

  for (const rec of recordings) {
    if (!rec.recordingToken) continue

    let events: OnvifRecordingEvent[]
    try {
      events = await getRecordingEvents(cam, rec.recordingToken, startTime, endTime)
    } catch (err) {
      logger.warn(`Hifocus getRecordingEvents failed token=${rec.recordingToken}: ${String(err)}`)
      continue
    }

    for (const event of events) {
      const start = event.startTime ? new Date(event.startTime) : null
      const end = event.stopTime ? new Date(event.stopTime) : null
      if (!start || !end) continue

      segments.push({ channel, startTime: start, endTime: end })
    }
  }

  return segments
}