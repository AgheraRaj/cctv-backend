import fs from 'fs'
import path from 'path'
import prisma from '../../config/db.js'
import { AppError } from '../../middleware/errorHandler.js'
import { env } from '../../config/env.js'


// ─── Timeline / Coverage ──────────────────────────────────────────

export interface TimelineSegment {
  id: string
  filename: string
  startTime: Date
  endTime: Date | null
  durationSeconds: number | null
  sizeBytes: string  // bigint serialized as string for JSON
}

export const getCameraTimeline = async (
  nvrId: string,
  channel: number,
  date: Date  // the day to get timeline for
): Promise<TimelineSegment[]> => {
  const camera = await prisma.camera.findUnique({
    where: { nvrId_channel: { nvrId, channel } },
  })

  if (!camera) throw new AppError(404, 'Camera not found.')

  // Start and end of the requested day in UTC
  const dayStart = new Date(date)
  dayStart.setUTCHours(0, 0, 0, 0)

  const dayEnd = new Date(date)
  dayEnd.setUTCHours(23, 59, 59, 999)

  const recordings = await prisma.recording.findMany({
    where: {
      nvrId,
      channel,
      startTime: {
        gte: dayStart,
        lte: dayEnd,
      },
    },
    orderBy: { startTime: 'asc' },
    select: {
      id: true,
      filename: true,
      startTime: true,
      endTime: true,
      sizeBytes: true,
    },
  })

  return recordings.map((r) => {
    const durationSeconds =
      r.endTime
        ? Math.round((r.endTime.getTime() - r.startTime.getTime()) / 1000)
        : null

    return {
      id: r.id,
      filename: r.filename,
      startTime: r.startTime,
      endTime: r.endTime,
      durationSeconds,
      sizeBytes: r.sizeBytes.toString(),  // bigint → string for JSON
    }
  })
}

// ─── Available days ────────────────────────────────────────────────
// Returns list of dates that have at least one recording for a camera
// Frontend uses this to disable unavailable dates in the date picker

export const getCameraRecordingDays = async (
  nvrId: string,
  channel: number
): Promise<string[]> => {
  const camera = await prisma.camera.findUnique({
    where: { nvrId_channel: { nvrId, channel } },
  })

  if (!camera) throw new AppError(404, 'Camera not found.')

  const recordings = await prisma.recording.findMany({
    where: { nvrId, channel },
    select: { startTime: true },
    orderBy: { startTime: 'asc' },
  })

  // Extract unique dates as YYYY-MM-DD strings
  const days = new Set<string>()
  for (const r of recordings) {
    const day = r.startTime.toISOString().split('T')[0]
    days.add(day)
  }

  return Array.from(days)
}

// ─── Find segment by timestamp ────────────────────────────────────
// Given a timestamp, find which recording file contains it
// Frontend uses this when user clicks a point on the timeline

export const findSegmentAtTime = async (
  nvrId: string,
  channel: number,
  timestamp: Date
): Promise<{ id: string; offsetSeconds: number } | null> => {
  const recording = await prisma.recording.findFirst({
    where: {
      nvrId,
      channel,
      startTime: { lte: timestamp },
      OR: [
        { endTime: { gte: timestamp } },
        { endTime: null },  // ongoing recording
      ],
    },
    orderBy: { startTime: 'desc' },
  })

  if (!recording) return null

  const offsetSeconds = Math.round(
    (timestamp.getTime() - recording.startTime.getTime()) / 1000
  )

  return { id: recording.id, offsetSeconds }
}

// ─── List cameras that have recordings ───────────────────────────

export const getRecordingCameras = async () => {
  const cameras = await prisma.recording.findMany({
    distinct: ['cameraId'],
    select: {
      cameraId: true,
      nvrId: true,
      channel: true,
      camera: {
        select: {
          name: true,
          isOnline: true,
          nvr: {
            select: {
              id: true,
              name: true,
              ip: true,
              station: {
                select: {
                  id: true,
                  name: true,
                  city: true,
                },
              },
            },
          },
        },
      },
    },
  })

  return cameras.map((r) => ({
    cameraId: r.cameraId,
    nvrId: r.nvrId,
    channel: r.channel,
    cameraName: r.camera.name,
    isOnline: r.camera.isOnline,
    nvr: r.camera.nvr,
  }))
}

