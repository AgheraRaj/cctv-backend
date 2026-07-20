// src/modules/detection/nvr-heartbeat.worker.ts
//
// Always-on NVR reachability polling. This queue's lifecycle is tied
// ONLY to NVR create/delete and boot-time reconciliation. Nothing in
// detection.controller.ts (the routes the frontend calls on page
// enter/exit) touches this file — that separation is the fix for
// heartbeat dying when a user navigates away from the NVR page.

import { Worker, Job } from 'bullmq'
import { connection, nvrHeartbeatQueue } from '../../config/bullmq.js'
import { runNvrHeartbeat } from './detection.service.js'
import { addAuditLog } from '../audit/audit.queue.js'
import redis from '../../config/redis.js'
import prisma from '../../config/db.js'

let worker: Worker | null = null

const POLL_INTERVAL = 15_000 // 15s — per the 10-15s NVR health-check requirement

const ACTIVE_SET_KEY = 'heartbeat:active-nvrs'
const REPEAT_KEY_HASH = 'heartbeat:repeat-keys'

// ─── Start / Stop Worker ─────────────────────────────────

export const startNvrHeartbeatWorker = (): void => {
  if (worker) return

  console.log('NVR Heartbeat Worker started (always-on, independent of UI sessions)')

  worker = new Worker(
    'nvr-heartbeat-queue',
    async (job: Job) => {
      const { nvrId } = job.data
      await runNvrHeartbeat(nvrId)
    },
    {
      connection,
      concurrency: 50,
    }
  )

  worker.on('failed', (job, err) => {
    console.error(`[Heartbeat ${job?.id}] failed for NVR ${job?.data?.nvrId}: ${err.message}`)
    addAuditLog({
      action: 'WORKER_JOB_FAILED',
      resourceType: 'NVR',
      resourceId: job?.data?.nvrId,
      newValues: { jobId: job?.id, error: err.message },
    })
  })
}

export const stopNvrHeartbeatWorker = async (): Promise<void> => {
  if (!worker) return
  await worker.close()
  worker = null
  console.log('NVR Heartbeat Worker stopped')
}

// ─── Queue Management Helpers ─────────────────────────────

/** Schedule always-on heartbeat polling for an NVR. Call from NVR create only. */
export const addNvrHeartbeat = async (nvrId: string): Promise<void> => {
  const job = await nvrHeartbeatQueue.add(
    'heartbeat',
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

/** Stop heartbeat polling for an NVR. Call from NVR delete ONLY — never from
 *  a page-visit endpoint. */
export const removeNvrHeartbeat = async (nvrId: string): Promise<void> => {
  const savedKey = await redis.hget(REPEAT_KEY_HASH, nvrId)

  if (savedKey) {
    await nvrHeartbeatQueue.removeRepeatableByKey(savedKey)
    await redis.hdel(REPEAT_KEY_HASH, nvrId)
  } else {
    const jobs = await nvrHeartbeatQueue.getRepeatableJobs()
    const job = jobs.find((j) => j.id === nvrId)
    if (job) {
      await nvrHeartbeatQueue.removeRepeatableByKey(job.key)
    }
  }

  await redis.srem(ACTIVE_SET_KEY, nvrId)
}

export const isNvrHeartbeatActive = async (nvrId: string): Promise<boolean> => {
  const result = await redis.sismember(ACTIVE_SET_KEY, nvrId)
  return result === 1
}

export const getAllHeartbeatNVRs = async (): Promise<string[]> => {
  return redis.smembers(ACTIVE_SET_KEY)
}

/**
 * Boot-time reconciliation: ensures every NVR in the database has an
 * active heartbeat job. Idempotent — safe to call on every startup.
 * This, plus NVR create/delete, are the ONLY things that should ever
 * add/remove jobs on this queue.
 */
export const reconcileHeartbeatNVRs = async (): Promise<void> => {
  const nvrs = await prisma.nVR.findMany({ select: { id: true, name: true } })
  const currentlyActive = new Set(await getAllHeartbeatNVRs())

  let addedCount = 0
  for (const nvr of nvrs) {
    if (!currentlyActive.has(nvr.id)) {
      await addNvrHeartbeat(nvr.id)
      addedCount++
      console.warn(`NVR "${nvr.name}" (${nvr.id}) was not in the heartbeat queue — added it now`)
    }
  }

  console.log(
    `Heartbeat queue reconciliation complete: ${nvrs.length} total NVRs, ${addedCount} newly scheduled, ${nvrs.length - addedCount} already active`
  )
}