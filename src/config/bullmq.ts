import { Queue, ConnectionOptions } from 'bullmq'
import { env } from './env.js'

export const connection: ConnectionOptions = {
  host: new URL(env.REDIS_URL).hostname,
  port: parseInt(new URL(env.REDIS_URL).port || '6379'),
  password: new URL(env.REDIS_URL).password || undefined,
}

const defaultJobOptions = {
  attempts: 3,
  backoff: {
    type: 'exponential' as const,
    delay: 5000,
  },
  removeOnComplete: true,
  removeOnFail: 1000, // Keep failed jobs for some time for debugging
}

// ─── NVR Heartbeat Queue ──────────────────────────────────
// Tier 1 reachability check only. One repeatable job per NVR, scheduled
// from NVR create/delete and boot-time reconciliation ONLY. The
// frontend's page-visit start/stop calls (detection.controller.ts) must
// never add or remove jobs on this queue — that coupling was the root
// cause of NVR status freezing when a user navigated away.
export const nvrHeartbeatQueue = new Queue('nvr-heartbeat-queue', {
  connection,
  defaultJobOptions,
})

// ─── Camera Status Queue ──────────────────────────────────
// Tier 2 check: per-channel online/offline status for cameras under a
// currently-reachable NVR. Same lifecycle rules as the heartbeat queue —
// always running once an NVR exists, independent of any UI session.
export const cameraStatusQueue = new Queue('camera-status-queue', {
  connection,
  defaultJobOptions,
})

console.log('✅ BullMQ Heartbeat + Camera Status queues initialized')