// ─── List recordings for a specific camera ────────────────────────

export const getCameraRecordings = async (
  nvrId: string,
  channel: number,
  from?: Date,
  to?: Date
) => {
  const camera = await prisma.camera.findUnique({
    where: { nvrId_channel: { nvrId, channel } },
  })

  if (!camera) throw new AppError(404, 'Camera not found.')

  const recordings = await prisma.recording.findMany({
    where: {
      nvrId,
      channel,
      ...(from || to
        ? {
            startTime: {
              ...(from ? { gte: from } : {}),
              ...(to ? { lte: to } : {}),
            },
          }
        : {}),
    },
    orderBy: { startTime: 'desc' },
    select: {
      id: true,
      filename: true,
      startTime: true,
      endTime: true,
      sizeBytes: true,
      createdAt: true,
    },
  })

  return recordings.map((r) => ({
    ...r,
    sizeBytes: Number(r.sizeBytes),
  }))
}

// ─── Get single recording ─────────────────────────────────────────

export const getRecordingById = async (id: string) => {
  const recording = await prisma.recording.findUnique({
    where: { id },
  })

  if (!recording) throw new AppError(404, 'Recording not found.')
  if (!fs.existsSync(recording.filePath)) {
    throw new AppError(404, 'Recording file no longer exists on disk.')
  }

  return {
    ...recording,
    sizeBytes: Number(recording.sizeBytes),
  }
}

// ─── Delete a recording ───────────────────────────────────────────

export const deleteRecording = async (id: string): Promise<void> => {
  const recording = await prisma.recording.findUnique({
    where: { id },
  })

  if (!recording) throw new AppError(404, 'Recording not found.')

  // Delete file from disk first
  try {
    if (fs.existsSync(recording.filePath)) {
      fs.unlinkSync(recording.filePath)
    }
  } catch (err) {
    throw new AppError(500, `Failed to delete recording file: ${String(err)}`)
  }

  // Delete from DB
  await prisma.recording.delete({ where: { id } })
}

// ─── Serve recording file with range support ──────────────────────
// Range support is required for browser video seeking to work

export const getRecordingStream = async (id: string, rangeHeader?: string) => {
  const recording = await getRecordingById(id)
  const filePath = recording.filePath
  const fileSize = Number(recording.sizeBytes) || fs.statSync(filePath).size

  if (!rangeHeader) {
    // No range — serve full file
    return {
      stream: fs.createReadStream(filePath),
      headers: {
        'Content-Length': fileSize,
        'Content-Type': 'video/mp4',
        'Accept-Ranges': 'bytes',
      },
      statusCode: 200,
    }
  }

  // Parse range header: "bytes=start-end"
  const parts = rangeHeader.replace(/bytes=/, '').split('-')
  const start = parseInt(parts[0], 10)
  const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1
  const chunkSize = end - start + 1

  return {
    stream: fs.createReadStream(filePath, { start, end }),
    headers: {
      'Content-Range': `bytes ${start}-${end}/${fileSize}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': chunkSize,
      'Content-Type': 'video/mp4',
    },
    statusCode: 206,  // Partial Content
  }
}

// ─── Storage stats ────────────────────────────────────────────────

export const getStorageStats = async () => {
  const result = await prisma.recording.aggregate({
    _sum: { sizeBytes: true },
    _count: { id: true },
  })

  const totalSizeBytes = Number(result._sum.sizeBytes ?? 0)
  const totalFiles = result._count.id

  // Check available disk space on recordings drive
  const recordingsPath = env.RECORDINGS_PATH
  let availableBytes = 0
  try {
    // Read available space from the recordings directory
    const stats = fs.statfsSync(recordingsPath)
    availableBytes = stats.bfree * stats.bsize
  } catch {
    availableBytes = 0
  }

  return {
    totalFiles,
    totalSizeBytes,
    totalSizeGB: (totalSizeBytes / 1024 / 1024 / 1024).toFixed(2),
    availableBytes,
    availableGB: (availableBytes / 1024 / 1024 / 1024).toFixed(2),
  }
}