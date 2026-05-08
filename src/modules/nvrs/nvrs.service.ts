import prisma from "../../config/db.js";
import { AppError } from "../../middleware/errorHandler.js";
import { encrypt } from "../../utils/crypto.js";
import { NVRType } from "@prisma/client";

interface NVRPayload {
  name: string
  ip: string
  type: NVRType
  rtspPort?: number
  httpPort?: number
  username: string
  password: string
  stationName: string
  stationCity: string
}

const nvrSelect = {
  id: true,
  name: true,
  ip: true,
  type: true,
  username: true,
  status: true,
  lastSeenAt: true,
  offlineSince: true,

  station: {
    select: {
      id: true,
      name: true,
      city: true,
    },
  },

  _count: {
    select: {
      cameras: true,
    },
  },
}

export const getAllNVRs = async () => {
  return prisma.nVR.findMany({
    orderBy: {
      createdAt: 'desc',
    },

    select: nvrSelect,
  })
}

export const getNVRsByStation = async (stationId: string) => {
  return prisma.nVR.findMany({
    where: {
      stationId,
    },

    orderBy: {
      createdAt: 'desc',
    },

    select: nvrSelect,
  })
}

export const getNVRById = async (id: string) => {
  const nvr = await prisma.nVR.findUnique({
    where: { id },

    select: nvrSelect,
  })

  if (!nvr) {
    throw new AppError(404, 'NVR not found.')
  }

  return nvr
}

export const createNVR = async (data: NVRPayload) => {
  const existingNVR = await prisma.nVR.findFirst({
    where: {
      ip: data.ip,
    },
  })

  if (existingNVR) {
    throw new AppError(409, 'NVR with this IP already exists.')
  }

  return prisma.$transaction(async (tx) => {
    let station = await tx.station.findUnique({
      where: {
        name_city: {
          name: data.stationName,
          city: data.stationCity,
        },
      },
    })

    if (!station) {
      station = await tx.station.create({
        data: {
          name: data.stationName,
          city: data.stationCity,
        },
      })
    }

    const nvr = await tx.nVR.create({
      data: {
        stationId: station.id,
        name: data.name,
        ip: data.ip,
        type: data.type,
        rtspPort: data.rtspPort ?? 554,
        httpPort: data.httpPort ?? 80,
        username: data.username,
        password: encrypt(data.password),
      },
      select: nvrSelect
    })

    return nvr
  })
}

export const updateNVR = async (
  id: string,
  data: Partial<NVRPayload>
) => {
  const existing = await prisma.nVR.findUnique({
    where: { id },
    include: {
      station: true,
    },
  })

  if (!existing) {
    throw new AppError(404, 'NVR not found.')
  }

  return prisma.$transaction(async (tx) => {
    let stationId = existing.stationId

    if (data.stationName || data.stationCity) {
      const stationName = data.stationName ?? existing.station.name
      const stationCity = data.stationCity ?? existing.station.city

      let station = await tx.station.findUnique({
        where: {
          name_city: {
            name: stationName,
            city: stationCity,
          },
        },
      })

      if (!station) {
        station = await tx.station.create({
          data: {
            name: stationName,
            city: stationCity,
          },
        })
      }

      stationId = station.id
    }

    const updatedNVR = await tx.nVR.update({
      where: { id },

      data: {
        stationId,
        name: data.name,
        ip: data.ip,
        type: data.type,
        rtspPort: data.rtspPort,
        httpPort: data.httpPort,
        username: data.username,
        password: data.password
          ? encrypt(data.password)
          : undefined,
      },
      select: nvrSelect
    })

    const oldStationNVRCount = await tx.nVR.count({
      where: {
        stationId: existing.stationId,
      },
    })

    if (oldStationNVRCount === 0) {
      await tx.station.delete({
        where: {
          id: existing.stationId,
        },
      })
    }

    return updatedNVR
  })
}

export const deleteNVR = async (id: string) => {
  const existing = await prisma.nVR.findUnique({
    where: { id },
  })

  if (!existing) {
    throw new AppError(404, 'NVR not found.')
  }

  return prisma.$transaction(async (tx) => {
    await tx.nVR.delete({
      where: { id },
    })

    const remainingNVRs = await tx.nVR.count({
      where: {
        stationId: existing.stationId,
      },
    })

    if (remainingNVRs === 0) {
      await tx.station.delete({
        where: {
          id: existing.stationId,
        },
      })
    }
  })
}