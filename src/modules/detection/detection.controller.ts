import { Response, NextFunction } from 'express'
import { AuthRequest } from '../../middleware/auth.js'
import { AppError } from '../../middleware/errorHandler.js'
import {
  addActiveNVR,
  removeActiveNVR,
  isNVRActive,
  getAllActiveNVRs,
} from './detection.worker.js'
import { runDetectionForNVR } from './detection.service.js'
import prisma from '../../config/db.js'

// ─── Start Detection ──────────────────────────────────────

export const startDetection = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const nvrId = req.params.nvrId as string

    // Verify NVR exists
    const nvr = await prisma.nVR.findUnique({ where: { id: nvrId } })
    if (!nvr) throw new AppError(404, 'NVR not found.')

    // Add to active set (idempotent — safe to call again if already active)
    await addActiveNVR(nvrId)

    // Run first detection immediately — don't wait 30s for first result
    await runDetectionForNVR(nvrId)

    res.status(200).json({
      message: `Detection started for NVR "${nvr.name}".`,
      nvrId,
    })
  } catch (err) {
    next(err)
  }
}

// ─── Stop Detection ───────────────────────────────────────

export const stopDetection = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const nvrId = req.params.nvrId as string

    const active = await isNVRActive(nvrId)
    if (!active) {
      throw new AppError(400, 'Detection is not running for this NVR.')
    }

    await removeActiveNVR(nvrId)

    res.status(200).json({
      message: 'Detection stopped.',
      nvrId,
    })
  } catch (err) {
    next(err)
  }
}

// ─── Per-NVR Status ───────────────────────────────────────

export const getDetectionStatus = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const nvrId = req.params.nvrId as string
    const active = await isNVRActive(nvrId)

    res.status(200).json({
      nvrId,
      isRunning: active,
    })
  } catch (err) {
    next(err)
  }
}

// ─── All Active NVRs ──────────────────────────────────────

export const getActiveDetection = async (
  _req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const nvrIds = await getAllActiveNVRs()

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