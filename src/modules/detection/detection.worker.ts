// src/modules/detection/detection.worker.ts
import { Worker, Job } from 'bullmq'
import { connection, detectionQueue } from '../../config/bullmq.js'
import { runDetectionForNVR } from './detection.service.js'
import logger from '../../utils/logger.js'
import redis from '../../config/redis.js'

let worker: Worker | null = null

const POLL_INTERVAL = 30_000 // 30 seconds

const ACTIVE_SET_KEY = 'detection:active-nvrs'
const REPEAT_KEY_HASH = 'detection:repeat-keys'

// ─── Start / Stop Worker ─────────────────────────────────

export const startDetectionWorker = (): void => {
  if (worker) return // already running

  logger.info('Detection BullMQ Worker started (High-Scale mode)')

  worker = new Worker(
    'detection-queue',
    async (job: Job) => {
      const { nvrId } = job.data
      await runDetectionForNVR(nvrId)
    },
    {
      connection,
      concurrency: 50, // Industry standard: handle multiple jobs in parallel
    }
  )

  worker.on('failed', (job, err) => {
    logger.error(`[Job ${job?.id}] Detection failed for NVR ${job?.data?.nvrId}: ${err.message}`)
  })
}

export const stopDetectionWorker = async (): Promise<void> => {
  if (!worker) return
  await worker.close()
  worker = null
  logger.info('Detection BullMQ Worker stopped')
}

// ─── Queue Management Helpers ─────────────────────────────

/** Add an NVR to the repeatable detection queue */
export const addActiveNVR = async (nvrId: string): Promise<void> => {
  // jobId: nvrId ensures we don't add the same NVR twice
  const job = await detectionQueue.add(
    'poll-nvr',
    { nvrId },
    {
      repeat: { every: POLL_INTERVAL },
      jobId: nvrId,
    }
  )

  // BullMQ's own repeatable-job id matching is unreliable — track state ourselves.
  await redis.sadd(ACTIVE_SET_KEY, nvrId)

  // job.repeatJobKey is the exact key BullMQ uses internally for this repeatable
  // job config — save it so removal is exact instead of guessing via id match.
  if (job.repeatJobKey) {
    await redis.hset(REPEAT_KEY_HASH, nvrId, job.repeatJobKey)
  }
}

/** Remove an NVR from the repeatable detection queue */
export const removeActiveNVR = async (nvrId: string): Promise<void> => {
  const savedKey = await redis.hget(REPEAT_KEY_HASH, nvrId)

  if (savedKey) {
    await detectionQueue.removeRepeatableByKey(savedKey)
    await redis.hdel(REPEAT_KEY_HASH, nvrId)
  } else {
    // Fallback for jobs added before this change (no saved key yet)
    const jobs = await detectionQueue.getRepeatableJobs()
    const job = jobs.find((j) => j.id === nvrId)
    if (job) {
      await detectionQueue.removeRepeatableByKey(job.key)
    }
  }

  await redis.srem(ACTIVE_SET_KEY, nvrId)
}

/** Check if an NVR is currently in the repeatable queue */
export const isNVRActive = async (nvrId: string): Promise<boolean> => {
  const result = await redis.sismember(ACTIVE_SET_KEY, nvrId)
  return result === 1
}

/** Return all NVR IDs currently being polled */
export const getAllActiveNVRs = async (): Promise<string[]> => {
  return redis.smembers(ACTIVE_SET_KEY)
}