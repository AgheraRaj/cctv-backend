// src/modules/playback/download/strategies/hikvision.strategy.ts
//
// Hikvision native download via ISAPI ContentMgmt/download.
//
// WHY THIS IS FAST:
//   The NVR reads the recording file directly from its hard disk and sends the
//   raw bytes over HTTP. No RTSP re-streaming, no real-time playback — just a
//   plain file transfer at full LAN speed. Typically 20–50× faster than the
//   RTSP path for the same clip.
//
// DIGEST AUTH:
//   Hikvision's ISAPI requires HTTP Digest authentication (not Basic).
//   We implement the two-step handshake manually because Node's built-in fetch
//   doesn't do Digest automatically, and adding a dependency just for this is
//   overkill given the simplicity of the algorithm.
//
// FALLBACK:
//   If the NVR returns 404 (firmware doesn't support this endpoint) or any
//   non-2xx code, we throw StrategyUnavailableError and DownloadService will
//   fall back to the RTSP strategy automatically.

import http from 'http'
import crypto from 'crypto'
import type { NVR } from '@prisma/client'
import { StrategyUnavailableError, type DownloadContext, type DownloadStrategy } from '../types.js'
import logger from '../../../../utils/logger.js'

// ── Digest Auth helpers ───────────────────────────────────────────────────────

interface DigestChallenge {
  realm:  string
  nonce:  string
  qop?:   string
  opaque?: string
}

function parseDigestChallenge(wwwAuthenticate: string): DigestChallenge {
  const get = (key: string): string => {
    const m = wwwAuthenticate.match(new RegExp(`${key}="([^"]*)"`, 'i'))
    return m?.[1] ?? ''
  }
  return {
    realm:  get('realm'),
    nonce:  get('nonce'),
    qop:    get('qop') || undefined,
    opaque: get('opaque') || undefined,
  }
}

function buildDigestHeader(
  method: string,
  uri: string,
  username: string,
  password: string,
  challenge: DigestChallenge,
): string {
  const ha1 = crypto.createHash('md5')
    .update(`${username}:${challenge.realm}:${password}`)
    .digest('hex')
  const ha2 = crypto.createHash('md5')
    .update(`${method}:${uri}`)
    .digest('hex')

  let response: string
  let ncHex = ''
  let cnonce = ''

  if (challenge.qop === 'auth') {
    ncHex  = '00000001'
    cnonce = crypto.randomBytes(8).toString('hex')
    response = crypto.createHash('md5')
      .update(`${ha1}:${challenge.nonce}:${ncHex}:${cnonce}:auth:${ha2}`)
      .digest('hex')
  } else {
    response = crypto.createHash('md5')
      .update(`${ha1}:${challenge.nonce}:${ha2}`)
      .digest('hex')
  }

  let header =
    `Digest username="${username}", realm="${challenge.realm}", ` +
    `nonce="${challenge.nonce}", uri="${uri}", response="${response}"`

  if (challenge.qop === 'auth') {
    header += `, qop=auth, nc=${ncHex}, cnonce="${cnonce}"`
  }
  if (challenge.opaque) {
    header += `, opaque="${challenge.opaque}"`
  }

  return header
}

// ── Low-level HTTP helper (node http — no extra deps) ─────────────────────────

function httpGet(
  options: http.RequestOptions,
  onData:  (chunk: Buffer) => boolean,   // return false to abort
  onEnd:   () => void,
  onError: (err: Error) => void,
): http.ClientRequest {
  const req = http.request(options, (res) => {
    res.on('data', (chunk: Buffer) => {
      const ok = onData(chunk)
      if (!ok) req.destroy()
    })
    res.on('end', onEnd)
    res.on('error', onError)
  })
  req.on('error', onError)
  req.setTimeout(30_000, () => req.destroy(new Error('ISAPI request timeout')))
  req.end()
  return req
}

// ── ISAPI download path ───────────────────────────────────────────────────────
// /ISAPI/ContentMgmt/download streams the raw recording file from NVR disk.
// The NVR's RTSP playback server is completely bypassed.

function buildIsapiPath(channel: number, start: Date, end: Date): string {
  const fmt = (d: Date) =>
    d.toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z'
  return (
    `/ISAPI/ContentMgmt/download` +
    `?starttime=${fmt(start)}&endtime=${fmt(end)}&channel=${channel}`
  )
}

// ── Strategy ──────────────────────────────────────────────────────────────────

export class HikvisionDownloadStrategy implements DownloadStrategy {
  readonly name = 'hikvision-isapi'

  supports(nvr: NVR): boolean {
    return nvr.type === 'HIKVISION'
  }

