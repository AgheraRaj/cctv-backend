import redis from '../../config/redis.js'
import { runDetectionForNVR } from './detection.service.js'
import logger from '../../utils/logger.js'

const ACTIVE_NVR_KEY = 'detection:active:nvr'
const INTERVAL_MS = 30_000  // 30 seconds

let workerInterval: NodeJS.Timeout | null = null

// ─── Start / Stop Worker ─────────────────────────────────

export const startDetectionWorker = (): void => {
  if (workerInterval) return  // already running

  logger.info('Detection worker started')

  workerInterval = setInterval(async () => {
    await runDetectionCycle()
  }, INTERVAL_MS)
}

export const stopDetectionWorker = (): void => {
  if (!workerInterval) return

  clearInterval(workerInterval)
  workerInterval = null
  logger.info('Detection worker stopped')
}

// ─── One Detection Cycle ─────────────────────────────────

const runDetectionCycle = async (): Promise<void> => {
  try {
    const nvrId = await redis.get(ACTIVE_NVR_KEY)

    if (!nvrId) return  // no NVR selected — skip this cycle

    logger.info(`Running detection for NVR ${nvrId}`)
    await runDetectionForNVR(nvrId)
  } catch (err) {
    // Worker must never crash — log and continue
    logger.error(`Detection cycle failed: ${String(err)}`)
  }
}

// ─── Redis Helpers — used by controller ──────────────────

export const setActiveNVR = async (nvrId: string): Promise<void> => {
  await redis.set(ACTIVE_NVR_KEY, nvrId)
}

export const clearActiveNVR = async (): Promise<void> => {
  await redis.del(ACTIVE_NVR_KEY)
}

export const getActiveNVR = async (): Promise<string | null> => {
  return redis.get(ACTIVE_NVR_KEY)
}