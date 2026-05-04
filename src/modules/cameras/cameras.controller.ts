import { Response, NextFunction } from 'express'
import { z } from 'zod'
import { AuthRequest } from '../../middleware/auth.js'
import { AppError } from '../../middleware/errorHandler.js'
import {
  getCameraSlots,
  getCameraById,
  createCamera,
  updateCamera,
  deleteCamera,
} from './cameras.service.js'

const createCameraSchema = z.object({
  channel: z.number().int().min(1, 'Channel must be at least 1.'),
  name: z.string().min(1, 'Name is required.'),
  areaTag: z.string().optional(),
  isActive: z.boolean().default(true),
})

const updateCameraSchema = createCameraSchema.partial()

export const getSlots = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const nvrId = req.params.nvrId as string
    const slots = await getCameraSlots(nvrId)
    res.status(200).json(slots)
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
    const camera = await getCameraById(id)
    res.status(200).json(camera)
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
    const nvrId = req.params.nvrId as string
    const parsed = createCameraSchema.safeParse(req.body)
    if (!parsed.success) {
      throw new AppError(400, parsed.error.issues[0].message)
    }

    const camera = await createCamera(nvrId, parsed.data)
    res.status(201).json(camera)
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
    const id = req.params.id as string
    const parsed = updateCameraSchema.safeParse(req.body)
    if (!parsed.success) {
      throw new AppError(400, parsed.error.issues[0].message)
    }

    const camera = await updateCamera(id, parsed.data)
    res.status(200).json(camera)
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
    await deleteCamera(id)
    res.status(200).json({ message: 'Camera deleted successfully.' })
  } catch (err) {
    next(err)
  }
}