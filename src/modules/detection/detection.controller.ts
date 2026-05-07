import { Response, NextFunction } from 'express'
import { AuthRequest } from '../../middleware/auth.js'
import { AppError } from '../../middleware/errorHandler.js'
import { setActiveNVR, clearActiveNVR, getActiveNVR } from './detection.worker.js'
import { runDetectionForNVR } from './detection.service.js'
import prisma from '../../config/db.js'

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

    // Check if another NVR is already being detected
    const currentActiveNVR = await getActiveNVR()
    if (currentActiveNVR && currentActiveNVR !== nvrId) {
      throw new AppError(
        409,
        `Detection already running for another NVR. Stop it first.`
      )
    }

    // Set this NVR as active
    await setActiveNVR(nvrId)

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

export const stopDetection = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const nvrId = req.params.nvrId as string

    const currentActiveNVR = await getActiveNVR()

    if (!currentActiveNVR) {
      throw new AppError(400, 'No detection is currently running.')
    }

    if (currentActiveNVR !== nvrId) {
      throw new AppError(400, 'Detection is running for a different NVR.')
    }

    await clearActiveNVR()

    res.status(200).json({
      message: 'Detection stopped.',
      nvrId,
    })
  } catch (err) {
    next(err)
  }
}

export const getDetectionStatus = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const nvrId = req.params.nvrId as string
    const activeNVR = await getActiveNVR()

    res.status(200).json({
      nvrId,
      isRunning: activeNVR === nvrId,
      activeNvrId: activeNVR ?? null,
    })
  } catch (err) {
    next(err)
  }
}

export const getActiveDetection = async (
  _req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const activeNVR = await getActiveNVR()

    if (!activeNVR) {
      res.status(200).json({ isRunning: false, activeNvrId: null })
      return
    }

    const nvr = await prisma.nVR.findUnique({
      where: { id: activeNVR },
      select: { id: true, name: true, ip: true, status: true, lastSeenAt: true },
    })

    res.status(200).json({
      isRunning: true,
      activeNvrId: activeNVR,
      nvr,
    })
  } catch (err) {
    next(err)
  }
}