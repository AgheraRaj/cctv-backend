import http from 'http'
import express from 'express'
import cors from 'cors'
import helmet from 'helmet'
import rateLimit from 'express-rate-limit'
import { env } from './config/env.js'
import redis from './config/redis.js'
import { errorHandler } from './middleware/errorHandler.js'
import logger from './utils/logger.js'
import { initSocketService } from './services/socketService.js'

// ─── Route Imports ─────────────────────────────────────────────────
import authRoutes from './modules/auth/auth.routes.js'
import nvrRoutes from './modules/nvrs/nvrs.routes.js'
import cameraRoutes from './modules/cameras/cameras.routes.js'
import streamRoutes from './modules/streams/streams.routes.js'
import detectionRoutes from './modules/detection/detection.routes.js'
import detectionGlobalRoutes from './modules/detection/detection.global.routes.js'
import playbackRoutes from './modules/playback/playback.routes.js'

// ─── Worker Imports ────────────────────────────────────────────────
// Two independent always-on workers. Neither is started, stopped, or
// otherwise controlled by the frontend's page-visit detection routes.
import {
  startNvrHeartbeatWorker,
  stopNvrHeartbeatWorker,
  reconcileHeartbeatNVRs,
} from './modules/detection/nvr-heartbeat.worker.js'
import {
  startCameraStatusWorker,
  stopCameraStatusWorker,
  reconcileCameraStatusNVRs,
} from './modules/detection/camera-status.worker.js'

const app = express()

// ─── Security Middleware ───────────────────────────────────────────
app.use(helmet())
app.use(cors({
  origin: env.NODE_ENV === 'production' ? 'https://yourdomain.com' : '*',
  credentials: true,
}))

// ─── Rate Limiting ─────────────────────────────────────────────────
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 500,
  message: { error: 'Too many requests, please try again later.' },
})
app.use('/api', limiter)

// ─── Body Parsing ──────────────────────────────────────────────────
app.use(express.json())
app.use(express.urlencoded({ extended: true }))

// ─── Request Logger ────────────────────────────────────────────────
app.use((req, _res, next) => {
  logger.info({
    message: 'Incoming request',
    method: req.method,
    path: req.path,
    ip: req.ip,
  })
  next()
})

// ─── Health Check ──────────────────────────────────────────────────
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() })
})

// ─── Routes ────────────────────────────────────────────────────────
app.use('/api/auth', authRoutes)
app.use('/api/nvrs', nvrRoutes)
app.use('/api/nvrs/:nvrId/cameras', cameraRoutes)
app.use('/api/nvrs/:nvrId/detection', detectionRoutes)
app.use('/api/streams', streamRoutes)
app.use('/api/detection', detectionGlobalRoutes)
app.use('/api/playback', playbackRoutes)

// ─── Global Error Handler (must be last) ───────────────────────────
app.use(errorHandler)

// ─── Start Server ──────────────────────────────────────────────────
let httpServer: http.Server

const start = async () => {
  await redis.connect()

  httpServer = http.createServer(app)
  initSocketService(httpServer)

  // Both workers start unconditionally at boot and run for the
  // lifetime of the process — neither depends on any user having a
  // browser tab open.
  startNvrHeartbeatWorker()
  startCameraStatusWorker()

  // Ensure every NVR already in the database is actually being polled
  // by both queues — without this, NVRs that existed before auto-start
  // was added (or whose job was ever lost) never get checked again
  // automatically.
  await reconcileHeartbeatNVRs()
  await reconcileCameraStatusNVRs()

  httpServer.listen(env.PORT, () => {
    console.log(`✅ Server running on port ${env.PORT} in ${env.NODE_ENV} mode`)
  })
}

// ─── Graceful Shutdown ──────────────────────────────────────────────
// Ensures in-flight heartbeat/camera-status jobs finish cleanly and
// BullMQ locks are released on redeploy/restart, instead of leaving
// stalled jobs that wait out the ~30s stall timeout before recovery.
const shutdown = async (signal: string) => {
  logger.info(`${signal} received — shutting down gracefully`)
  await Promise.all([stopNvrHeartbeatWorker(), stopCameraStatusWorker()])
  httpServer?.close(() => {
    logger.info('HTTP server closed')
    process.exit(0)
  })
}

process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))

start()