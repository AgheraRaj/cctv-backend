import axios from 'axios'
import { XMLParser } from 'fast-xml-parser'

export interface DiscoveredCamera {
  channel: number
  isOnline: boolean
  protocol?: string
}

interface HikvisionChannel {
  id: number
  online: boolean
  sourceInputPortDescriptor?: {
    proxyProtocol?: string
  }
}

interface HikvisionResponse {
  InputProxyChannelStatusList?: {
    InputProxyChannelStatus?: HikvisionChannel | HikvisionChannel[]
  }
}

const parser = new XMLParser({
  ignoreAttributes: false,
  parseTagValue: true,
})

export const discoverHikvisionCameras = async (
  ip: string,
  httpPort: number,
  username: string,
  password: string
): Promise<DiscoveredCamera[]> => {
  const url = `http://${ip}:${httpPort}/ISAPI/ContentMgmt/InputProxy/channels/status`

  const response = await axios.get<string>(url, {
    auth: { username, password },
    responseType: 'text',
    timeout: 10000,  // 10 second timeout — don't wait forever
  })

  const parsed = parser.parse(response.data) as HikvisionResponse
  const list = parsed?.InputProxyChannelStatusList?.InputProxyChannelStatus

  if (!list) return []

  // Normalize to array — single camera returns object, multiple return array
  const channels = Array.isArray(list) ? list : [list]

  return channels.map((ch) => ({
    channel: Number(ch.id),
    isOnline: ch.online === true || String(ch.online) === 'true',
    protocol: ch.sourceInputPortDescriptor?.proxyProtocol ?? undefined,
  }))
}