import { Response, NextFunction } from 'express'
import { z } from 'zod'
import { AuthRequest } from '../../middleware/auth.js'
import { AppError } from '../../middleware/errorHandler.js'
import prisma from '../../config/db.js'
import { decrypt } from '../../utils/crypto.js'
import { searchHikvisionRecordings, type RecordingSegment } from './hikvision.search.js'
import { searchHifocusRecordings } from './hifocus.search.js'

const recordingsQuerySchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
})

const recordingDaysQuerySchema = z.object({
  year:  z.coerce.number().int().min(2000).max(2100),
  month: z.coerce.number().int().min(1).max(12),
})

// ── GET /api/playback/recordings/:nvrId/:channel ─────────────────────────────

export const recordings = async (
  req: AuthRequest, res: Response, next: NextFunction
): Promise<void> => {
  try {
    const { nvrId, channel: channelParam } = req.params as { nvrId: string; channel: string }
    const channel = parseInt(channelParam, 10)
    if (isNaN(channel) || channel < 1) throw new AppError(400, 'Invalid channel.')

    const queryParsed = recordingsQuerySchema.safeParse(req.query)
    if (!queryParsed.success) throw new AppError(400, queryParsed.error.issues[0].message)

    const { date } = queryParsed.data
    const startTime = new Date(`${date}T00:00:00Z`)
    const endTime = new Date(`${date}T23:59:59Z`)

    const nvr = await prisma.nVR.findUnique({ where: { id: nvrId } })
    if (!nvr) throw new AppError(404, `NVR ${nvrId} not found.`)

    const password = decrypt(nvr.password)

    let segments: RecordingSegment[]
    if (nvr.type === 'HIKVISION') {
      segments = await searchHikvisionRecordings(
        nvr.ip, nvr.httpPort, nvr.username, password, channel, startTime, endTime
      )
    } else if (nvr.type === 'HIFOCUS') {
      segments = await searchHifocusRecordings(
        nvr.ip, nvr.httpPort, nvr.username, password, channel, startTime, endTime
      )
    } else {
      throw new AppError(400, `Unsupported NVR type: ${nvr.type}`)
    }

    res.status(200).json(segments)
  } catch (err) { next(err) }
}

export const recordingDays = async (
  req: AuthRequest, res: Response, next: NextFunction
): Promise<void> => {
  try {
    const { nvrId, channel: channelParam } = req.params as { nvrId: string; channel: string }
    const channel = parseInt(channelParam, 10)
    if (isNaN(channel) || channel < 1) throw new AppError(400, 'Invalid channel.')

    const parsed = recordingDaysQuerySchema.safeParse(req.query)
    if (!parsed.success) throw new AppError(400, parsed.error.issues[0].message)

    const { year, month } = parsed.data

    // Full month window in UTC
    const startTime = new Date(Date.UTC(year, month - 1, 1, 0, 0, 0))
    const endTime   = new Date(Date.UTC(year, month,     0, 23, 59, 59)) // last day of month

    const nvr = await prisma.nVR.findUnique({ where: { id: nvrId } })
    if (!nvr) throw new AppError(404, `NVR ${nvrId} not found.`)

    const password = decrypt(nvr.password)
    const days = new Set<number>()

    if (nvr.type === 'HIKVISION') {
      const segments = await searchHikvisionRecordings(
        nvr.ip, nvr.httpPort, nvr.username, password, channel, startTime, endTime
      )
      for (const seg of segments) {
        const cursor = new Date(seg.startTime)
        cursor.setUTCHours(0, 0, 0, 0)
        while (cursor <= seg.endTime) {
          if (cursor.getUTCMonth() + 1 === month && cursor.getUTCFullYear() === year) {
            days.add(cursor.getUTCDate())
          }
          cursor.setUTCDate(cursor.getUTCDate() + 1)
        }
      }

    } else if (nvr.type === 'HIFOCUS') {
      const segments = await searchHifocusRecordings(
        nvr.ip, nvr.httpPort, nvr.username, password, channel, startTime, endTime
      )
      for (const seg of segments) {
        const cursor = new Date(seg.startTime)
        cursor.setUTCHours(0, 0, 0, 0)
        while (cursor <= seg.endTime) {
          if (cursor.getUTCMonth() + 1 === month && cursor.getUTCFullYear() === year) {
            days.add(cursor.getUTCDate())
          }
          cursor.setUTCDate(cursor.getUTCDate() + 1)
        }
      }

    } else {
      throw new AppError(400, `Unsupported NVR type: ${nvr.type}`)
    }

    res.status(200).json({ days: Array.from(days).sort((a, b) => a - b) })
  } catch (err) { next(err) }
}