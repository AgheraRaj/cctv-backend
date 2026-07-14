// src/modules/detection/hifocus.nodelist.ts
//
// Channel discovery via the native HiFocus CGI queryNodeList endpoint —
// replaces ONVIF GetProfiles entirely for HiFocus NVRs. GetProfiles pulled
// in a fragile third-party library (`onvif`) that repeatedly crashed on
// this device's edge-case response shapes (disconnected-channel profiles
// missing expected fields). queryNodeList gives us the same channel list
// with none of that fragility, using the same native CGI auth flow already
// built for queryChlRecLog and queryRecStatus.
//
// Request body reconstructed directly from the real web UI source (the
// `F(a)` function in the app's widget.base/CommonFunctions module), calling
// it with no filters — default nodeType="chls", no name/pageIndex/pageSize —
// which is exactly what the Live Display page uses to list all channels.

import axios from 'axios'
import { XMLParser } from 'fast-xml-parser'
import logger from '../../utils/logger.js'
import type { HifocusSession } from '../playback/hifocus.reclog.js'

const parser = new XMLParser({ ignoreAttributes: false, parseTagValue: true })

const REQUEST_HEADERS = {
  'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
  Accept: 'application/xml, text/xml, */*; q=0.01',
  'X-Requested-With': 'XMLHttpRequest',
}

const buildQueryNodeListXML = (token: string): string =>
  `<?xml version="1.0" encoding="utf-8" ?><request version="1.0" systemType="NVMS-9000" clientType="WEB">` +
  `<token>${token}</token>` +
  `<types><nodeType><enum>chls</enum><enum>sensors</enum><enum>alarmOuts</enum><enum>voices</enum></nodeType></types>` +
  `<nodeType type="nodeType">chls</nodeType>` +
  `<condition></condition>` +
  `<requireField><name/><chlIndex/><chlType/></requireField>` +
  `</request>`

export const fetchNodeList = async (
  ip: string,
  httpPort: number,
  session: HifocusSession
): Promise<string> => {
  const url = `http://${ip}:${httpPort}/queryNodeList`
  const body = buildQueryNodeListXML(session.token)

  const response = await axios.post<string>(url, body, {
    headers: { ...REQUEST_HEADERS, Cookie: `sessionId=${session.sessionId}` },
    responseType: 'text',
    timeout: 15000,
  })

  return response.data
}

export interface HifocusChannelInfo {
  channel: number
  name: string
}

const parseChannelFromGuid = (guid: string): number | null => {
  const match = guid.match(/\{([0-9a-fA-F]{8})-/)
  if (!match) return null
  const channel = parseInt(match[1], 16)
  return isNaN(channel) ? null : channel
}

interface RawNodeListItem {
  '@_id'?: string
  name?: string
}

export const parseNodeListResponse = (xml: string): HifocusChannelInfo[] => {
  const parsed = parser.parse(xml)
  const status = parsed?.response?.status
  if (status !== 'success') {
    logger.warn(`Hifocus queryNodeList: non-success status "${status}"`)
    return []
  }

  const rawItems = parsed?.response?.content?.item
  const items: RawNodeListItem[] = rawItems ? (Array.isArray(rawItems) ? rawItems : [rawItems]) : []

  const channels: HifocusChannelInfo[] = []
  for (const item of items) {
    const guid = item['@_id']
    if (!guid) continue
    const channel = parseChannelFromGuid(guid)
    if (channel === null) continue
    channels.push({ channel, name: item.name ?? `Channel ${channel}` })
  }

  return channels
}