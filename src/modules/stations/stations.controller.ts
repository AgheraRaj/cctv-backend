import { Response, NextFunction } from 'express'
import { z } from 'zod'
import { AuthRequest } from '../../middleware/auth.js'
import { AppError } from '../../middleware/errorHandler.js'
import {
  getAllStations,
  getStationById,
  createStation,
  updateStation,
  deleteStation,
} from './stations.service.js'

const createStationSchema = z.object({
  name: z.string().min(1, 'Name is required.'),
  city: z.string().min(1, 'City is required.'),
  state: z.string().min(1, 'State is required.'),
})

const updateStationSchema = createStationSchema.partial()  // all fields optional on update

export const getAll = async (
  _req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const stations = await getAllStations()
    res.status(200).json(stations)
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
    const station = await getStationById(id)
    res.status(200).json(station)
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
    const parsed = createStationSchema.safeParse(req.body)

    if (!parsed.success) {
      throw new AppError(400, parsed.error.issues[0].message)
    }

    const station = await createStation(parsed.data)
    res.status(201).json(station)
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
    const parsed = updateStationSchema.safeParse(req.body)

    if (!parsed.success) {
      throw new AppError(400, parsed.error.issues[0].message)
    }

    const id = req.params.id as string
    const station = await updateStation(id, parsed.data)
    res.status(200).json(station)
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
    await deleteStation(id)
    res.status(200).json({ message: 'Station deleted successfully.' })
  } catch (err) {
    next(err)
  }
}