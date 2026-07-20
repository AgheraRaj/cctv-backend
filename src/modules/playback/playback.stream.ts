import { spawn, type ChildProcess } from 'child_process'
import type { Request, Response } from 'express'
import prisma from '../../config/db.js'
import { decrypt } from '../../utils/crypto.js'
import { generatePlaybackRTSP } from './playback.generator.js'
import { getHifocusReplayInfo } from './hifocus.replay.js'
import { env } from '../../config/env.js'


// ── Single-flight per NVR+channel ─────────────────────────────────────────────
// Approach A (ffmpeg-per-request) has no in-place seek — a timeline click on
// the frontend means "kill the current stream, request a new one starting at
// the new offset." Without this guard, fast scrubbing fires overlapping
// requests that each open their own RTSP connection, stacking up against the
// NVR's (small, easily exhausted — see tonight's 453 saga) connection budget.
// This makes "one active ffmpeg per NVR+channel" a hard invariant: a new
// request always kills and waits out whatever came before it first.
interface ActiveStream {
  ffmpeg: ChildProcess
  kill: () => void
}
export const activeStreams = new Map<string, ActiveStream>()

export const streamKey = (nvrId: string, channel: number): string => `${nvrId}:${channel}`

// ── Codec probing ─────────────────────────────────────────────────────────────
// H.265/HEVC has no native <video> support in Chrome/Firefox/Edge, so those
// streams must be transcoded to H.264 before reaching the browser. H.264
// sources can go through untouched via -c:v copy (near-zero CPU cost). We
// cache the result per NVR+channel — mixed fleets often have consistent
// codecs per channel, and probing opens a second RTSP session on an NVR
// that may already be tight on concurrent-connection slots (see the 453
// "Not Enough Bandwidth" issue), so we want to do this as rarely as possible.
const CODEC_CACHE_TTL_MS = 60 * 60 * 1000 // 1 hour
const codecCache = new Map<string, { codec: string; expiresAt: number }>()

const probeVideoCodec = (rtspUrl: string): Promise<string | null> => {
  return new Promise((resolve) => {
    const ffprobe = spawn('ffprobe', [
      '-v', 'error',
      '-rtsp_transport', 'tcp',
      '-timeout', '8000000', // 8s — RTSP demuxer socket I/O timeout (microseconds); same rationale as the main ffmpeg timeout
      '-select_streams', 'v:0',
      '-show_entries', 'stream=codec_name',
      '-of', 'csv=p=0',
      rtspUrl,
    ])

    let output = ''
    ffprobe.stdout.on('data', (d: Buffer) => { output += d.toString() })
    ffprobe.stderr.on('data', () => { /* discarded — redaction not worth it for a probe we already log the outcome of */ })

    const timeout = setTimeout(() => {
      ffprobe.kill('SIGKILL')
      resolve(null) // unknown — caller decides the safe default
    }, 9000)

    ffprobe.on('close', () => {
      clearTimeout(timeout)
      resolve(output.trim() || null)
    })

    ffprobe.on('error', () => {
      clearTimeout(timeout)
      resolve(null)
    })
  })
}

const getVideoCodec = async (cacheKey: string, rtspUrl: string): Promise<string | null> => {
  const cached = codecCache.get(cacheKey)
  if (cached && cached.expiresAt > Date.now()) return cached.codec

  const codec = await probeVideoCodec(rtspUrl)
  if (codec) {
    codecCache.set(cacheKey, { codec, expiresAt: Date.now() + CODEC_CACHE_TTL_MS })
  }
  return codec
}

/**
 * GET /api/playback/stream
 *
 * Streams a recording clip directly from the NVR to the browser as a
 * fragmented MP4 — no MediaMTX involved, no temp files, no disk usage.
 *
 * ffmpeg reads the NVR's RTSP playback URL and pipes remuxed fMP4 to the
 * HTTP response as chunked transfer encoding (no Content-Length — the
 * encoded size isn't known up front, and a guessed value corrupts the
 * response the moment it's wrong).
 *
 * SEEKING: this is a single ffmpeg pipe with no byte↔time index, so there is
 * no in-place seek. The frontend implements seeking by calling this endpoint
 * again with a new startTime (see PlaybackSeekPlayer) — each call fully
 * supersedes the previous one for the same nvrId+channel (enforced by
 * activeStreams below), so only one RTSP connection to a given channel is
 * ever open at a time regardless of how fast the user scrubs.
 *
 * Query params:
 *   nvrId      string   — NVR database ID
 *   channel    number   — camera channel number
 *   startTime  string   — ISO 8601 UTC (where to start in the recording)
 *   endTime    string   — ISO 8601 UTC (end of the recording window)
 *   download   'true'?  — if set, sends Content-Disposition: attachment so
 *                         the browser saves the file instead of playing it
 *                         inline. Same ffmpeg pipe either way — fragmented
 *                         MP4 saves and plays back fine in VLC/modern players.
 */