  async download(ctx: DownloadContext): Promise<void> {
    const { nvr, password, channel, start, end, filename, req, res } = ctx
    const path = buildIsapiPath(channel, start, end)

    logger.info(`[${this.name}] starting — ch${channel} ${start.toISOString()}→${end.toISOString()} ${nvr.ip}`)

    // ── Step 1: unauthenticated probe to get the Digest challenge ────────────
    const challenge = await new Promise<DigestChallenge>((resolve, reject) => {
      const probeReq = http.request(
        {
          hostname: nvr.ip,
          port:     nvr.httpPort,
          path,
          method:   'GET',
        },
        (probeRes) => {
          probeRes.resume() // drain body
          if (probeRes.statusCode === 401) {
            const www = probeRes.headers['www-authenticate'] ?? ''
            if (!www.toLowerCase().includes('digest')) {
              // Some older firmware uses Basic auth
              resolve({ realm: '', nonce: '' })
              return
            }
            resolve(parseDigestChallenge(www))
          } else if (probeRes.statusCode === 404) {
            reject(new StrategyUnavailableError(
              `ISAPI ContentMgmt/download not supported on ${nvr.ip} (404) — falling back to RTSP`
            ))
          } else {
            reject(new StrategyUnavailableError(
              `ISAPI probe returned unexpected ${probeRes.statusCode} on ${nvr.ip}`
            ))
          }
        }
      )
      probeReq.setTimeout(10_000, () =>
        probeReq.destroy(new StrategyUnavailableError(`ISAPI probe timed out on ${nvr.ip}`))
      )
      probeReq.on('error', (err) => reject(
        new StrategyUnavailableError(`ISAPI probe network error on ${nvr.ip}: ${err.message}`)
      ))
      probeReq.end()
    })

    // ── Step 2: authenticated request ────────────────────────────────────────
    const authHeader = challenge.nonce
      ? buildDigestHeader('GET', path, nvr.username, password, challenge)
      : 'Basic ' + Buffer.from(`${nvr.username}:${password}`).toString('base64')

    await new Promise<void>((resolve, reject) => {
      let headersSet = false
      let nvrReq: http.ClientRequest

      const cleanup = () => { if (nvrReq) nvrReq.destroy() }
      req.on('close', cleanup) // client cancelled download

      nvrReq = http.request(
        {
          hostname: nvr.ip,
          port:     nvr.httpPort,
          path,
          method:   'GET',
          headers:  { Authorization: authHeader },
        },
        (nvrRes) => {
          if (nvrRes.statusCode === 401) {
            nvrRes.resume()
            return reject(new StrategyUnavailableError(
              `ISAPI auth failed on ${nvr.ip} — check NVR credentials`
            ))
          }
          if (!nvrRes.statusCode || nvrRes.statusCode < 200 || nvrRes.statusCode >= 300) {
            nvrRes.resume()
            return reject(new StrategyUnavailableError(
              `ISAPI returned ${nvrRes.statusCode} on ${nvr.ip} — falling back to RTSP`
            ))
          }

          // Set response headers only once, before any body bytes
          if (!headersSet) {
            headersSet = true
            res.setHeader('Content-Type',        'video/mp4')
            res.setHeader('Content-Disposition', `attachment; filename="${filename}"`)
            res.setHeader('Cache-Control',        'no-cache')

            // Forward Content-Length — enables browser download progress bar
            const cl = nvrRes.headers['content-length']
            if (cl) {
              res.setHeader('Content-Length', cl)
              logger.info(`[${this.name}] Content-Length: ${cl} bytes`)
            }
          }

          // Backpressure-aware pipe: respect res.write() return value so we
          // don't buffer the entire recording in Node's heap if the client
          // is slower than the NVR's disk read speed.
          nvrRes.on('data', (chunk: Buffer) => {
            const ok = res.write(chunk)
            if (!ok) {
              nvrRes.pause()
              res.once('drain', () => nvrRes.resume())
            }
          })

          nvrRes.on('end', () => {
            if (!res.writableEnded) res.end()
            logger.info(`[${this.name}] complete: ${filename}`)
            resolve()
          })

          nvrRes.on('error', (err) => {
            logger.error(`[${this.name}] NVR stream error: ${err.message}`)
            if (!res.writableEnded) res.end()
            reject(err)
          })
        }
      )

      nvrReq.setTimeout(30_000, () => {
        nvrReq.destroy(new Error(`ISAPI download timed out on ${nvr.ip}`))
      })

      nvrReq.on('error', (err) => {
        logger.error(`[${this.name}] request error: ${err.message}`)
        reject(new StrategyUnavailableError(
          `ISAPI network error on ${nvr.ip}: ${err.message}`
        ))
      })

      nvrReq.end()
    })
  }
}