import { Cam } from 'onvif'
import { DiscoveredCamera } from './hikvision.discoverer.js'
import logger from '../../utils/logger.js'

interface OnvifProfile {
  '$': { token: string }
  videoEncoderConfiguration?: {
    encoding?: string
  }
}

const extractChannel = (token: string): number | null => {
  // Common patterns:
  // 1. "Something_1_Something" (Original)
  // 2. "Channel1", "Profile1", "Camera1"
  // 3. "IPCamera_01"
  // 4. "MediaProfile_1"

  // Pattern 1: parts[1] (e.g., "Something_1_Something")
  const parts = token.split('_')
  if (parts.length >= 2) {
    const channel = parseInt(parts[1], 10)
    if (!isNaN(channel)) return channel
  }

  // Pattern 2: Extract numbers from "Channel1", "Profile1" etc.
  const match = token.match(/(?:Channel|Profile|Camera|Ch)(\d+)/i)
  if (match) {
    return parseInt(match[1], 10)
  }

  // Pattern 3: Just any number at the end
  const endMatch = token.match(/(\d+)$/)
  if (endMatch) {
    return parseInt(endMatch[1], 10)
  }

  return null
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
): Promise<DiscoveredCamera[] | null> => {
  const cam = await connectToNVR(ip, username, password, httpPort)

  let profiles: OnvifProfile[] = []
  
  try {
    profiles = await getProfiles(cam)
  } catch (err) {
    logger.error(`Failed to fetch ONVIF profiles for Hi-Focus NVR ${ip}: ${String(err)}`)
    // If profiles fail, we still consider the NVR reachable (since connectToNVR succeeded)
    // But we return null to indicate discovery was inconclusive, avoiding marking all cameras offline
    return null
  }

  const channelMap = new Map<number, DiscoveredCamera>()

  for (const profile of profiles) {
    const token = profile['$']?.token
    if (!token) continue

    const channel = extractChannel(token)
    if (channel === null) {
      logger.debug(`Skipping unknown ONVIF token format: ${token}`)
      continue
    }

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