import express from 'express'
import cors from 'cors'
import helmet from 'helmet'
import rateLimit from 'express-rate-limit'
import { env } from './config/env.js'
import redis from './config/redis.js'
import { errorHandler } from './middleware/errorHandler.js'
import authRoutes from './modules/auth/auth.routes.js'
import stationRoutes from './modules/stations/stations.routes.js'
import nvrRoutes from './modules/nvrs/nvrs.routes.js'
import cameraRoutes from './modules/cameras/cameras.routes.js'
import streamRoutes from './modules/streams/streams.routes.js'
import logger from './utils/logger.js'

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
  max: 100,
  message: { error: 'Too many requests, please try again later.' },
})
app.use('/api', limiter)

// ─── Body Parsing ──────────────────────────────────────────────────
app.use(express.json())
app.use(express.urlencoded({ extended: true }))

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
app.use('/api/stations', stationRoutes)
app.use('/api/stations/:stationId/nvrs', nvrRoutes)
app.use('/api/nvrs/:nvrId/cameras', cameraRoutes)
app.use('/api/streams', streamRoutes)

// ─── Global Error Handler (must be last) ───────────────────────────
app.use(errorHandler)

// ─── Start Server ──────────────────────────────────────────────────
const start = async () => {
  await redis.connect()
  app.listen(env.PORT, () => {
    console.log(`✅ Server running on port ${env.PORT} in ${env.NODE_ENV} mode`)
  })
}

start()