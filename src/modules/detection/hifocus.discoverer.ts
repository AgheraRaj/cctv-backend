// src/modules/detection/hifocus.discoverer.ts
//
// Channel discovery for HiFocus NVRs — fully native CGI now, no ONVIF.
// Previously used the `onvif` npm package (GetProfiles for channel list,
// hardcoded isOnline:true for every profile). Dropped entirely after
// hitting three separate crashes in that library's response parsing on
// this device's edge-case shapes (disconnected-channel profiles missing
// fields the library assumes always exist). queryNodeList + queryRecStatus
// give us the same information — channel list and real live status — with
// none of that fragility, sharing one login session per discovery run.

import { DiscoveredCamera } from './hikvision.discoverer.js'
import { login } from '../playback/hifocus.reclog.js'
import { fetchNodeList, parseNodeListResponse } from './hifocus.nodelist.js'
import { fetchRecStatus, parseRecStatusResponse } from './hifocus.recstatus.js'


export const discoverHifocusCameras = async (
  ip: string,
  httpPort: number,
  username: string,
  password: string
): Promise<DiscoveredCamera[] | null> => {
  const session = await login(ip, httpPort, username, password)

  const channels = parseNodeListResponse(await fetchNodeList(ip, httpPort, session))
  if (channels.length === 0) {
    console.warn(`Hifocus queryNodeList returned no channels for NVR ${ip}`)
    return null
  }

  // Live per-channel status — if this specific call fails, we still know
  // the channel list from queryNodeList above, so fall back to `true`
  // (online) per channel rather than losing discovery entirely over a
  // status-check hiccup.
  let liveStatus = new Map<number, boolean>()
  try {
    liveStatus = parseRecStatusResponse(await fetchRecStatus(ip, httpPort, session))
  } catch (err) {
    console.warn(`Failed to fetch live channel status for Hi-Focus NVR ${ip}, defaulting all discovered channels to online: ${err instanceof Error ? err.message : String(err)}`)
  }

  return channels.map(({ channel }) => ({
    channel,
    isOnline: liveStatus.get(channel) ?? true,
    protocol: 'HIFOCUS_CGI',
  }))
}