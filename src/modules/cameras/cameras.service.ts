import prisma from "../../config/db.js";
import { AppError } from "../../middleware/errorHandler.js";

export const getCameraSlots = async (nvrId: string) => {
  const nvr = await prisma.nVR.findUnique({
    where: { id: nvrId },
    include: { cameras: true },
  });

  if (!nvr) throw new AppError(404, "NVR not found.");

  const cameraMap = new Map(nvr.cameras.map((c) => [c.channel, c]));

  // Always return exactly 16 slots
  // Gaps where no camera exists are filled with isActive: false
  return Array.from({ length: 16 }, (_, i) => {
    const channel = i + 1;
    const camera = cameraMap.get(channel);

    return (
      camera ?? {
        id: null,
        nvrId,
        channel,
        name: `Channel ${channel}`,
        areaTag: null,
        isActive: false,
        isOnline: false, // ← add
        lastSeenAt: null, // ← add
        offlineSince: null, // ← add
        protocol: null, // ← add
        createdAt: null,
        updatedAt: null,
      }
    );
  });
};

export const getCameraById = async (id: string) => {
  const camera = await prisma.camera.findUnique({ where: { id } });
  if (!camera) throw new AppError(404, "Camera not found.");
  return camera;
};

export const createCamera = async (
  nvrId: string,
  data: {
    channel: number;
    name: string;
    areaTag?: string;
    isActive?: boolean;
  },
) => {
  const nvr = await prisma.nVR.findUnique({ where: { id: nvrId } });
  if (!nvr) throw new AppError(404, "NVR not found.");

  if (data.channel < 1 || data.channel > 16) {
    throw new AppError(
      400,
      `Channel must be between 1 and 16.`,
    );
  }

  // Check channel is not already taken on this NVR
  const existing = await prisma.camera.findUnique({
    where: { nvrId_channel: { nvrId, channel: data.channel } },
  });

  if (existing) {
    throw new AppError(409, `Channel ${data.channel} is already assigned.`);
  }

  return prisma.camera.create({
    data: { ...data, nvrId },
  });
};

export const updateCamera = async (
  id: string,
  data: Partial<{
    channel: number;
    name: string;
    areaTag: string;
    isActive: boolean;
  }>,
) => {
  const existing = await prisma.camera.findUnique({ where: { id } });
  if (!existing) throw new AppError(404, "Camera not found.");

  // If channel is being changed, check the new channel is not taken
  if (data.channel && data.channel !== existing.channel) {
    const channelTaken = await prisma.camera.findUnique({
      where: {
        nvrId_channel: { nvrId: existing.nvrId, channel: data.channel },
      },
    });

    if (channelTaken) {
      throw new AppError(409, `Channel ${data.channel} is already assigned.`);
    }
  }

  return prisma.camera.update({ where: { id }, data });
};

export const deleteCamera = async (id: string) => {
  const existing = await prisma.camera.findUnique({ where: { id } });
  if (!existing) throw new AppError(404, "Camera not found.");
  return prisma.camera.delete({ where: { id } });
};
