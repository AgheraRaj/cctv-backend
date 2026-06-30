import { Response, NextFunction } from 'express'
import { z } from 'zod'
import { AuthRequest } from '../../middleware/auth.js'
import { AppError } from '../../middleware/errorHandler.js'
import { resolvePlayback, seekPlayback, stopPlayback, getRecordings } from './playback.service.js'

// ─── Schemas ─────────────────────────────────────────────────────────────────

const resolveSchema = z.object({
  nvrId:     z.string().min(1, 'nvrId is required.'),
  channel:   z.number().int().min(1, 'channel must be at least 1.'),
  startTime: z.string().datetime('startTime must be ISO 8601.'),
  endTime:   z.string().datetime('endTime must be ISO 8601.'),
})

const seekSchema = z.object({
  nvrId:        z.string().min(1, 'nvrId is required.'),
  channel:      z.number().int().min(1, 'channel must be at least 1.'),
  startTime:    z.string().datetime('startTime must be ISO 8601.'),
  endTime:      z.string().datetime('endTime must be ISO 8601.'),
  oldPathName:  z.string().min(1, 'oldPathName is required.'),
  tzOffsetMs:   z.number().default(0),
})

const recordingsQuerySchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'date must be YYYY-MM-DD.'),
})

// ─── POST /api/playback/resolve ──────────────────────────────────────────────

export const resolve = async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    const parsed = resolveSchema.safeParse(req.body)
    if (!parsed.success) throw new AppError(400, parsed.error.issues[0].message)

    const { nvrId, channel, startTime, endTime } = parsed.data
    const start = new Date(startTime)
    const end   = new Date(endTime)
    if (end <= start) throw new AppError(400, 'endTime must be after startTime.')

    const result = await resolvePlayback(nvrId, channel, start, end)
    res.status(200).json(result)
  } catch (err) {
    next(err)
  }
}

// ─── POST /api/playback/seek ─────────────────────────────────────────────────
// Called when user seeks to a new position on the timeline.
// Stops old stream, starts new stream from the seek position.

export const seek = async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    const parsed = seekSchema.safeParse(req.body)
    if (!parsed.success) throw new AppError(400, parsed.error.issues[0].message)

    const { nvrId, channel, startTime, endTime, oldPathName, tzOffsetMs } = parsed.data
    const start = new Date(startTime)
    const end   = new Date(endTime)
    if (end <= start) throw new AppError(400, 'endTime must be after startTime.')

    const result = await seekPlayback(nvrId, channel, start, end, oldPathName, tzOffsetMs)
    res.status(200).json(result)
  } catch (err) {
    next(err)
  }
}

// ─── DELETE /api/playback/:pathName ──────────────────────────────────────────

export const stop = async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { pathName } = req.params
    if (!pathName || Array.isArray(pathName)) throw new AppError(400, 'pathName is required.')
    await stopPlayback(pathName)
    res.status(204).send()
  } catch (err) {
    next(err)
  }
}

// ─── GET /api/playback/recordings/:nvrId/:channel?date=YYYY-MM-DD ────────────

export const recordings = async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { nvrId, channel: channelParam } = req.params
    
    if (!nvrId || Array.isArray(nvrId)) throw new AppError(400, 'nvrId is required.')
    if (!channelParam || Array.isArray(channelParam)) throw new AppError(400, 'channel is required.')

    const channel = parseInt(channelParam, 10)
    if (isNaN(channel) || channel < 1) throw new AppError(400, 'channel must be a positive integer.')

    const queryParsed = recordingsQuerySchema.safeParse(req.query)
    if (!queryParsed.success) throw new AppError(400, queryParsed.error.issues[0].message)

    const segments = await getRecordings(nvrId, channel, queryParsed.data.date)
    res.status(200).json(segments)
  } catch (err) {
    next(err)
  }
}