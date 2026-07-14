import prisma from '../../config/db.js'
import { decrypt } from '../../utils/crypto.js'
import { discoverHikvisionCameras } from './hikvision.discoverer.js'
import { discoverHifocusCameras } from './hifocus.discoverer.js'
import { isNvrHostReachable } from './nvr.heartbeat.js'
import type { DiscoveredCamera } from './hikvision.discoverer.js'
import logger from '../../utils/logger.js'
import {
  emitNvrStatus,
  emitCameraStatus,
  emitCameraNew,
} from '../../services/socketService.js'

// Consecutive-failure debounce so a single transient heartbeat miss doesn't
// immediately flip the NVR to OFFLINE — matches how commercial VMS platforms
// avoid flapping on momentary network blips. In-memory is fine here: worst
// case after a process restart is one extra failure needed before the first
// OFFLINE transition, which is an acceptable tradeoff for not needing a
// migration. Move this into a DB column if you need it to survive restarts.
const consecutiveFailures = new Map<string, number>()
const OFFLINE_THRESHOLD = 3 // require 3 consecutive heartbeat failures before declaring OFFLINE

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

  // 2 — TIER 1: cheap, ONVIF-independent reachability check.
  // This — and only this — decides NVR online/offline. A full ONVIF
  // profile/capability bootstrap failing later must never affect this.
  const heartbeatOk = await isNvrHostReachable(nvr.ip, nvr.httpPort)

  const failures = heartbeatOk ? 0 : (consecutiveFailures.get(nvrId) ?? 0) + 1
  consecutiveFailures.set(nvrId, failures)
  const nvrReachable = heartbeatOk || failures < OFFLINE_THRESHOLD

  // 3 — Update NVR status + emit Socket.io event
  const updatedNvr = await updateNVRStatus(nvrId, nvrReachable, nvr.offlineSince)
  emitNvrStatus({
    nvrId,
    status: updatedNvr.status as 'ONLINE' | 'OFFLINE',
    lastSeenAt: updatedNvr.lastSeenAt,
    offlineSince: updatedNvr.offlineSince,
  })

  if (!nvrReachable) return

  // 4 — TIER 2: per-channel camera discovery. Fully independent of NVR
  // status now. Any failure here (including a connection-level failure
  // talking ONVIF, which is NOT the same as the NVR host being down) is
  // caught locally and simply skips reconciliation this cycle — it never
  // touches NVR status or any camera's existing status.
  const decryptedPassword = decrypt(nvr.password)
  let discovered: DiscoveredCamera[] | null = null

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
    logger.warn(
      `Camera discovery failed for reachable NVR ${nvr.name} (${nvr.ip}) — ` +
        `leaving existing camera statuses unchanged this cycle: ${err instanceof Error ? err.message : String(err)}`
    )
    return
  }

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
    const [updatedNvr] = await prisma.$transaction([
      prisma.nVR.update({
        where: { id: nvrId },
        data: {
          status: 'OFFLINE',
          offlineSince: currentOfflineSince ?? new Date(),
        },
        select: { status: true, lastSeenAt: true, offlineSince: true },
      }),
      // When the NVR host itself is confirmed unreachable (not a camera/
      // channel discovery hiccup), all its cameras are effectively offline
      // too. Mark them all so the frontend never shows a camera as online
      // under an offline NVR.
      prisma.camera.updateMany({
        where: {
          nvrId,
          isOnline: true,
        },
        data: {
          isOnline: false,
          offlineSince: new Date(),
        },
      }),
    ])

    return updatedNvr
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