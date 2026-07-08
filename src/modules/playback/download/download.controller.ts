// src/modules/playback/download/download.controller.ts
//
// Deliberately thin — validate, fetch NVR, delegate to service.
// Zero vendor-specific logic lives here.

import { Response, NextFunction } from 'express'
import { z } from 'zod'
import { AuthRequest } from '../../../middleware/auth.js'
import { AppError } from '../../../middleware/errorHandler.js'
import prisma from '../../../config/db.js'
import { decrypt } from '../../../utils/crypto.js'
import { downloadService } from './download.service.js'
import logger from '../../../utils/logger.js'

const querySchema = z.object({
  nvrId:     z.string().min(1),
  channel:   z.coerce.number().int().min(1),
  startTime: z.string().datetime(),
  endTime:   z.string().datetime(),
  // token is validated by the authenticate middleware (query param fallback)
  // before this controller is ever called — no need to re-validate here.
})

function buildFilename(nvrName: string, channel: number, start: Date): string {
  const safe    = nvrName.replace(/[^a-zA-Z0-9_-]+/g, '_').replace(/^_+|_+$/g, '') || 'nvr'
  const dateStr = start.toISOString().replace('T', '_').replace(/:/g, '-').split('.')[0]
  return `${safe}_ch${channel}_${dateStr}.mp4`
}

export const downloadRecording = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    // ── 1. Validate query params ──────────────────────────────────────────────
    const parsed = querySchema.safeParse(req.query)
    if (!parsed.success) throw new AppError(400, parsed.error.issues[0].message)

    const { nvrId, channel, startTime, endTime } = parsed.data
    const start = new Date(startTime)
    const end   = new Date(endTime)

    if (end <= start) throw new AppError(400, 'endTime must be after startTime.')

    const durationSec = Math.round((end.getTime() - start.getTime()) / 1000)
    if (durationSec < 1)              throw new AppError(400, 'Duration must be at least 1 second.')
    if (durationSec > 4 * 60 * 60)   throw new AppError(400, 'Maximum download duration is 4 hours.')

    // ── 2. Fetch NVR ──────────────────────────────────────────────────────────
    const nvr = await prisma.nVR.findUnique({ where: { id: nvrId } })
    if (!nvr) throw new AppError(404, `NVR ${nvrId} not found.`)

    const password = decrypt(nvr.password)
    const filename = buildFilename(nvr.name, channel, start)

    logger.info(
      `[download] ${nvr.type} nvrId=${nvrId} ch${channel} ` +
      `${startTime}→${endTime} (${durationSec}s) user=${req.user?.id}`
    )

    // ── 3. Delegate to service (strategy chain handles the rest) ──────────────
    await downloadService.download({ nvr, password, channel, start, end, filename, req, res })

  } catch (err) {
    next(err)
  }
}