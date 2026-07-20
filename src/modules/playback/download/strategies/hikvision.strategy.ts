// src/modules/playback/download/strategies/hikvision.strategy.ts
//
// Hikvision native download via ISAPI ContentMgmt/download.
//
// REAL MECHANISM (per Hikvision ISAPI spec):
//   1. POST /ISAPI/ContentMgmt/search  → get a playbackURI for the segment
//      (embeds the NVR's internal file `name` + `size` — there is no way to
//      download by time range alone).
//   2. POST /ISAPI/ContentMgmt/download with
//      <downloadRequest><playbackURI>...</playbackURI></downloadRequest>
//      → NVR reads the file straight off disk and streams raw bytes over HTTP.
//
// DIGEST AUTH: same manual two-step handshake as before — Node's fetch
// doesn't do Digest, and it's cheap enough to hand-roll for one endpoint.
//
// FALLBACK: no matching segment, 404, or any non-2xx → StrategyUnavailableError,
// DownloadService falls back to RTSP automatically.

import http from 'http'
import crypto from 'crypto'
import type { NVR } from '@prisma/client'
import { StrategyUnavailableError, type DownloadContext, type DownloadStrategy } from '../types.js'
import { searchHikvisionRecordings } from '../../hikvision.search.js'


// ── Digest Auth helpers (unchanged) ─────────────────────────────────────────

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
  const ha1 = crypto.createHash('md5').update(`${username}:${challenge.realm}:${password}`).digest('hex')
  const ha2 = crypto.createHash('md5').update(`${method}:${uri}`).digest('hex')

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
    response = crypto.createHash('md5').update(`${ha1}:${challenge.nonce}:${ha2}`).digest('hex')
  }

  let header =
    `Digest username="${username}", realm="${challenge.realm}", ` +
    `nonce="${challenge.nonce}", uri="${uri}", response="${response}"`

  if (challenge.qop === 'auth') header += `, qop=auth, nc=${ncHex}, cnonce="${cnonce}"`
  if (challenge.opaque)         header += `, opaque="${challenge.opaque}"`

  return header
}

// ── New: search-result → download request helpers ──────────────────────────

const DOWNLOAD_PATH = '/ISAPI/ContentMgmt/download'

function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function fmtHikTime(d: Date): string {
  return d.toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z'
}

// The matched segment's playbackURI covers the *whole* recorded block, which
// is usually wider than what the user actually selected. The NVR only uses
// `name`+`size` to locate the file on disk — starttime/endtime just control
// where playback/download starts and stops within it — so we can safely
// narrow those two query params to the user's exact requested window without
// needing a second search round-trip.
function clampPlaybackURI(playbackURI: string, reqStart: Date, reqEnd: Date, segStart: Date, segEnd: Date): string {
  const clampedStart = new Date(Math.max(reqStart.getTime(), segStart.getTime()))
  const clampedEnd   = new Date(Math.min(reqEnd.getTime(), segEnd.getTime()))
  return playbackURI
    .replace(/starttime=[^&]+/, `starttime=${fmtHikTime(clampedStart)}`)
    .replace(/endtime=[^&]+/, `endtime=${fmtHikTime(clampedEnd)}`)
}

function buildDownloadXML(playbackURI: string): string {
  return `<?xml version="1.0" encoding="utf-8"?><downloadRequest><playbackURI>${escapeXml(playbackURI)}</playbackURI></downloadRequest>`
}

// ── Strategy ─────────────────────────────────────────────────────────────────

export class HikvisionDownloadStrategy implements DownloadStrategy {
  readonly name = 'hikvision-isapi'

  supports(nvr: NVR): boolean {
    return nvr.type === 'HIKVISION'
  }

