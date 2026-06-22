interface PlaybackNVRData {
  username: string
  password: string  // already decrypted before passing here
  ip: string
  rtspPort: number
  type: 'HIKVISION' | 'HIFOCUS'
}

// Format date to Hikvision's required format: 20260512t100000z
const toHikvisionTime = (date: Date): string => {
  return date.toISOString()
    .replace(/[-:]/g, '')   // remove dashes and colons
    .replace('T', 't')      // lowercase T
    .split('.')[0] + 'z'    // remove milliseconds, add z
}

// Format date to ONVIF standard: 2026-05-12T10:00:00Z
const toOnvifTime = (date: Date): string => {
  return date.toISOString().split('.')[0] + 'Z'
}

export const generatePlaybackRTSP = (
  nvr: PlaybackNVRData,
  channel: number,
  startTime: Date,
  endTime: Date
): string => {
  switch (nvr.type) {
    case 'HIKVISION':
      // track format: channel * 100 + 1 for main stream
      // channel 1 = track 101, channel 2 = track 201
      const track = channel * 100 + 1
      return `rtsp://${nvr.username}:${nvr.password}@${nvr.ip}:${nvr.rtspPort}/Streaming/tracks/${track}?starttime=${toHikvisionTime(startTime)}&endtime=${toHikvisionTime(endTime)}`

    case 'HIFOCUS':
      // ONVIF replay format
      return `rtsp://${nvr.username}:${nvr.password}@${nvr.ip}:${nvr.rtspPort}/?chID=${channel}&streamType=main&starttime=${toOnvifTime(startTime)}&endtime=${toOnvifTime(endTime)}`

    default:
      throw new Error(`Unsupported NVR type: ${nvr.type}`)
  }
}