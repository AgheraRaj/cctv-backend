// src/modules/detection/detection.controller.ts
//
// These routes are called by the frontend on NVR page enter (`start`)
// and page exit (`stop`). They intentionally control NO background
// scheduling anymore. NVR heartbeat and camera status polling run
// continuously for every NVR from creation to deletion — see
// nvr-heartbeat.worker.ts and camera-status.worker.ts. Route paths are
// unchanged so the existing frontend calls don't need to change.

import { Response, NextFunction } from 'express'
import { AuthRequest } from '../../middleware/auth.js'
import { AppError } from '../../middleware/errorHandler.js'
import prisma from '../../config/db.js'
import { runCameraStatusCheck } from './detection.service.js'
import { isNvrHeartbeatActive, getAllHeartbeatNVRs } from './nvr-heartbeat.worker.js'

// ─── "Start" — one-off refresh, not a scheduler toggle ────

export const startDetection = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const nvrId = req.params.nvrId as string

    const nvr = await prisma.nVR.findUnique({ where: { id: nvrId } })
    if (!nvr) throw new AppError(404, 'NVR not found.')

    // Give the UI a fresh camera list/status immediately on page open
    // instead of waiting for the next scheduled cycle. This is a single
    // one-off call — it does NOT start, stop, or otherwise touch any
    // recurring job. Background monitoring for this NVR was already
    // running before this request and continues regardless of it.
    await runCameraStatusCheck(nvrId)

    res.status(200).json({
      message: `Camera status refreshed for NVR "${nvr.name}".`,
      nvrId,
    })
  } catch (err) {
    next(err)
  }
}

// ─── "Stop" — deliberate no-op ─────────────────────────────

export const stopDetection = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const nvrId = req.params.nvrId as string

    const nvr = await prisma.nVR.findUnique({ where: { id: nvrId } })
    if (!nvr) throw new AppError(404, 'NVR not found.')

    // Intentionally does nothing to any scheduler. Leaving the NVR page
    // must never stop NVR or camera health monitoring — this endpoint
    // exists only so the current frontend call has somewhere to land
    // without needing a frontend change.
    res.status(200).json({
      message: 'NVR page closed. Background health monitoring continues unaffected.',
      nvrId,
    })
  } catch (err) {
    next(err)
  }
}

// ─── Per-NVR Status ───────────────────────────────────────
// Now reports the heartbeat queue's state, since that's what "is this
// NVR actively being monitored" actually means post-refactor.

export const getDetectionStatus = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const nvrId = req.params.nvrId as string
    const active = await isNvrHeartbeatActive(nvrId)

    res.status(200).json({
      nvrId,
      isRunning: active,
    })
  } catch (err) {
    next(err)
  }
}

// ─── All Actively-Monitored NVRs ───────────────────────────

export const getActiveDetection = async (
  _req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const nvrIds = await getAllHeartbeatNVRs()

    if (!nvrIds.length) {
      res.status(200).json({ isRunning: false, activeNvrIds: [] })
      return
    }

    const nvrs = await prisma.nVR.findMany({
      where: { id: { in: nvrIds } },
      select: { id: true, name: true, ip: true, status: true, lastSeenAt: true },
    })

    res.status(200).json({
      isRunning: true,
      activeNvrIds: nvrIds,
      nvrs,
    })
  } catch (err) {
    next(err)
  }
}