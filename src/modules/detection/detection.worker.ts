import { Worker, Job } from 'bullmq'
import { connection, detectionQueue } from '../../config/bullmq.js'
import { runDetectionForNVR } from './detection.service.js'
import logger from '../../utils/logger.js'

let worker: Worker | null = null

const POLL_INTERVAL = 30_000 // 30 seconds

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
  await detectionQueue.add(
    'poll-nvr',
    { nvrId },
    {
      repeat: { every: POLL_INTERVAL },
      jobId: nvrId, 
    }
  )
}

/** Remove an NVR from the repeatable detection queue */
export const removeActiveNVR = async (nvrId: string): Promise<void> => {
  const jobs = await detectionQueue.getRepeatableJobs()
  const job = jobs.find((j) => j.id === nvrId)
  
  if (job) {
    await detectionQueue.removeRepeatableByKey(job.key)
  }
}

/** Check if an NVR is currently in the repeatable queue */
export const isNVRActive = async (nvrId: string): Promise<boolean> => {
  const jobs = await detectionQueue.getRepeatableJobs()
  return jobs.some((j) => j.id === nvrId)
}

/** Return all NVR IDs currently being polled */
export const getAllActiveNVRs = async (): Promise<string[]> => {
  const jobs = await detectionQueue.getRepeatableJobs()
  // By default, BullMQ stores the ID in the jobs list
  return jobs.map((j) => j.id).filter((id): id is string => !!id)
}