  async download(ctx: DownloadContext): Promise<void> {
    const { nvr, password, channel, start, end, filename, req, res } = ctx

    console.log(`[${this.name}] starting — ch${channel} ${start.toISOString()}→${end.toISOString()} ${nvr.ip}`)

    // ── Step 0: search for the exact segment covering the requested window ──
    const segments = await searchHikvisionRecordings(
      nvr.ip, nvr.httpPort, nvr.username, password, channel, start, end,
    )

    const match = segments.find((s) => s.playbackURI && s.startTime < end && s.endTime > start)
    if (!match || !match.playbackURI) {
      throw new StrategyUnavailableError(
        `No recording segment found on ${nvr.ip} ch${channel} for ${start.toISOString()}→${end.toISOString()}`
      )
    }

    const playbackURI = clampPlaybackURI(match.playbackURI, start, end, match.startTime, match.endTime)
    const xmlBody = buildDownloadXML(playbackURI)

    // ── Step 1: unauthenticated probe to get the Digest challenge ───────────
    const challenge = await new Promise<DigestChallenge>((resolve, reject) => {
      const probeReq = http.request(
        {
          hostname: nvr.ip,
          port:     nvr.httpPort,
          path:     DOWNLOAD_PATH,
          method:   'POST',
          headers:  { 'Content-Type': 'application/xml', 'Content-Length': Buffer.byteLength(xmlBody) },
        },
        (probeRes) => {
          probeRes.resume()
          if (probeRes.statusCode === 401) {
            const www = probeRes.headers['www-authenticate'] ?? ''
            if (!www.toLowerCase().includes('digest')) {
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
      probeReq.end(xmlBody)
    })

    // ── Step 2: authenticated POST with the real download request ──────────
    const authHeader = challenge.nonce
      ? buildDigestHeader('POST', DOWNLOAD_PATH, nvr.username, password, challenge)
      : 'Basic ' + Buffer.from(`${nvr.username}:${password}`).toString('base64')

    await new Promise<void>((resolve, reject) => {
      let headersSet = false
      let nvrReq: http.ClientRequest

      const cleanup = () => { if (nvrReq) nvrReq.destroy() }
      req.on('close', cleanup)

      nvrReq = http.request(
        {
          hostname: nvr.ip,
          port:     nvr.httpPort,
          path:     DOWNLOAD_PATH,
          method:   'POST',
          headers: {
            Authorization:    authHeader,
            'Content-Type':   'application/xml',
            'Content-Length': Buffer.byteLength(xmlBody),
          },
        },
        (nvrRes) => {
          if (nvrRes.statusCode === 401) {
            nvrRes.resume()
            return reject(new StrategyUnavailableError(`ISAPI auth failed on ${nvr.ip} — check NVR credentials`))
          }
          if (!nvrRes.statusCode || nvrRes.statusCode < 200 || nvrRes.statusCode >= 300) {
            nvrRes.resume()
            return reject(new StrategyUnavailableError(
              `ISAPI returned ${nvrRes.statusCode} on ${nvr.ip} — falling back to RTSP`
            ))
          }

          if (!headersSet) {
            headersSet = true
            res.setHeader('Content-Type', 'video/mp4')
            res.setHeader('Content-Disposition', `attachment; filename="${filename}"`)
            res.setHeader('Cache-Control', 'no-cache')

            const cl = nvrRes.headers['content-length']
            if (cl) {
              res.setHeader('Content-Length', cl)
              console.log(`[${this.name}] Content-Length: ${cl} bytes`)
            }
          }

          nvrRes.on('data', (chunk: Buffer) => {
            const ok = res.write(chunk)
            if (!ok) {
              nvrRes.pause()
              res.once('drain', () => nvrRes.resume())
            }
          })

          nvrRes.on('end', () => {
            if (!res.writableEnded) res.end()
            console.log(`[${this.name}] complete: ${filename}`)
            resolve()
          })

          nvrRes.on('error', (err) => {
            console.error(`[${this.name}] NVR stream error: ${err.message}`)
            if (!res.writableEnded) res.end()
            reject(err)
          })
        }
      )

      nvrReq.setTimeout(30_000, () => {
        nvrReq.destroy(new Error(`ISAPI download timed out on ${nvr.ip}`))
      })

      nvrReq.on('error', (err) => {
        console.error(`[${this.name}] request error: ${err.message}`)
        reject(new StrategyUnavailableError(`ISAPI network error on ${nvr.ip}: ${err.message}`))
      })

      nvrReq.end(xmlBody)
    })
  }
}