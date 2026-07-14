// src/modules/detection/hifocus.recstatus.ts
//
// Real live per-channel camera connectivity, via the native HiFocus CGI
// queryRecStatus endpoint — NOT ONVIF GetProfiles, which only reflects
// static channel configuration and never changes when a camera physically
// disconnects.
//
// Confirmed via side-by-side capture (connected vs. disconnected):
//   - Connected:    recStatus="on"  for both main and sub stream entries,
//                   with real resolution/frameRate/quality/bitType/level.
//   - Disconnected: recStatus="abnormal", single entry, all those fields
//                   blank, empty recTypes.
//   - "off" was never observed in testing — treated as "online, recording
//     just administratively disabled" rather than a connectivity signal,
//     since it's a distinct enum value from "abnormal" and nothing in the
//     device's capability flags suggests otherwise. Revisit if a real case
//     shows this assumption is wrong.
//
// A channel is considered OFFLINE only if EVERY entry for that channel
// reports recStatus="abnormal". Any "on" or "off" entry counts as online.

import axios from 'axios'
import { XMLParser } from 'fast-xml-parser'
import logger from '../../utils/logger.js'
import { login, type HifocusSession } from '../playback/hifocus.reclog.js'

const parser = new XMLParser({ ignoreAttributes: false, parseTagValue: true })

const REQUEST_HEADERS = {
  'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
  Accept: 'application/xml, text/xml, */*; q=0.01',
  'X-Requested-With': 'XMLHttpRequest',
}

const buildQueryRecStatusXML = (token: string): string =>
  `<?xml version="1.0" encoding="utf-8" ?><request version="1.0" refresh="true" systemType="NVMS-9000" clientType="WEB"><token>${token}</token></request>`

const parseChannelFromGuid = (guid: string): number | null => {
  const match = guid.match(/\{([0-9a-fA-F]{8})-/)
  if (!match) return null
  const channel = parseInt(match[1], 16)
  return isNaN(channel) ? null : channel
}

interface RawRecStatusItem {
  chl?: { '@_id'?: string }
  recStatus?: string
}

export const parseRecStatusResponse = (xml: string): Map<number, boolean> => {
  const parsed = parser.parse(xml)
  const status = parsed?.response?.status
  const result = new Map<number, boolean>()

  if (status !== 'success') {
    logger.warn(`Hifocus queryRecStatus: non-success status "${status}"`)
    return result
  }

  const rawItems = parsed?.response?.content?.item
  const items: RawRecStatusItem[] = rawItems ? (Array.isArray(rawItems) ? rawItems : [rawItems]) : []

  // Group by channel: a channel is online unless EVERY entry for it is "abnormal"
  const anyNormalByChannel = new Map<number, boolean>()

  for (const item of items) {
    const guid = item.chl?.['@_id']
    if (!guid) continue
    const channel = parseChannelFromGuid(guid)
    if (channel === null) continue

    const isNormalEntry = item.recStatus !== 'abnormal'
    anyNormalByChannel.set(channel, (anyNormalByChannel.get(channel) ?? false) || isNormalEntry)
  }

  for (const [channel, isOnline] of anyNormalByChannel) {
    result.set(channel, isOnline)
  }

  return result
}

export const fetchRecStatus = async (
  ip: string,
  httpPort: number,
  session: HifocusSession
): Promise<string> => {
  const url = `http://${ip}:${httpPort}/queryRecStatus`
  const body = buildQueryRecStatusXML(session.token)

  const response = await axios.post<string>(url, body, {
    headers: { ...REQUEST_HEADERS, Cookie: `sessionId=${session.sessionId}` },
    responseType: 'text',
    timeout: 15000,
  })

  return response.data
}

/**
 * Returns real, live per-channel connectivity status for a HiFocus NVR.
 * Map key = channel number, value = true if the channel currently has a
 * usable video signal (recStatus !== "abnormal" on at least one stream).
 * Channels with no entry in the response at all are simply absent from
 * the returned map — callers should treat "no data" as "unknown", not
 * "offline", to avoid false negatives on a partial/flaky response.
 */
export const getHifocusChannelOnlineStatus = async (
  ip: string,
  httpPort: number,
  username: string,
  password: string
): Promise<Map<number, boolean>> => {
  const session = await login(ip, httpPort, username, password)
  const xml = await fetchRecStatus(ip, httpPort, session)
  return parseRecStatusResponse(xml)
}