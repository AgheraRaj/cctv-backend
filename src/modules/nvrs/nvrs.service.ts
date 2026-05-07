import prisma from "../../config/db.js";
import { AppError } from "../../middleware/errorHandler.js";
import { encrypt } from "../../utils/crypto.js";
import { NVRType } from "@prisma/client";

export const getNVRsByStation = async (stationId: string) => {
  // Verify station exists first
  const station = await prisma.station.findUnique({ where: { id: stationId } });
  if (!station) throw new AppError(404, "Station not found.");

  return prisma.nVR.findMany({
    where: { stationId },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      name: true,
      ip: true,
      type: true,
      rtspPort: true,
      httpPort: true,
      username: true,
      totalChannel: true,
      stationId: true,
      status: true, // ← add
      lastSeenAt: true, // ← add
      offlineSince: true, // ← add
      createdAt: true,
      updatedAt: true,
      _count: { select: { cameras: true } },
    },
  });
};

export const getNVRById = async (id: string) => {
  const nvr = await prisma.nVR.findUnique({
    where: { id },
    select: {
      id: true,
      name: true,
      ip: true,
      type: true,
      rtspPort: true,
      httpPort: true,
      username: true,
      totalChannel: true,
      stationId: true,
      status: true, // ← add
      lastSeenAt: true, // ← add
      offlineSince: true, // ← add
      createdAt: true,
      updatedAt: true,
      _count: { select: { cameras: true } },
    },
  });

  if (!nvr) throw new AppError(404, "NVR not found.");
  return nvr;
};

export const createNVR = async (
  stationId: string,
  data: {
    name: string;
    ip: string;
    type: NVRType;
    rtspPort?: number;
    httpPort?: number;
    username?: string;
    password: string;
    totalChannel?: number;
  },
) => {
  const station = await prisma.station.findUnique({ where: { id: stationId } });
  if (!station) throw new AppError(404, "Station not found.");

  // Encrypt password before storing
  const encryptedPassword = encrypt(data.password);

  return prisma.nVR.create({
    data: {
      ...data,
      password: encryptedPassword,
      stationId,
    },
    select: {
      id: true,
      name: true,
      ip: true,
      type: true,
      rtspPort: true,
      httpPort: true,
      username: true,
      totalChannel: true,
      stationId: true,
      createdAt: true,
      updatedAt: true,
    },
  });
};

export const updateNVR = async (
  id: string,
  data: Partial<{
    name: string;
    ip: string;
    type: NVRType;
    rtspPort: number;
    httpPort: number;
    username: string;
    password: string;
    totalChannel: number;
  }>,
) => {
  const existing = await prisma.nVR.findUnique({ where: { id } });
  if (!existing) throw new AppError(404, "NVR not found.");

  // Only encrypt if password is being updated
  if (data.password) {
    data.password = encrypt(data.password);
  }

  return prisma.nVR.update({
    where: { id },
    data,
    select: {
      id: true,
      name: true,
      ip: true,
      type: true,
      rtspPort: true,
      httpPort: true,
      username: true,
      totalChannel: true,
      stationId: true,
      createdAt: true,
      updatedAt: true,
    },
  });
};

export const deleteNVR = async (id: string) => {
  const existing = await prisma.nVR.findUnique({ where: { id } });
  if (!existing) throw new AppError(404, "NVR not found.");

  // Cascades to cameras automatically
  return prisma.nVR.delete({ where: { id } });
};
