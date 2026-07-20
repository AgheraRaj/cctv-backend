import prisma from '../../config/db.js'
import { decrypt } from '../../utils/crypto.js'
import { discoverHikvisionCameras } from './hikvision.discoverer.js'
import { discoverHifocusCameras } from './hifocus.discoverer.js'
import { isNvrHostReachable } from './nvr.heartbeat.js'
import type { DiscoveredCamera } from './hikvision.discoverer.js'

import {
  emitNvrStatus,
  emitCameraStatus,
  emitCameraNew,
} from '../../services/socketService.js'

// ═══════════════════════════════════════════════════════════════════
// TIER 1 — NVR HEARTBEAT
// Cheap, ONVIF-independent reachability check. This — and only this —
// decides NVR online/offline. Scheduled on its own always-on BullMQ
// queue (nvr-heartbeat-queue). Nothing UI-session-scoped ever calls
// this on a start/stop basis; it runs from the moment an NVR is
// created until the moment it's deleted.
// ═══════════════════════════════════════════════════════════════════

// Consecutive-failure debounce so a single transient heartbeat miss doesn't
// immediately flip the NVR to OFFLINE. In-memory is fine here: worst case
// after a process restart is one extra failure needed before the first
// OFFLINE transition. Move this into a DB column if you need it to survive
// restarts or run multiple worker replicas for HA (see note in the worker
// file about horizontal scaling).
const consecutiveFailures = new Map<string, number>()
const OFFLINE_THRESHOLD = 3 // require 3 consecutive heartbeat failures before declaring OFFLINE

export const runNvrHeartbeat = async (nvrId: string): Promise<void> => {
  const nvr = await prisma.nVR.findUnique({
    where: { id: nvrId },
    select: { id: true, ip: true, httpPort: true, offlineSince: true },
  })

  if (!nvr) {
    console.warn(`Heartbeat skipped — NVR ${nvrId} not found in DB`)
    consecutiveFailures.delete(nvrId)
    return
  }

  const heartbeatOk = await isNvrHostReachable(nvr.ip, nvr.httpPort)

  const failures = heartbeatOk ? 0 : (consecutiveFailures.get(nvrId) ?? 0) + 1
  consecutiveFailures.set(nvrId, failures)
  const nvrReachable = heartbeatOk || failures < OFFLINE_THRESHOLD

  const updatedNvr = await updateNVRStatus(nvrId, nvrReachable, nvr.offlineSince)

  emitNvrStatus({
    nvrId,
    status: updatedNvr.status as 'ONLINE' | 'OFFLINE',
    lastSeenAt: updatedNvr.lastSeenAt,
    offlineSince: updatedNvr.offlineSince,
  })
}

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
      // When the NVR host itself is confirmed unreachable, all its cameras
      // are effectively offline too. Mark them all so the frontend never
      // shows a camera as online under an offline NVR.
      prisma.camera.updateMany({
        where: { nvrId, isOnline: true },
        data: { isOnline: false, offlineSince: new Date() },
      }),
    ])

    return updatedNvr
  }
}

// ═══════════════════════════════════════════════════════════════════
// TIER 2 — CAMERA STATUS + DISCOVERY
// Both vendor adapters (ISAPI channels/status for Hikvision;
// queryNodeList + queryRecStatus for HiFocus) return the channel list
// AND live per-channel status in the same call — there is no separate
// cheap "just health" endpoint to call instead. So this single function
// serves both "update known camera status" and "detect new/removed
// channels" simultaneously; that's a property of the vendor APIs, not
// a scheduling shortcut.
//
// What IS independently controlled is scheduling: this runs on its own
// always-on queue (camera-status-queue), separate from the NVR
// heartbeat queue, and is NEVER started or stopped by the frontend's
// page-visit endpoints. Leaving the NVR page no longer has any way to
// affect this.
// ═══════════════════════════════════════════════════════════════════

export const runCameraStatusCheck = async (nvrId: string): Promise<void> => {
  const nvr = await prisma.nVR.findUnique({
    where: { id: nvrId },
    include: { cameras: true },
  })

  if (!nvr) {
    console.warn(`Camera status check skipped — NVR ${nvrId} not found in DB`)
    return
  }

  // Skip cameras work for an NVR the heartbeat has already declared
  // OFFLINE — its cameras were already cascaded to offline in the same
  // transaction (see updateNVRStatus above), and probing a dead host
  // would just burn a full ONVIF/ISAPI timeout for a result we already
  // know. This is the one place the two tiers intentionally talk to
  // each other, via the DB's `status` column — not via a shared timer
  // or shared queue.
  if (nvr.status === 'OFFLINE') return

  const decryptedPassword = decrypt(nvr.password)
  let discovered: DiscoveredCamera[] | null = null

  try {
    discovered =
      nvr.type === 'HIKVISION'
        ? await discoverHikvisionCameras(nvr.ip, nvr.httpPort, nvr.username, decryptedPassword)
        : await discoverHifocusCameras(nvr.ip, nvr.httpPort, nvr.username, decryptedPassword)
  } catch (err) {
    console.warn(
      `Camera status check failed for reachable NVR ${nvr.name} (${nvr.ip}) — ` +
        `leaving existing camera statuses unchanged this cycle: ${err instanceof Error ? err.message : String(err)}`
    )
    return
  }

  if (discovered !== null) {
    await reconcileCameras(nvrId, discovered, nvr.cameras)
  }
}

// ─── Camera Reconciliation ───────────────────────────────
// Unchanged from the original implementation.

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

  for (const [channel, discoveredCam] of discoveredMap) {
    const existing = existingMap.get(channel)

    if (!existing) {
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

      console.log(`New camera discovered on NVR ${nvrId} — channel ${channel}`)

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

    const goingOffline = !discoveredCam.isOnline && existing.isOnline
    const comingOnline = discoveredCam.isOnline && !existing.isOnline

    const updatedCamera = await prisma.camera.update({
      where: { id: existing.id },
      data: {
        isOnline: discoveredCam.isOnline,
        lastSeenAt: discoveredCam.isOnline ? now : undefined,
        offlineSince: comingOnline ? null : goingOffline ? now : existing.offlineSince,
        protocol: discoveredCam.protocol ?? undefined,
      },
      select: { id: true, isOnline: true, offlineSince: true },
    })

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

  for (const [channel, existing] of existingMap) {
    if (!discoveredMap.has(channel) && existing.isOnline) {
      await prisma.camera.update({
        where: { id: existing.id },
        data: {
          isOnline: false,
          offlineSince: existing.offlineSince ?? now,
        },
      })

      console.log(`Camera channel ${channel} on NVR ${nvrId} went offline`)

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