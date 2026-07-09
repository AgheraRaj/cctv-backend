// src/modules/playback/download/strategies/rtsp.strategy.ts
//
// RTSP + ffmpeg download strategy.
//
// WHY RTSP IS SLOW FOR DOWNLOADS:
//   The NVR's RTSP playback server replays footage at 1× real-time speed —
//   a 1-hour clip takes ~1 hour to transfer regardless of network bandwidth.
//   This is a protocol constraint of RTSP, not a code problem. Native HTTP
//   file download APIs (like Hikvision ISAPI) bypass this entirely.
//
// WHEN THIS IS USED:
//   - HiFocus NVRs (no documented native HTTP download API)
//   - Hikvision fallback (if ISAPI endpoint returns 404 on older firmware)
//
// FFMPEG FLAGS FOR DOWNLOAD (different from streaming):
//   - NO frag_keyframe+empty_moov: those flags are for low-latency streaming.
//     For a download we want a single well-formed MP4 the user can seek in
//     after saving — that requires a complete moov atom.
//   - faststart: moves the moov atom to the front of the file so the
//     browser/VLC can start seeking immediately after download completes.
//   - -t durationSec: hard stop prevents ffmpeg from running forever if the
//     NVR serves more data than requested (some firmware quirks).
//   - SIGTERM before SIGKILL: lets ffmpeg send RTSP TEARDOWN to the NVR so
//     the slot is released immediately rather than timing out after ~60s.

import { spawn } from 'child_process'
import type { NVR } from '@prisma/client'
import { generatePlaybackRTSP } from '../../playback.generator.js'
import { getHifocusReplayInfo } from '../../hifocus.replay.js'
import { activeStreams, streamKey } from '../../playback.stream.js'
import { env } from '../../../../config/env.js'
import logger from '../../../../utils/logger.js'
import type { DownloadContext, DownloadStrategy } from '../types.js'

export class RtspDownloadStrategy implements DownloadStrategy {
  readonly name = 'rtsp-ffmpeg'

  // Accepts any NVR — this is the universal fallback
  supports(_nvr: NVR): boolean {
    return true
  }

  async download(ctx: DownloadContext): Promise<void> {
    const { nvr, password, channel, start, end, filename, req, res } = ctx

    const durationSec = Math.round((end.getTime() - start.getTime()) / 1000)

    logger.info(
      `[${this.name}] starting — ${nvr.type} ch${channel} ` +
      `${start.toISOString()}→${end.toISOString()} (${durationSec}s)`
    )

    // ── Build RTSP URL ────────────────────────────────────────────────────────
    let rtspUrl: string
    if (nvr.type === 'HIKVISION') {
      rtspUrl = generatePlaybackRTSP(
        { username: nvr.username, password, ip: nvr.ip, rtspPort: nvr.rtspPort, type: 'HIKVISION' },
        channel, start, end,
      )
    } else if (nvr.type === 'HIFOCUS') {
      const info = await getHifocusReplayInfo(
        nvr.ip, nvr.httpPort, nvr.rtspPort,
        nvr.username, password,
        channel, start, end,
      )
      rtspUrl = info.rtspUrl
    } else {
      throw new Error(`Unsupported NVR type: ${nvr.type}`)
    }

    // ── Kill any active playback stream on this channel first ─────────────────
    // HiFocus (and some Hikvision firmware) reject a second concurrent RTSP
    // connection on the same channel with 453 "Not Enough Bandwidth".
    const key = streamKey(nvr.id, channel)
    const existingPlayback = activeStreams.get(key)
    if (existingPlayback) {
      logger.info(`[${this.name}] killing active playback stream for ${key} before download`)
      existingPlayback.kill()
      await new Promise((r) => setTimeout(r, env.PLAYBACK_NVR_SLOT_RELEASE_MS))
    }

    // ── Spawn ffmpeg ──────────────────────────────────────────────────────────
    const ffmpeg = spawn('ffmpeg', [
  '-loglevel',       'warning',
  '-rtsp_transport', 'tcp',
  '-timeout',        '10000000',
  '-i',              rtspUrl,
  '-t',              String(durationSec),
  '-c:v',            'copy',
  '-an',
  // faststart needs a seekable output; pipe:1 isn't seekable, so fragment
  // instead — no seek-back required, still playable/seekable downstream.
  '-movflags',       'frag_keyframe+empty_moov+default_base_moof',
  '-f',              'mp4',
  'pipe:1',
    ])

    const killFfmpeg = () => {
      ffmpeg.kill('SIGTERM')
      setTimeout(() => {
        if (ffmpeg.exitCode === null && ffmpeg.signalCode === null) {
          ffmpeg.kill('SIGKILL')
        }
      }, 2_000)
    }

    req.on('close', () => {
      logger.info(`[${this.name}] client cancelled: ${filename}`)
      killFfmpeg()
    })

    // ── Set headers before any bytes flow ────────────────────────────────────
    res.setHeader('Content-Type',        'video/mp4')
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`)
    res.setHeader('Cache-Control',       'no-cache')
    // No Content-Length — we don't know the encoded size until ffmpeg finishes

    ffmpeg.stdout.pipe(res)

    ffmpeg.stderr.on('data', (data: Buffer) => {
      const redacted = data.toString().trim().replace(/rtsp:\/\/[^@]+@/g, 'rtsp://***:***@')
      logger.debug(`[${this.name}:ffmpeg] ${redacted}`)
    })

    await new Promise<void>((resolve, reject) => {
      ffmpeg.on('close', (code) => {
        if (code !== 0 && code !== null) {
          logger.warn(`[${this.name}] ffmpeg exited ${code} for ${filename}`)
        } else {
          logger.info(`[${this.name}] complete: ${filename}`)
        }
        if (!res.writableEnded) res.end()
        resolve()
      })

      ffmpeg.on('error', (err) => {
        logger.error(`[${this.name}] ffmpeg spawn error: ${err.message}`)
        if (!res.headersSent) {
          res.status(500).json({ error: 'ffmpeg failed to start.' })
        } else {
          res.end()
        }
        reject(err)
      })
    })
  }
}