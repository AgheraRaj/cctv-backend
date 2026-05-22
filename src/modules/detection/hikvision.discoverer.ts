import axios, { AxiosError } from 'axios'
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

  let responseData: string

  try {
    const response = await axios.get<string>(url, {
      auth: { username, password },
      responseType: 'text',
      timeout: 10000,
    })
    responseData = response.data
  } catch (err) {
    const axiosErr = err as AxiosError

    // 404 means the NVR has no IP cameras added yet — it's reachable, just empty.
    // Any other HTTP error (401, 500) or network error is a real failure — rethrow
    // so the caller marks the NVR as offline.
    if (axiosErr.response?.status === 404) {
      return []
    }

    throw err
  }

  const parsed = parser.parse(responseData) as HikvisionResponse
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