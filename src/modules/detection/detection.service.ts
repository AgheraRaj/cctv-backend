import prisma from '../../config/db.js'
import { decrypt } from '../../utils/crypto.js'
import { discoverHikvisionCameras } from './hikvision.discoverer.js'
import { discoverHifocusCameras } from './hifocus.discoverer.js'
import type { DiscoveredCamera } from './hikvision.discoverer.js'
import logger from '../../utils/logger.js'
import {
  emitNvrStatus,
  emitCameraStatus,
  emitCameraNew,
} from '../../services/socketService.js'

export const runDetectionForNVR = async (nvrId: string): Promise<void> => {
  // 1 — Fetch NVR from DB with credentials
  const nvr = await prisma.nVR.findUnique({
    where: { id: nvrId },
    include: { cameras: true },
  })

  if (!nvr) {
    logger.warn(`Detection skipped — NVR ${nvrId} not found in DB`)
    return
  }

  const decryptedPassword = decrypt(nvr.password)

  // 2 — Poll NVR for connected cameras
  let discovered: DiscoveredCamera[] | null = []
  let nvrReachable = true

  try {
    if (nvr.type === 'HIKVISION') {
      discovered = await discoverHikvisionCameras(
        nvr.ip,
        nvr.httpPort,
        nvr.username,
        decryptedPassword
      )
    } else {
      discovered = await discoverHifocusCameras(
        nvr.ip,
        nvr.httpPort,
        nvr.username,
        decryptedPassword
      )
    }
  } catch (err) {
    nvrReachable = false
    logger.warn(`NVR ${nvr.name} (${nvr.ip}) unreachable: ${String(err)}`)
  }

  // 3 — Update NVR status + emit Socket.io event
  const updatedNvr = await updateNVRStatus(nvrId, nvrReachable, nvr.offlineSince)
  emitNvrStatus({
    nvrId,
    status: updatedNvr.status as 'ONLINE' | 'OFFLINE',
    lastSeenAt: updatedNvr.lastSeenAt,
    offlineSince: updatedNvr.offlineSince,
  })

  if (!nvrReachable) return

  // 4 — Reconcile discovered cameras with DB
  if (discovered !== null) {
    await reconcileCameras(nvrId, discovered, nvr.cameras)
  }
}

// ─── NVR Status ──────────────────────────────────────────

const updateNVRStatus = async (
  nvrId: string,
  isReachable: boolean,
  currentOfflineSince: Date | null
) => {
  if (isReachable) {
    return prisma.nVR.update({
      where: { id: nvrId },
      data: {
        status: 'ONLINE',
        lastSeenAt: new Date(),
        offlineSince: null,
      },
      select: { status: true, lastSeenAt: true, offlineSince: true },
    })
  } else {
    return prisma.nVR.update({
      where: { id: nvrId },
      data: {
        status: 'OFFLINE',
        // Only set offlineSince once — preserve original time on subsequent polls
        offlineSince: currentOfflineSince ?? new Date(),
      },
      select: { status: true, lastSeenAt: true, offlineSince: true },
    })
  }
}

// ─── Camera Reconciliation ───────────────────────────────

const reconcileCameras = async (
  nvrId: string,
  discovered: DiscoveredCamera[],
  existingCameras: {
    id: string
    channel: number
    isOnline: boolean
    offlineSince: Date | null
  }[]
): Promise<void> => {
  const discoveredMap = new Map(discovered.map((c) => [c.channel, c]))
  const existingMap = new Map(existingCameras.map((c) => [c.channel, c]))

  const now = new Date()

  // Process each discovered camera
  for (const [channel, discoveredCam] of discoveredMap) {
    const existing = existingMap.get(channel)

    if (!existing) {
      // New camera — insert into DB and notify frontend
      const newCamera = await prisma.camera.create({
        data: {
          nvrId,
          channel,
          name: `Channel ${channel}`,
          isActive: true,
          isOnline: discoveredCam.isOnline,
          lastSeenAt: discoveredCam.isOnline ? now : null,
          offlineSince: discoveredCam.isOnline ? null : now,
          protocol: discoveredCam.protocol ?? null,
        },
      })

      logger.info(`New camera discovered on NVR ${nvrId} — channel ${channel}`)

      emitCameraNew({
        camera: {
          id: newCamera.id,
          nvrId,
          channel,
          name: newCamera.name,
          isOnline: newCamera.isOnline,
        },
      })
      continue
    }

    // Existing camera — update status only
    const goingOffline = !discoveredCam.isOnline && existing.isOnline
    const comingOnline = discoveredCam.isOnline && !existing.isOnline

    const updatedCamera = await prisma.camera.update({
      where: { id: existing.id },
      data: {
        isOnline: discoveredCam.isOnline,
        lastSeenAt: discoveredCam.isOnline ? now : undefined,
        offlineSince: comingOnline
          ? null
          : goingOffline
          ? now
          : existing.offlineSince,
        protocol: discoveredCam.protocol ?? undefined,
      },
      select: { id: true, isOnline: true, offlineSince: true },
    })

    // Only emit when status actually changed — avoids noisy frontend updates
    if (goingOffline || comingOnline) {
      emitCameraStatus({
        cameraId: existing.id,
        nvrId,
        channel,
        isOnline: updatedCamera.isOnline,
        offlineSince: updatedCamera.offlineSince,
      })
    }
  }

  // Mark cameras not in discovery response as offline
  for (const [channel, existing] of existingMap) {
    if (!discoveredMap.has(channel) && existing.isOnline) {
      await prisma.camera.update({
        where: { id: existing.id },
        data: {
          isOnline: false,
          offlineSince: existing.offlineSince ?? now,
        },
      })

      logger.info(`Camera channel ${channel} on NVR ${nvrId} went offline`)

      emitCameraStatus({
        cameraId: existing.id,
        nvrId,
        channel,
        isOnline: false,
        offlineSince: existing.offlineSince ?? now,
      })
    }
  }
}