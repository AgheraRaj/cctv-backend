import prisma from '../../config/db.js'
import { AppError } from '../../middleware/errorHandler.js'

export const getAllStations = async () => {
  return prisma.station.findMany({
    orderBy: { createdAt: 'desc' },
    include: {
      _count: { select: { nvrs: true } },  // returns how many NVRs each station has
    },
  })
}

export const getStationById = async (id: string) => {
  const station = await prisma.station.findUnique({
    where: { id },
    include: {
      _count: { select: { nvrs: true } },
    },
  })

  if (!station) {
    throw new AppError(404, 'Station not found.')
  }

  return station
}

export const createStation = async (data: {
  name: string
  city: string
  state: string
}) => {
  return prisma.station.create({ data })
}

export const updateStation = async (
  id: string,
  data: Partial<{ name: string; city: string; state: string }>
) => {
  const existing = await prisma.station.findUnique({ where: { id } })

  if (!existing) {
    throw new AppError(404, 'Station not found.')
  }

  return prisma.station.update({ where: { id }, data })
}

export const deleteStation = async (id: string) => {
  const existing = await prisma.station.findUnique({ where: { id } })

  if (!existing) {
    throw new AppError(404, 'Station not found.')
  }

  // Cascades to NVRs and Cameras automatically (defined in schema)
  return prisma.station.delete({ where: { id } })
}