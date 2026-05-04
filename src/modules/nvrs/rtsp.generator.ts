interface NVRData {
  username: string
  password: string  // already decrypted before passing here
  ip: string
  rtspPort: number
  type: 'HIKVISION' | 'HIFOCUS'
}

export const generateRTSP = (nvr: NVRData, channel: number): string => {
  const pad = channel.toString().padStart(2, '0')

  switch (nvr.type) {
    case 'HIKVISION':
      // Hikvision format: /Streaming/Channels/{channel}01
      // channel 1 = 0101, channel 2 = 0201
      return `rtsp://${nvr.username}:${nvr.password}@${nvr.ip}:${nvr.rtspPort}/Streaming/Channels/${pad}01`

    case 'HIFOCUS':
      // Hifocus format: /ch{channel}/0
      return `rtsp://${nvr.username}:${nvr.password}@${nvr.ip}:${nvr.rtspPort}/ch${pad}/0`

    default:
      throw new Error(`Unsupported NVR type: ${nvr.type}`)
  }
}