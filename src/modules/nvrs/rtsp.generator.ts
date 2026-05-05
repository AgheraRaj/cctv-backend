interface NVRData {
  username: string
  password: string  // already decrypted before passing here
  ip: string
  rtspPort: number
  type: 'HIKVISION' | 'HIFOCUS'
}

export const generateRTSP = (nvr: NVRData, channel: number): string => {
  const pad = channel.toString()

  switch (nvr.type) {
    case 'HIKVISION':
      // Hikvision format: /Streaming/Channels/{channel}01
      return `rtsp://${nvr.username}:${nvr.password}@${nvr.ip}:${nvr.rtspPort}/Streaming/Channels/${pad}01`

    case 'HIFOCUS':
      // Hifocus format: /ch{channel}/0
      return `rtsp://${nvr.username}:${nvr.password}@${nvr.ip}:${nvr.rtspPort}/ch${pad}/0`

    default:
      throw new Error(`Unsupported NVR type: ${nvr.type}`)
  }
}