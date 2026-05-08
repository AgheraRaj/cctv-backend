import { Queue, ConnectionOptions } from 'bullmq'
import { env } from './env.js'

export const connection: ConnectionOptions = {
  host: new URL(env.REDIS_URL).hostname,
  port: parseInt(new URL(env.REDIS_URL).port || '6379'),
  password: new URL(env.REDIS_URL).password || undefined,
}

export const detectionQueue = new Queue('detection-queue', {
  connection,
  defaultJobOptions: {
    attempts: 3,
    backoff: {
      type: 'exponential',
      delay: 5000,
    },
    removeOnComplete: true,
    removeOnFail: 1000, // Keep failed jobs for some time for debugging
  },
})

console.log('✅ BullMQ Detection Queue initialized')
