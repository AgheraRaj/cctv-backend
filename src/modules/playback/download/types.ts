// src/modules/playback/download/types.ts
//
// Shared types for the download strategy system.
// Nothing in here imports from Express or ffmpeg — kept deliberately thin so
// strategies can be unit-tested without standing up the full server.

import type { Request, Response } from 'express'
import type { NVR } from '@prisma/client'

// ── Download context ──────────────────────────────────────────────────────────
// Everything a strategy needs to execute a download. Built once in the
// controller and passed to downloadService.download() — strategies never
// touch Prisma or JWT themselves.

export interface DownloadContext {
  nvr:        NVR           // full Prisma row, already fetched
  password:   string        // decrypted plaintext password
  channel:    number        // 1-based camera channel number
  start:      Date          // requested clip start (UTC)
  end:        Date          // requested clip end   (UTC)
  filename:   string        // suggested filename for Content-Disposition
  req:        Request       // for req.on('close') cancellation
  res:        Response      // HTTP response to stream into
}

// ── Strategy interface ────────────────────────────────────────────────────────
// Every concrete strategy implements this. The controller never calls a
// strategy directly — it goes through DownloadService which picks the right
// one and handles fallback.

export interface DownloadStrategy {
  /** Human-readable name used in logs, e.g. "hikvision-isapi" */
  readonly name: string

  /**
   * Return true if this strategy can handle the given NVR.
   * Called in order; the first strategy that returns true is tried first.
   */
  supports(nvr: NVR): boolean

  /**
   * Execute the download. Must write to ctx.res and resolve when the
   * response is finished (or reject on unrecoverable error).
   *
   * Throws StrategyUnavailableError to signal "try the next strategy"
   * (e.g. the ISAPI endpoint returned 404 on this firmware version).
   * Any other error is treated as fatal and propagated to the client.
   */
  download(ctx: DownloadContext): Promise<void>
}

// ── Sentinel error ────────────────────────────────────────────────────────────
// A strategy throws this to tell DownloadService "I can't handle this —
// fall back to the next strategy in the chain." Any other thrown error
// is treated as a real failure (don't fall back, surface to client).

export class StrategyUnavailableError extends Error {
  constructor(reason: string) {
    super(reason)
    this.name = 'StrategyUnavailableError'
  }
}