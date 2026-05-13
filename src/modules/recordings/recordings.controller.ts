import { env } from '../../config/env.js'
import { Response, NextFunction } from 'express'
import { z } from 'zod'
import { AuthRequest } from '../../middleware/auth.js'
import { AppError } from '../../middleware/errorHandler.js'
import {
  getRecordingCameras,
  getCameraRecordings,
  getRecordingById,
  deleteRecording,
  getRecordingStream,
  getStorageStats,
  getCameraTimeline,
  getCameraRecordingDays,
  findSegmentAtTime,
} from './recordings.service.js'
import { generateRecordingToken, verifyRecordingToken } from './recordings.token.js'

// GET /api/recordings/:nvrId/:channel/timeline?date=2026-05-12
export const getTimeline = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const nvrId = req.params.nvrId as string
    const channel = parseInt(req.params.channel as string, 10)

    if (isNaN(channel)) throw new AppError(400, 'Invalid channel number.')

    const dateStr = req.query.date as string
    if (!dateStr) throw new AppError(400, 'date query param is required. Format: YYYY-MM-DD')

    const date = new Date(dateStr)
    if (isNaN(date.getTime())) throw new AppError(400, 'Invalid date format. Use YYYY-MM-DD')

    const timeline = await getCameraTimeline(nvrId, channel, date)
    res.status(200).json(timeline)
  } catch (err) {
    next(err)
  }
}

// GET /api/recordings/:nvrId/:channel/days
export const getRecordingDays = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const nvrId = req.params.nvrId as string
    const channel = parseInt(req.params.channel as string, 10)

    if (isNaN(channel)) throw new AppError(400, 'Invalid channel number.')

    const days = await getCameraRecordingDays(nvrId, channel)
    res.status(200).json({ days })
  } catch (err) {
    next(err)
  }
}

// GET /api/recordings/:nvrId/:channel/seek?timestamp=2026-05-12T10:30:00Z
export const seekToTimestamp = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const nvrId = req.params.nvrId as string
    const channel = parseInt(req.params.channel as string, 10)

    if (isNaN(channel)) throw new AppError(400, 'Invalid channel number.')

    const timestampStr = req.query.timestamp as string
    if (!timestampStr) throw new AppError(400, 'timestamp query param is required.')

    const timestamp = new Date(timestampStr)
    if (isNaN(timestamp.getTime())) throw new AppError(400, 'Invalid timestamp format. Use ISO 8601.')

    const result = await findSegmentAtTime(nvrId, channel, timestamp)

    if (!result) {
      res.status(404).json({ error: 'No recording found at this timestamp.' })
      return
    }

    res.status(200).json(result)
  } catch (err) {
    next(err)
  }
}

// GET /api/recordings
// Lists all cameras that have at least one recording
export const listCameras = async (
  _req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const cameras = await getRecordingCameras()
    res.status(200).json(cameras)
  } catch (err) {
    next(err)
  }
}

// GET /api/recordings/stats
export const storageStats = async (
  _req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const stats = await getStorageStats()
    res.status(200).json(stats)
  } catch (err) {
    next(err)
  }
}

// GET /api/recordings/:nvrId/:channel
// Lists recordings for a specific camera with optional date filtering
const listSchema = z.object({
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
})

export const listRecordings = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const nvrId = req.params.nvrId as string
    const channel = parseInt(req.params.channel as string, 10)

    if (isNaN(channel)) {
      throw new AppError(400, 'Invalid channel number.')
    }

    const parsed = listSchema.safeParse(req.query)
    if (!parsed.success) {
      throw new AppError(400, parsed.error.issues[0].message)
    }

    const from = parsed.data.from ? new Date(parsed.data.from) : undefined
    const to = parsed.data.to ? new Date(parsed.data.to) : undefined

    const recordings = await getCameraRecordings(nvrId, channel, from, to)
    res.status(200).json(recordings)
  } catch (err) {
    next(err)
  }
}

// GET /api/recordings/file/:id
// Returns recording metadata
export const getRecording = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const id = req.params.id as string
    const recording = await getRecordingById(id)
    res.status(200).json(recording)
  } catch (err) {
    next(err)
  }
}

// GET /api/recordings/stream/:id
// Streams the video file with range support for seeking
export const streamRecording = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const id = req.params.id as string
    const rangeHeader = req.headers.range

    const { stream, headers, statusCode } = await getRecordingStream(id, rangeHeader)

    res.writeHead(statusCode, headers)
    stream.pipe(res)

    stream.on('error', (err) => {
      next(new AppError(500, `Stream error: ${err.message}`))
    })
  } catch (err) {
    next(err)
  }
}

// POST /api/recordings/token/:id
// Issues a short-lived token for streaming a specific recording
export const issueStreamToken = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const id = req.params.id as string

    // Verify recording exists before issuing token
    await getRecordingById(id)

    const token = generateRecordingToken(id, req.user!.id)

    res.status(200).json({
      token,
      expiresIn: parseInt(env.RECORDING_TOKEN_EXPIRES_IN, 10),
      streamUrl: `/api/recordings/stream/${id}?token=${token}`,
    })
  } catch (err) {
    next(err)
  }
}

// GET /api/recordings/stream/:id?token=xxx
// Streams recording file — validates token from query param
export const streamRecordingWithToken = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const id = req.params.id as string
    const token = req.query.token as string

    if (!token) {
      throw new AppError(401, 'Stream token is required.')
    }

    // Verify token and ensure it matches the requested recording
    const payload = verifyRecordingToken(token)
    if (payload.recordingId !== id) {
      throw new AppError(403, 'Token does not match requested recording.')
    }

    const rangeHeader = req.headers.range

    const { stream, headers, statusCode } = await getRecordingStream(id, rangeHeader)

    res.writeHead(statusCode, headers)
    stream.pipe(res)

    stream.on('error', (err) => {
      next(new AppError(500, `Stream error: ${err.message}`))
    })
  } catch (err) {
    next(err)
  }
}

// DELETE /api/recordings/file/:id  [admin only]
export const removeRecording = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const id = req.params.id as string
    await deleteRecording(id)
    res.status(200).json({ message: 'Recording deleted successfully.' })
  } catch (err) {
    next(err)
  }
}