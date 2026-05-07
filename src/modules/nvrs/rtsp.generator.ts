interface NVRData {
  username: string;
  password: string; // already decrypted before passing here
  ip: string;
  rtspPort: number;
  type: "HIKVISION" | "HIFOCUS";
}

export const generateRTSP = (nvr: NVRData, channel: number): string => {
  const pad = channel.toString().padStart(2, "0");

  switch (nvr.type) {
    case "HIKVISION":
    case "HIKVISION":
      // channel 2 sub-stream = 202, not 0202
      return `rtsp://${nvr.username}:${nvr.password}@${nvr.ip}:${nvr.rtspPort}/Streaming/Channels/${channel}02`;

    case "HIFOCUS":
      // Hifocus format: /ch{channel}/0
      return `rtsp://${nvr.username}:${nvr.password}@${nvr.ip}:${nvr.rtspPort}/ch${pad}/0`;

    default:
      throw new Error(`Unsupported NVR type: ${nvr.type}`);
  }
};
