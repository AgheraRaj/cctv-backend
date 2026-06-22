import axios from 'axios'
import { XMLParser, XMLBuilder } from 'fast-xml-parser'
import logger from '../../utils/logger.js'

export interface RecordingSegment {
  startTime: Date
  endTime: Date
  channel: number
}

const parser = new XMLParser({
  ignoreAttributes: false,
  parseTagValue: true,
})

const builder = new XMLBuilder({
  ignoreAttributes: false,
})

// Build the ISAPI search XML body
const buildSearchXML = (
  channel: number,
  startTime: Date,
  endTime: Date
): string => {
  const payload = {
    CMSearchDescription: {
      searchID: '1',
      trackList: {
        trackID: channel * 100 + 1, // channel 1 = track 101
      },
      timeSpanList: {
        timeSpan: {
          startTime: startTime.toISOString().split('.')[0] + 'Z',
          endTime: endTime.toISOString().split('.')[0] + 'Z',
        },
      },
      maxResults: 100,
      searchResultPostion: 0,
      metadataList: {
        metadataDescriptor: '//recordType.meta.std-cgi.com',
      },
    },
  }

  return builder.build(payload)
}

export const searchHikvisionRecordings = async (
  ip: string,
  httpPort: number,
  username: string,
  password: string,
  channel: number,
  startTime: Date,
  endTime: Date
): Promise<RecordingSegment[]> => {
  const url = `http://${ip}:${httpPort}/ISAPI/ContentMgmt/search`
  const xmlBody = buildSearchXML(channel, startTime, endTime)

  let responseData: string

  try {
    const response = await axios.post<string>(url, xmlBody, {
      auth: { username, password },
      headers: { 'Content-Type': 'application/xml' },
      responseType: 'text',
      timeout: 15000,
    })
    responseData = response.data
  } catch (err) {
    logger.error(`Hikvision recording search failed for ${ip} ch${channel}: ${String(err)}`)
    throw err
  }

  const parsed = parser.parse(responseData)
  const matchList = parsed?.CMSearchResult?.matchList?.searchMatchItem

  if (!matchList) return []

  // Normalize — single result comes as object, multiple as array
  const items = Array.isArray(matchList) ? matchList : [matchList]

  return items
    .map((item: { timeSpan?: { startTime?: string; endTime?: string } }) => {
      const start = item?.timeSpan?.startTime
      const end = item?.timeSpan?.endTime
      if (!start || !end) return null
      return {
        channel,
        startTime: new Date(start),
        endTime: new Date(end),
      }
    })
    .filter((s): s is RecordingSegment => s !== null)
}