// src/modules/detection/nvr.heartbeat.ts
//
// Tier 1 health check: "is the NVR host itself reachable" — deliberately
// dumb and cheap. A raw TCP connect to the HTTP/ONVIF port, no auth, no
// SOAP, no XML parsing. This is what should decide NVR online/offline —
// never a full ONVIF profile/capability bootstrap, which can fail for
// reasons that have nothing to do with the device being down (e.g. a
// channel re-enumerating after a camera disconnect).

import net from 'net'

export const isNvrHostReachable = (
  ip: string,
  port: number,
  timeoutMs: number = 3000
): Promise<boolean> => {
  return new Promise((resolve) => {
    const socket = new net.Socket()
    let settled = false

    const finish = (result: boolean) => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve(result)
    }

    socket.setTimeout(timeoutMs)
    socket.once('connect', () => finish(true))
    socket.once('timeout', () => finish(false))
    socket.once('error', () => finish(false))

    socket.connect(port, ip)
  })
}