// src/modules/detection/camera-status.worker.ts
//
// Always-on per-channel camera status polling for NVRs that are
// currently reachable. Same lifecycle rule as the heartbeat worker:
// scheduled from NVR create/delete and boot reconciliation only.
// detection.controller.ts (page-visit start/stop) never touches this.

import { Worker, Job } from 'bullmq'
import { connection, cameraStatusQueue } from '../../config/bullmq.js'
import { runCameraStatusCheck } from './detection.service.js'
import logger from '../../utils/logger.js'
import redis from '../../config/redis.js'
import prisma from '../../config/db.js'

let worker: Worker | null = null

const POLL_INTERVAL = 15_000 // 15s — per the 10-15s camera health-check requirement

const ACTIVE_SET_KEY = 'camera-status:active-nvrs'
const REPEAT_KEY_HASH = 'camera-status:repeat-keys'

// ─── Start / Stop Worker ─────────────────────────────────

export const startCameraStatusWorker = (): void => {
  if (worker) return

  logger.info('Camera Status Worker started (always-on, independent of UI sessions)')

  worker = new Worker(
    'camera-status-queue',
    async (job: Job) => {
      const { nvrId } = job.data
      await runCameraStatusCheck(nvrId)
    },
    {
      connection,
      concurrency: 50,
    }
  )

  worker.on('failed', (job, err) => {
    logger.error(`[CameraStatus ${job?.id}] failed for NVR ${job?.data?.nvrId}: ${err.message}`)
  })
}

export const stopCameraStatusWorker = async (): Promise<void> => {
  if (!worker) return
  await worker.close()
  worker = null
  logger.info('Camera Status Worker stopped')
}

// ─── Queue Management Helpers ─────────────────────────────

/** Schedule always-on camera status polling for an NVR. Call from NVR create only. */
export const addCameraStatusPolling = async (nvrId: string): Promise<void> => {
  const job = await cameraStatusQueue.add(
    'camera-status',
    { nvrId },
    {
      repeat: { every: POLL_INTERVAL },
      jobId: nvrId,
    }
  )

  await redis.sadd(ACTIVE_SET_KEY, nvrId)

  if (job.repeatJobKey) {
    await redis.hset(REPEAT_KEY_HASH, nvrId, job.repeatJobKey)
  }
}

/** Stop camera status polling for an NVR. Call from NVR delete ONLY — never
 *  from a page-visit endpoint. */
export const removeCameraStatusPolling = async (nvrId: string): Promise<void> => {
  const savedKey = await redis.hget(REPEAT_KEY_HASH, nvrId)

  if (savedKey) {
    await cameraStatusQueue.removeRepeatableByKey(savedKey)
    await redis.hdel(REPEAT_KEY_HASH, nvrId)
  } else {
    const jobs = await cameraStatusQueue.getRepeatableJobs()
    const job = jobs.find((j) => j.id === nvrId)
    if (job) {
      await cameraStatusQueue.removeRepeatableByKey(job.key)
    }
  }

  await redis.srem(ACTIVE_SET_KEY, nvrId)
}

export const isCameraStatusActive = async (nvrId: string): Promise<boolean> => {
  const result = await redis.sismember(ACTIVE_SET_KEY, nvrId)
  return result === 1
}

export const getAllCameraStatusNVRs = async (): Promise<string[]> => {
  return redis.smembers(ACTIVE_SET_KEY)
}

/**
 * Boot-time reconciliation: ensures every NVR in the database has an
 * active camera-status job. Idempotent — safe to call on every startup.
 */
export const reconcileCameraStatusNVRs = async (): Promise<void> => {
  const nvrs = await prisma.nVR.findMany({ select: { id: true, name: true } })
  const currentlyActive = new Set(await getAllCameraStatusNVRs())

  let addedCount = 0
  for (const nvr of nvrs) {
    if (!currentlyActive.has(nvr.id)) {
      await addCameraStatusPolling(nvr.id)
      addedCount++
      logger.warn(`NVR "${nvr.name}" (${nvr.id}) was not in the camera-status queue — added it now`)
    }
  }

  logger.info(
    `Camera status queue reconciliation complete: ${nvrs.length} total NVRs, ${addedCount} newly scheduled, ${nvrs.length - addedCount} already active`
  )
}