// src/modules/playback/download/download.service.ts
//
// Orchestrates the download strategy chain.
//
// STRATEGY ORDER (matters — first match with supports() === true is tried first):
//   1. HikvisionDownloadStrategy  — ISAPI direct file download (fast)
//   2. HifocusDownloadStrategy    — RTSP+ffmpeg (HiFocus only)
//   3. RtspDownloadStrategy       — universal RTSP fallback
//
// FALLBACK BEHAVIOUR:
//   If a strategy throws StrategyUnavailableError, the next matching strategy
//   in the chain is tried. Any other error is fatal and propagated to the caller.
//   This means:
//     - Hikvision NVR with ISAPI support  → HikvisionDownloadStrategy (fast)
//     - Hikvision NVR on old firmware     → RtspDownloadStrategy (slow fallback)
//     - HiFocus NVR                       → HifocusDownloadStrategy → RtspDownloadStrategy

import { HikvisionDownloadStrategy } from './strategies/hikvision.strategy.js'
import { StrategyUnavailableError }  from './types.js'
import type { DownloadContext, DownloadStrategy } from './types.js'

import { HifocusDownloadStrategy } from './strategies/hifocus.strategy.js'
import { RtspDownloadStrategy } from './strategies/rtsp.strategy.js'

export class DownloadService {
  private readonly strategies: DownloadStrategy[]

  constructor() {
    // Order is significant: more capable/faster strategies first.
    this.strategies = [
      new HikvisionDownloadStrategy(),
      new HifocusDownloadStrategy(),
      new RtspDownloadStrategy(),
    ]
  }

  async download(ctx: DownloadContext): Promise<void> {
    const { nvr } = ctx

    // Collect all strategies that declare support for this NVR type
    const candidates = this.strategies.filter((s) => s.supports(nvr))

    if (candidates.length === 0) {
      throw new Error(`No download strategy available for NVR type: ${nvr.type}`)
    }

    let lastError: Error | undefined

    for (const strategy of candidates) {
      try {
        console.log(`[download-service] trying strategy "${strategy.name}" for NVR ${nvr.id} (${nvr.type})`)
        await strategy.download(ctx)
        console.log(`[download-service] strategy "${strategy.name}" succeeded`)
        return
      } catch (err) {
        if (err instanceof StrategyUnavailableError) {
          console.warn(
            `[download-service] strategy "${strategy.name}" unavailable: ${err.message} — ` +
            `trying next strategy`
          )
          lastError = err
          // Continue to next strategy
        } else {
          // Real error — don't fall back, let it propagate
          throw err
        }
      }
    }

    // All strategies exhausted
    throw new Error(
      `All download strategies failed for NVR ${nvr.id} (${nvr.type}). ` +
      `Last error: ${lastError?.message}`
    )
  }
}

// Singleton — one instance shared across all requests
export const downloadService = new DownloadService()