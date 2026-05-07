interface NVRData {
  username: string;
  password: string; // already decrypted before passing here
  ip: string;
  rtspPort: number;
  type: "HIKVISION" | "HIFOCUS";
}

export const generateRTSP = (nvr: NVRData, channel: number): string => {
  switch (nvr.type) {
    case "HIKVISION":
      // channel 2 sub-stream = 202, not 0202
      return `rtsp://${nvr.username}:${nvr.password}@${nvr.ip}:${nvr.rtspPort}/Streaming/Channels/${channel}02`;

    case "HIFOCUS":
      // User confirmed this format works in VLC: /chID=1&streamType=main
      return `rtsp://${nvr.username}:${nvr.password}@${nvr.ip}:${nvr.rtspPort}/chID=${channel}&streamType=sub`;

    default:
      throw new Error(`Unsupported NVR type: ${nvr.type}`);
  }
};