// Strip anything that isn't safe in a filename / HTTP header value.
const sanitizeForFilename = (s: string): string =>
  s.replace(/[^a-zA-Z0-9_-]+/g, '_').replace(/^_+|_+$/g, '') || 'clip'

export async function streamRecording(req: Request, res: Response): Promise<void> {
  const { nvrId, channel, startTime, endTime, download } = req.query as Record<string, string>
  const isDownload = download === 'true'

  if (!nvrId || !channel || !startTime || !endTime) {
    res.status(400).json({ error: 'nvrId, channel, startTime, endTime are required' })
    return
  }

  const channelNo = parseInt(channel, 10)
  if (isNaN(channelNo) || channelNo < 1) {
    res.status(400).json({ error: 'Invalid channel' })
    return
  }

  const start = new Date(startTime)
  const end   = new Date(endTime)
  if (isNaN(start.getTime()) || isNaN(end.getTime()) || end <= start) {
    res.status(400).json({ error: 'Invalid startTime or endTime' })
    return
  }

  const nvr = await prisma.nVR.findUnique({ where: { id: nvrId } })
  if (!nvr) { res.status(404).json({ error: 'NVR not found' }); return }

  const password = decrypt(nvr.password)
  let rtspUrl: string

  try {
    if (nvr.type === 'HIKVISION') {
      rtspUrl = generatePlaybackRTSP(
        { username: nvr.username, password, ip: nvr.ip, rtspPort: nvr.rtspPort, type: 'HIKVISION' },
        channelNo, start, end,
      )
    } else if (nvr.type === 'HIFOCUS') {
      const info = await getHifocusReplayInfo(
        nvr.ip, nvr.httpPort, nvr.rtspPort,
        nvr.username, password,
        channelNo, start, end,
      )
      rtspUrl = info.rtspUrl
    } else {
      res.status(400).json({ error: `Unsupported NVR type: ${nvr.type}` }); return
    }
  } catch (err) {
    console.error('[streamRecording] Failed to build RTSP URL:', err)
    res.status(502).json({ error: 'Failed to get recording URL from NVR' })
    return
  }

  // Probing costs a couple hundred ms (cached for an hour after) and briefly
  // opens a second RTSP session — acceptable overhead to avoid needlessly
  // transcoding every H.264 stream, and to avoid shipping unplayable HEVC
  // to Chrome/Firefox/Edge without knowing it.
  const cacheKey = `${nvr.ip}:${nvr.rtspPort}:${channelNo}`
  const codec = await getVideoCodec(cacheKey, rtspUrl)
  const needsTranscode = codec === 'hevc' || codec === 'h265'

  if (codec === null) {
    console.warn(`[streamRecording] could not determine codec for ${nvrId} ch${channelNo} — defaulting to H.264 transcode for browser safety`)
  }

  const videoArgs = (needsTranscode || codec === null)
    ? [
        '-c:v', 'libx264',
        '-preset', 'veryfast',
        '-crf', '23',
      ]
    : ['-c:v', 'copy']

  // Enforce one active ffmpeg/RTSP connection per NVR+channel. If a previous
  // request (e.g. the last seek) is still tearing down, kill it now and wait
  // for the NVR to actually release the slot before opening a new one —
  // otherwise the new DESCRIBE can land before the old one's TEARDOWN and
  // get rejected with 453, exactly like we saw earlier tonight.
  // Downloads get their own key namespace, deliberately excluded from the
  // single-flight guard above. That guard exists to stop overlapping SEEKS
  // on the same channel from stacking up RTSP connections — but a download
  // is a distinct, intentional request that shouldn't kill whatever the user
  // is currently watching live on that same channel. Multiple simultaneous
  // downloads of the same channel are still independent from each other too
  // (each gets its own timestamp-suffixed key) since there's no "supersede"
  // relationship between them the way there is between sequential seeks.
  const key = isDownload
  ? `download:${streamKey(nvrId, channelNo)}:${Date.now()}`
  : streamKey(nvrId, channelNo)

if (!isDownload) {
  const existing = activeStreams.get(key)
  if (existing) {
    console.log(`[streamRecording] superseding in-flight stream for ${key}`)
    existing.kill()
    await new Promise((r) => setTimeout(r, env.PLAYBACK_NVR_SLOT_RELEASE_MS))
  }
} else {
  // For downloads: kill any active PLAYBACK stream on this channel first,
  // then wait for the NVR to release the slot before opening the download.
  const playbackKey = streamKey(nvrId, channelNo)
  const existingPlayback = activeStreams.get(playbackKey)
  if (existingPlayback) {
    console.log(`[streamRecording] killing playback stream before download for ${playbackKey}`)
    existingPlayback.kill()
    await new Promise((r) => setTimeout(r, env.PLAYBACK_NVR_SLOT_RELEASE_MS))
  }
}

  const ffmpeg = spawn('ffmpeg', [
    '-loglevel',       'warning',
    '-rtsp_transport', 'tcp',
    // Fail fast instead of hanging forever if the NVR accepts the RTSP
    // connection but never actually sends frames (e.g. no recording in the
    // requested window, or a stale/blocked playback slot on the NVR).
    // -timeout is the RTSP demuxer's socket I/O timeout, in microseconds.
    '-timeout',        '10000000', // 10s — RTSP demuxer socket I/O timeout (microseconds)
    '-i',              rtspUrl,
    ...videoArgs,
    '-an',             // ← drop audio entirely — pcm_alaw is not MP4-compatible
    '-movflags',       'frag_keyframe+empty_moov+default_base_moof',
    '-f',              'mp4',
    'pipe:1',
  ])

  // No Content-Length: we don't know the real encoded size up front, and a
  // guessed value is a protocol violation the moment it doesn't match what
  // we actually send (silent truncation, or corrupted keep-alive sockets).
  // Omitting it makes Express fall back to chunked transfer encoding, which
  // is what an unknown-length piped stream should use.
  res.setHeader('Content-Type', 'video/mp4')
  res.setHeader('Cache-Control', 'no-cache')

  if (isDownload) {
    const filename =
      `${sanitizeForFilename(nvr.name)}_ch${channelNo}_` +
      `${start.toISOString().replace(/[:.]/g, '-')}.mp4`
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`)
  }

  // Killing ffmpeg with SIGKILL gives it no chance to send an RTSP TEARDOWN
  // to the NVR — the NVR then holds that playback slot open until its own
  // internal timeout expires (often well over a minute), which silently
  // eats into the NVR's limited concurrent-stream budget on every
  // disconnect/abort/reload. SIGTERM lets ffmpeg close the RTSP session
  // properly; SIGKILL is only a fallback if it doesn't exit promptly.
  const killFfmpeg = () => {
    ffmpeg.kill('SIGTERM')
    setTimeout(() => {
      if (ffmpeg.exitCode === null && ffmpeg.signalCode === null) {
        ffmpeg.kill('SIGKILL')
      }
    }, 2000)
  }

  activeStreams.set(key, { ffmpeg, kill: killFfmpeg })
  const releaseIfCurrent = () => {
    // Only clear the map entry if we're still the current stream for this
    // key — an older request's delayed cleanup must not clobber a newer
    // stream that's already taken over the slot.
    if (activeStreams.get(key)?.ffmpeg === ffmpeg) activeStreams.delete(key)
  }

  // If ffmpeg never produces any output within this window, something is
  // wrong upstream (no recording / stalled NVR slot) — fail the request
  // instead of leaving the client hanging like in the report above.
  let wroteAnyData = false
  const firstByteTimeout = setTimeout(() => {
    if (!wroteAnyData && !res.writableEnded) {
      console.warn(`[streamRecording] no data from ffmpeg within 12s for ${nvrId} ch${channelNo} — likely no recording in range or a stuck NVR playback slot`)
      killFfmpeg()
      if (!res.headersSent) {
        res.status(502).json({ error: 'No video data received from NVR for the requested time range.' })
      } else {
        res.end()
      }
    }
  }, 12_000)

  ffmpeg.stdout.once('data', () => {
    wroteAnyData = true
    clearTimeout(firstByteTimeout)
  })

  // Pipe ffmpeg output directly to the HTTP response — nothing saved to disk
  ffmpeg.stdout.pipe(res)

  ffmpeg.stderr.on('data', (data: Buffer) => {
    // ffmpeg echoes the full RTSP URL (including plaintext credentials) into
    // its own error messages — strip that before it hits the logs.
    const redacted = data.toString().trim().replace(/rtsp:\/\/[^@]+@/g, 'rtsp://***:***@')
    console.debug(`[ffmpeg] ${redacted}`)
  })

  req.on('close', killFfmpeg)

  ffmpeg.on('close', (code) => {
    releaseIfCurrent()
    if (code !== 0 && code !== null) {
      console.warn(`[ffmpeg] exited with code ${code} for ${nvrId} ch${channelNo}`)
    }
    if (!res.writableEnded) res.end()
  })

  ffmpeg.on('error', (err) => {
    releaseIfCurrent()
    console.error('[ffmpeg] spawn error:', err)
    if (!res.headersSent) {
      res.status(500).json({ error: 'ffmpeg failed to start' })
    } else {
      res.end()
    }
  })
}