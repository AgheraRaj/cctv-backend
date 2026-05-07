import { Cam } from 'onvif'
import { DiscoveredCamera } from './hikvision.discoverer.js'

interface OnvifProfile {
  '$': { token: string }
  videoEncoderConfiguration?: {
    encoding?: string
  }
}

const extractChannel = (token: string): number | null => {
  const parts = token.split('_')
  if (parts.length < 3) return null
  const channel = parseInt(parts[1], 10)
  return isNaN(channel) ? null : channel
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

const getProfiles = (cam: Cam): Promise<OnvifProfile[]> => {
  return new Promise((resolve, reject) => {
    cam.getProfiles((err, profiles) => {
      if (err) reject(err)
      else resolve(profiles as OnvifProfile[])
    })
  })
}

export const discoverHifocusCameras = async (
  ip: string,
  httpPort: number,
  username: string,
  password: string
): Promise<DiscoveredCamera[]> => {
  const cam = await connectToNVR(ip, username, password, httpPort)
  const profiles = await getProfiles(cam)

  const channelMap = new Map<number, DiscoveredCamera>()

  for (const profile of profiles) {
    const token = profile['$']?.token
    if (!token) continue

    const channel = extractChannel(token)
    if (channel === null) continue

    if (!channelMap.has(channel)) {
      channelMap.set(channel, {
        channel,
        isOnline: true,
        protocol: 'ONVIF',
      })
    }
  }

  return Array.from(channelMap.values())
}