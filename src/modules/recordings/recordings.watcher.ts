import fs from 'fs'
import path from 'path'
import prisma from '../../config/db.js'
import { env } from '../../config/env.js'
import logger from '../../utils/logger.js'

const parseFilename = (filename: string): Date | null => {
  const match = filename.match(/^(\d{4}-\d{2}-\d{2})_(\d{2}-\d{2}-\d{2})\.mp4$/)
  if (!match) return null

  const [, datePart, timePart] = match
  const isoString = `${datePart}T${timePart.replace(/-/g, ':')}Z`
  const date = new Date(isoString)

  return isNaN(date.getTime()) ? null : date
}

const parsePathName = (folderName: string): { nvrId: string; channel: number } | null => {
  const match = folderName.match(/^(.+)-ch(\d+)$/)
  if (!match) return null

  const nvrId = match[1]
  const channel = parseInt(match[2], 10)

  if (isNaN(channel)) return null
  return { nvrId, channel }
}

const getFileSizeBytes = (filePath: string): bigint => {
  try {
    return BigInt(fs.statSync(filePath).size)
  } catch {
    return BigInt(0)
  }
}

const handleNewFile = async (folderName: string, filename: string): Promise<void> => {
  if (!filename.endsWith('.mp4')) return

  const parsed = parsePathName(folderName)
  if (!parsed) return

  const { nvrId, channel } = parsed
  const startTime = parseFilename(filename)
  if (!startTime) return

  const filePath = path.join(env.RECORDINGS_PATH, folderName, filename)

  const camera = await prisma.camera.findUnique({
    where: { nvrId_channel: { nvrId, channel } },
  })

  if (!camera) {
    logger.warn(`Recordings watcher — no camera found for ${folderName}`)
    return
  }

  const existing = await prisma.recording.findFirst({
    where: { filePath },
  })
  if (existing) return

  await prisma.recording.create({
    data: {
      cameraId: camera.id,
      nvrId,
      channel,
      filename,
      filePath,
      startTime,
      sizeBytes: getFileSizeBytes(filePath),
    },
  })

  logger.info(`New recording saved: ${folderName}/${filename}`)
}

// ─── End Time Detection ───────────────────────────────────────────
// When MediaMTX finishes a segment it stops writing to that file
// We detect this by checking if file size stopped growing

const pendingEndTimeChecks = new Map<string, { size: bigint; timer: NodeJS.Timeout }>()

const scheduleEndTimeCheck = (filePath: string): void => {
  const existing = pendingEndTimeChecks.get(filePath)
  if (existing) {
    clearTimeout(existing.timer)
  }

  const currentSize = getFileSizeBytes(filePath)

  const timer = setTimeout(async () => {
    const newSize = getFileSizeBytes(filePath)

    // If size hasn't changed in 60 seconds — file is complete
    if (newSize === currentSize && newSize > BigInt(0)) {
      try {
        const recording = await prisma.recording.findFirst({
          where: { filePath, endTime: null },
        })

        if (recording) {
          // Estimate endTime from file duration
          // MediaMTX segments are exactly 1 hour by default
          const endTime = new Date(recording.startTime.getTime() + 60 * 60 * 1000)

          await prisma.recording.update({
            where: { id: recording.id },
            data: {
              endTime,
              sizeBytes: newSize,
            },
          })

          logger.info(`Recording completed: ${path.basename(filePath)} (${Number(newSize) / 1024 / 1024} MB)`)
        }
      } catch (err) {
        logger.error(`End time check failed: ${String(err)}`)
      }
    }

    pendingEndTimeChecks.delete(filePath)
  }, 60_000)  // check after 60 seconds of no changes

  pendingEndTimeChecks.set(filePath, { size: currentSize, timer })
}

const watchCameraFolder = (folderName: string, folderPath: string): void => {
  fs.watch(folderPath, async (eventType, filename) => {
    if (!filename) return

    const filePath = path.join(folderPath, filename)

    if (eventType === 'rename') {
      // New file created
      setTimeout(async () => {
        try {
          if (fs.existsSync(filePath)) {
            await handleNewFile(folderName, filename)
          }
        } catch (err) {
          logger.error(`Recordings watcher error: ${String(err)}`)
        }
      }, 2000)
    }

    if (eventType === 'change' && filename.endsWith('.mp4')) {
      // File is being written — schedule end time check
      scheduleEndTimeCheck(filePath)
    }
  })

  // Schedule end time checks for any existing incomplete recordings in this folder
  try {
    const files = fs.readdirSync(folderPath)
    for (const file of files) {
      if (file.endsWith('.mp4')) {
        scheduleEndTimeCheck(path.join(folderPath, file))
      }
    }
  } catch {}

  logger.info(`Watching recordings folder: ${folderPath}`)
}

export const startRecordingsWatcher = (): void => {
  const recordingsPath = env.RECORDINGS_PATH

  if (!fs.existsSync(recordingsPath)) {
    fs.mkdirSync(recordingsPath, { recursive: true })
  }

  const entries = fs.readdirSync(recordingsPath, { withFileTypes: true })
  for (const entry of entries) {
    if (entry.isDirectory()) {
      watchCameraFolder(entry.name, path.join(recordingsPath, entry.name))
    }
  }

  fs.watch(recordingsPath, (eventType, folderName) => {
    if (!folderName || eventType !== 'rename') return

    const folderPath = path.join(recordingsPath, folderName)

    setTimeout(() => {
      try {
        if (fs.existsSync(folderPath) && fs.statSync(folderPath).isDirectory()) {
          watchCameraFolder(folderName, folderPath)
        }
      } catch (err) {
        logger.error(`Recordings watcher root error: ${String(err)}`)
      }
    }, 1000)
  })

  logger.info(`Recordings watcher started on ${recordingsPath}`)
}

export const syncRecordingSizes = async (): Promise<void> => {
  const recordings = await prisma.recording.findMany({
    where: { endTime: null },
  })

  for (const recording of recordings) {
    try {
      if (!fs.existsSync(recording.filePath)) {
        await prisma.recording.update({
          where: { id: recording.id },
          data: { endTime: new Date() },
        })
        continue
      }

      const size = getFileSizeBytes(recording.filePath)
      await prisma.recording.update({
        where: { id: recording.id },
        data: { sizeBytes: size },
      })
    } catch (err) {
      logger.error(`syncRecordingSizes error: ${String(err)}`)
    }
  }
}