// Format date to Hikvision's required format: 20260512t100000z
const toHikvisionTime = (date: Date): string =>
  date.toISOString()
    .replace(/[-:]/g, '')  // remove dashes and colons
    .replace('T', 't')     // lowercase T
    .split('.')[0] + 'z'   // remove milliseconds, add z

// Format date as YYYY-MM-DD (local time) — used by HiFocus playback
const toHifocusDate = (date: Date): string => {
  const y = date.getUTCFullYear()
  const m = String(date.getUTCMonth() + 1).padStart(2, '0')
  const d = String(date.getUTCDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

// Format time as HH:MM:SS (local time) — used by HiFocus playback
const toHifocusTime = (date: Date): string => {
  const h = String(date.getUTCHours()).padStart(2, '0')
  const m = String(date.getUTCMinutes()).padStart(2, '0')
  const s = String(date.getUTCSeconds()).padStart(2, '0')
  return `${h}:${m}:${s}`
}

interface PlaybackNVRData {
  username: string
  password: string  // already decrypted before passing here
  ip: string
  rtspPort: number
  type: 'HIKVISION' | 'HIFOCUS'
}

export const generatePlaybackRTSP = (
  nvr: PlaybackNVRData,
  channel: number,
  startTime: Date,
  endTime: Date
): string => {
  switch (nvr.type) {
    case 'HIKVISION': {
      // track formula: channel * 100 + 1 (ch1=101, ch2=201…)
      const track = channel * 100 + 1
      return (
        `rtsp://${nvr.username}:${nvr.password}@${nvr.ip}:${nvr.rtspPort}` +
        `/Streaming/tracks/${track}` +
        `?starttime=${toHikvisionTime(startTime)}&endtime=${toHikvisionTime(endTime)}`
      )
    }

    case 'HIFOCUS': {
      // HiFocus RTSP playback URL format — confirmed from the NVR's own
      // GetReplayUri SOAP response:
      //   rtsp://<ip>:554/chID=1&date=YYYY-MM-DD&time=HH:MM:SS&timelen=<sec>&streamType=main&linkType=tcp
      // The NVR does NOT accept starttime/endtime ISO params; it uses
      // date + time (UTC) of the start, plus timelen in seconds.
      const timelen = Math.round((endTime.getTime() - startTime.getTime()) / 1000)
      return (
        `rtsp://${nvr.username}:${nvr.password}@${nvr.ip}:${nvr.rtspPort}/` +
        `chID=${channel}` +
        `&date=${toHifocusDate(startTime)}` +
        `&time=${toHifocusTime(startTime)}` +
        `&timelen=${timelen}` +
        `&streamType=main` +
        `&linkType=tcp`
      )
    }

    default:
      throw new Error(`Unsupported NVR type: ${nvr.type}`)
  }
}