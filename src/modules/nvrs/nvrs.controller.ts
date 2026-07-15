import { Response, NextFunction } from 'express'
import { z } from 'zod'
import { AuthRequest } from '../../middleware/auth.js'
import { AppError } from '../../middleware/errorHandler.js'
import {
  getNVRsByStation,
  getNVRById,
  createNVR,
  updateNVR,
  deleteNVR,
  getAllNVRs,
} from './nvrs.service.js'
import { addNvrHeartbeat, removeNvrHeartbeat } from '../detection/nvr-heartbeat.worker.js'
import { addCameraStatusPolling, removeCameraStatusPolling } from '../detection/camera-status.worker.js'
import { runNvrHeartbeat, runCameraStatusCheck } from '../detection/detection.service.js'

const createNVRSchema = z.object({
  name: z.string().min(1, 'Name is required.'),
  ip: z.string().regex(
    /^(\d{1,3}\.){3}\d{1,3}$/,
    'Invalid IP address.'
  ),
  type: z.enum(['HIKVISION', 'HIFOCUS']),
  rtspPort: z.number().default(554),
  httpPort: z.number().default(80),
  username: z.string().default('admin'),
  password: z.string().min(1, 'Password is required.'),
  stationName: z.string().min(1, 'Station name is required.'),
  stationCity: z.string().min(1, 'Station city is required.'),
})

const updateNVRSchema = createNVRSchema.partial()

export const getAll = async (
  _req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const nvrs = await getAllNVRs()
    res.status(200).json(nvrs)
  } catch (err) {
    next(err)
  }
}

export const getByStation = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const stationId = req.params.stationId as string

    const nvrs = await getNVRsByStation(stationId)

    res.status(200).json(nvrs)
  } catch (err) {
    next(err)
  }
}

export const getById = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const id = req.params.id as string
    const nvr = await getNVRById(id)

    res.status(200).json(nvr)
  } catch (err) {
    next(err)
  }
}

export const create = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const parsed = createNVRSchema.safeParse(req.body)

    if (!parsed.success) {
      throw new AppError(400, parsed.error.issues[0].message)
    }

    const nvr = await createNVR(parsed.data)

    // Schedule BOTH always-on background jobs. This is the only place
    // (besides boot reconciliation) these should ever be scheduled —
    // detection.controller.ts's start/stop routes never touch these.
    await addNvrHeartbeat(nvr.id)
    await addCameraStatusPolling(nvr.id)

    // Run both once immediately so the UI isn't waiting up to 15s for
    // the first result after creating an NVR.
    await runNvrHeartbeat(nvr.id)
    await runCameraStatusCheck(nvr.id)

    res.status(201).json(nvr)
  } catch (err) {
    next(err)
  }
}

export const update = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const parsed = updateNVRSchema.safeParse(req.body)

    if (!parsed.success) {
      throw new AppError(400, parsed.error.issues[0].message)
    }

    const id = req.params.id as string

    const nvr = await updateNVR(id, parsed.data)

    res.status(200).json(nvr)
  } catch (err) {
    next(err)
  }
}

export const remove = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const id = req.params.id as string

    await deleteNVR(id)

    // Tear down both always-on jobs. This — NVR deletion — is the only
    // legitimate way monitoring for an NVR should ever stop.
    await removeNvrHeartbeat(id)
    await removeCameraStatusPolling(id)

    res.status(200).json({
      message: 'NVR deleted successfully.',
    })
  } catch (err) {
    next(err)
  }
}