/**
 * playback.service.ts
 *
 * Orchestration ONLY. This file owns the lifecycle (create → playing →
 * paused → seeking → stopped) and the ORDER of operations — it does not
 * know how to talk to a specific vendor (that's the adapter's job, see
 * ./adapters) and does not know how to talk to MediaMTX directly (that's
 * MediaGateway's job, see ../streams/media-gateway.ts).
 *
 * NOTE: this file was previously out of sync with the rest of the playback
 * module (adapters/, playback-session-manager.ts, media-gateway.ts, and the
 * Phase-7 session.store.ts schema had all moved to the new architecture,
 * but this file was still calling session.store.ts directly with the old
 * field shape and never exported pauseSession/resumeSession/changeSpeed —
 * which is exactly why the controller failed to compile). This version
 * wires it up correctly against what already exists in the project.
 */
import prisma from '../../config/db.js'
import { AppError } from '../../middleware/errorHandler.js'
import { decrypt } from '../../utils/crypto.js'
import { env } from '../../config/env.js'
import * as mediaGateway from '../streams/media-gateway.js'
import * as sessionManager from './playback-session-manager.js'
import type { PlaybackSession, PlaybackState } from './playback-session-manager.js'
import { getAdapter } from './adapters/index.js'
import type { AdapterNVR, NVRType } from './adapters/index.js'
import type { RecordingSegment } from './hikvision.search.js'


// ── Types ─────────────────────────────────────────────────────────────────────

export interface SessionCreateResult {
  sessionId: string
  hlsUrl: string
  whepUrl: string
  durationSeconds: number
  recordingStart: string
  recordingEnd: string
}

export interface SessionState {
  sessionId: string
  state: PlaybackState
  currentPositionMs: number
  speed: number
  hlsUrl: string
  whepUrl: string
  durationSeconds: number
  recordingStart: string
  recordingEnd: string
}

// ── Internal helpers ──────────────────────────────────────────────────────────

interface LoadedNVR {
  adapterNvr: AdapterNVR
  decryptedPassword: string
  type: NVRType
}

const loadNvr = async (nvrId: string): Promise<LoadedNVR> => {
  const nvr = await prisma.nVR.findUnique({ where: { id: nvrId } })
  if (!nvr) throw new AppError(404, `NVR ${nvrId} not found.`)

  return {
    adapterNvr: {
      type: nvr.type as NVRType,
      ip: nvr.ip,
      httpPort: nvr.httpPort,
      rtspPort: nvr.rtspPort,
      username: nvr.username,
    },
    decryptedPassword: decrypt(nvr.password),
    type: nvr.type as NVRType,
  }
}

const toSessionState = (session: PlaybackSession): SessionState => {
  const durationSeconds = Math.round(
    (new Date(session.recordingEnd).getTime() - new Date(session.recordingStart).getTime()) / 1000
  )

  return {
    sessionId: session.sessionId,
    state: session.state,
    currentPositionMs: session.currentPositionMs,
    speed: session.speed,
    hlsUrl: session.hlsUrl,
    whepUrl: session.whepUrl,
    durationSeconds,
    recordingStart: session.recordingStart,
    recordingEnd: session.recordingEnd,
  }
}

const newPathName = (nvrId: string, channel: number): string => `${nvrId}-ch${channel}-pb-${Date.now()}`

/**
 * Shared internals of "tear down current path, build a fresh RTSP source at
 * the given target time, provision a new path, persist the result." Used by
 * both explicit seek() and transparent session recovery (Phase 3 §2/§9) —
 * they are the same operation triggered by different callers.
 */
const reseekTo = async (
  session: PlaybackSession,
  targetPositionMs: number
): Promise<{ hlsUrl: string; whepUrl: string; positionMs: number }> => {
  const recordingStart = new Date(session.recordingStart)
  const recordingEnd = new Date(session.recordingEnd)
  const seekTime = new Date(recordingStart.getTime() + targetPositionMs)

  if (seekTime < recordingStart || seekTime >= recordingEnd) {
    throw new AppError(400, 'Seek position is outside the recording window.')
  }

  const { adapterNvr, decryptedPassword } = await loadNvr(session.nvrId)
  const adapter = getAdapter(session.vendorType)

  // Best-effort teardown of the old path — proceed even if this NVR-side
  // release is slow/fails, since we're about to replace it anyway.
  if (session.mediamtxPathName) {
    await mediaGateway.closeStreamAndWait(session.mediamtxPathName)
  }

  const { rtspUrl, vendorMeta } = await adapter.buildStreamSource(
    adapterNvr,
    decryptedPassword,
    session.channel,
    seekTime,
    recordingEnd,
    session.vendorMeta
  )

  const pathName = newPathName(session.nvrId, session.channel)
  const { hlsUrl, whepUrl } = await mediaGateway.openStream(pathName, rtspUrl, { isPlayback: true })

  await sessionManager.patch(session.sessionId, {
    mediamtxPathName: pathName,
    hlsUrl,
    whepUrl,
    currentPositionMs: targetPositionMs,
    vendorMeta,
  })

  return { hlsUrl, whepUrl, positionMs: targetPositionMs }
}

const isPathHealthySafe = async (pathName: string): Promise<boolean> => {
  if (!pathName) return false
  try {
    return await mediaGateway.isPathHealthy(pathName)
  } catch {
    return false
  }
}

// ── 1. Create Session ─────────────────────────────────────────────────────────

export const createPlaybackSession = async (
  nvrId: string,
  channel: number,
  recordingStart: Date,
  recordingEnd: Date
): Promise<SessionCreateResult> => {
  if (recordingEnd <= recordingStart) {
    throw new AppError(400, 'recordingEnd must be after recordingStart.')
  }

  // ── Enforce one active session per NVR+channel ────────────────────────────
  // Check for an existing session and stop it BEFORE doing any NVR work, so
  // the old NVR RTSP slot is fully released before we open a new connection
  // on the same channel (avoids ISAPI/ONVIF 453-style rejections).
  const existing = await sessionManager.getActiveSession(nvrId, channel)
  if (existing) {
    console.log(`Channel ${nvrId}:${channel} already has session ${existing.sessionId} — evicting`)
    await stopSession(existing.sessionId)
  }

  const { adapterNvr, decryptedPassword, type } = await loadNvr(nvrId)

  const camera = await prisma.camera.findUnique({ where: { nvrId_channel: { nvrId, channel } } })
  if (!camera) throw new AppError(404, `No camera on channel ${channel}.`)
  if (!camera.isActive) throw new AppError(400, `Camera on channel ${channel} is inactive.`)

  const adapter = getAdapter(type)
  const { rtspUrl, vendorMeta } = await adapter.buildStreamSource(
    adapterNvr,
    decryptedPassword,
    channel,
    recordingStart,
    recordingEnd,
    {}
  )

  const pathName = newPathName(nvrId, channel)
  // openStream throws if the stream never becomes ready — no session is
  // created against a dead path (tightened vs. the previous warn-and-continue).
  const { hlsUrl, whepUrl } = await mediaGateway.openStream(pathName, rtspUrl, { isPlayback: true })

  const session = await sessionManager.startSession({
    nvrId,
    channel,
    vendorType: type,
    state: 'PLAYING',
    recordingStart: recordingStart.toISOString(),
    recordingEnd: recordingEnd.toISOString(),
    tzOffsetMs: typeof vendorMeta.tzOffsetMs === 'number' ? vendorMeta.tzOffsetMs : 0,
    currentPositionMs: 0,
    direction: 'forward',
    speed: 1,
    mediamtxPathName: pathName,
    hlsUrl,
    whepUrl,
    vendorMeta,
  })

  const durationSeconds = Math.round((recordingEnd.getTime() - recordingStart.getTime()) / 1000)

  return {
    sessionId: session.sessionId,
    hlsUrl,
    whepUrl,
    durationSeconds,
    recordingStart: recordingStart.toISOString(),
    recordingEnd: recordingEnd.toISOString(),
  }
}

// ── 2. Seek Session ───────────────────────────────────────────────────────────

export const seekSession = async (
  sessionId: string,
  targetPositionMs: number
): Promise<{ hlsUrl: string; whepUrl: string }> => {
  // Enter SEEKING — rejects with 409 if a seek/stop is already in flight for
  // this session, closing the concurrency gap where two overlapping seeks
  // could race the same MediaMTX path teardown/rebuild.
  await sessionManager.transition(sessionId, 'SEEKING')

  try {
    const session = await sessionManager.getSessionOrThrow(sessionId)
    const { hlsUrl, whepUrl } = await reseekTo(session, targetPositionMs)

    // Return to whichever state we were in before seeking — seeking while
    // paused must NOT auto-resume playback.
    const refreshed = await sessionManager.getSessionOrThrow(sessionId)
    const landingState: PlaybackState = refreshed.previousState ?? 'PLAYING'
    await sessionManager.transition(sessionId, landingState)

    return { hlsUrl, whepUrl }
  } catch (err) {
    // Best-effort: don't leave the session stuck in SEEKING forever if the
    // reseek itself failed — fall back to PLAYING so the client can retry.
    try {
      await sessionManager.transition(sessionId, 'PLAYING')
    } catch {
      /* session may already be gone — nothing more to do */
    }
    throw err
  }
}

// ── 3. Update position (heartbeat) ───────────────────────────────────────────

export const updatePosition = async (sessionId: string, currentPositionMs: number): Promise<void> => {
  await sessionManager.touch(sessionId, currentPositionMs)
}

// ── 4. Get Session State (with transparent recovery) ─────────────────────────

export const getSessionState = async (sessionId: string): Promise<SessionState> => {
  const session = await sessionManager.getSessionOrThrow(sessionId)

  const healthy = session.mediamtxPathName ? await isPathHealthySafe(session.mediamtxPathName) : false

  if (healthy) {
    return toSessionState(session)
  }

  console.warn(`Session ${sessionId}: path "${session.mediamtxPathName}" unhealthy — attempting recovery`)

  try {
    await reseekTo(session, session.currentPositionMs)
    const recovered = await sessionManager.getSessionOrThrow(sessionId)
    return toSessionState(recovered)
  } catch (err) {
    console.error(`Session ${sessionId}: recovery failed, deleting session: ${String(err)}`)
    await sessionManager.stop(sessionId, session.nvrId, session.channel)
    throw new AppError(404, `Session ${sessionId} could not be recovered and has been closed.`)
  }
}

// ── 5. Pause / Resume ─────────────────────────────────────────────────────────
// Client-side pause by default: the MediaMTX path and NVR connection are
// left running — only the session's state flips, and the frontend player is
// expected to stop rendering. No adapter/gateway call for the common case.

export const pauseSession = async (sessionId: string): Promise<SessionState> => {
  const session = await sessionManager.getSessionOrThrow(sessionId)
  const adapter = getAdapter(session.vendorType)

  if (!adapter.supportsPause()) {
    // Fallback for firmware that can't tolerate a client that stops pulling
    // from MediaMTX: tear the stream down and just remember position.
    if (session.mediamtxPathName) {
      await mediaGateway.closeStreamAndWait(session.mediamtxPathName)
    }
  }

  const updated = await sessionManager.transition(sessionId, 'PAUSED')
  return toSessionState(updated)
}

export const resumeSession = async (sessionId: string): Promise<SessionState> => {
  const session = await sessionManager.getSessionOrThrow(sessionId)

  const pausedAtMs = session.pausedAt ? new Date(session.pausedAt).getTime() : 0
  const pauseDurationMs = pausedAtMs ? Date.now() - pausedAtMs : 0
  const pathStillHealthy = await isPathHealthySafe(session.mediamtxPathName)
  const needsReseek = pauseDurationMs >= env.PLAYBACK_RESUME_RESEEK_THRESHOLD_MS || !pathStillHealthy

  if (needsReseek) {
    // Long pause (or path already died, e.g. the supportsPause()===false
    // fallback tore it down) — the live HLS buffer may have rolled past the
    // paused point. Re-derive the stream at the last known position.
    await sessionManager.transition(sessionId, 'SEEKING')
    await reseekTo(session, session.currentPositionMs)
    const updated = await sessionManager.transition(sessionId, 'PLAYING')
    return toSessionState(updated)
  }

  const updated = await sessionManager.transition(sessionId, 'PLAYING')
  return toSessionState(updated)
}

// ── 6. Playback Speed ─────────────────────────────────────────────────────────
// Client-side rate control for both vendors — neither adapter has
// NVR-native trick-play wiring, so this only persists the value for the
// frontend's local playbackRate and never touches MediaGateway.

const SUPPORTED_SPEEDS = [0.5, 1, 2, 4, 8, 16]

export const changeSpeed = async (sessionId: string, speed: number): Promise<SessionState> => {
  if (!SUPPORTED_SPEEDS.includes(speed)) {
    throw new AppError(400, `Unsupported speed. Supported values: ${SUPPORTED_SPEEDS.join(', ')}`)
  }

  const session = await sessionManager.getSessionOrThrow(sessionId)
  const updated = await sessionManager.patch(session.sessionId, { speed })
  return toSessionState(updated)
}

// ── 7. Stop Session ───────────────────────────────────────────────────────────

export const stopSession = async (sessionId: string): Promise<void> => {
  const session = await sessionManager.getSession(sessionId)
  if (!session) return // idempotent

  if (session.mediamtxPathName) {
    await mediaGateway.closeStreamAndWait(session.mediamtxPathName)
  }

  await sessionManager.stop(sessionId, session.nvrId, session.channel)
}

// ── 8. Search Recordings ──────────────────────────────────────────────────────

export const getRecordings = async (nvrId: string, channel: number, date: string): Promise<RecordingSegment[]> => {
  const startTime = new Date(`${date}T00:00:00Z`)
  const endTime = new Date(`${date}T23:59:59Z`)
  if (isNaN(startTime.getTime())) throw new AppError(400, 'Invalid date. Expected YYYY-MM-DD.')

  const { adapterNvr, decryptedPassword, type } = await loadNvr(nvrId)
  const adapter = getAdapter(type)

  return adapter.searchRecordings(adapterNvr, decryptedPassword, channel, startTime, endTime)
}

// ── 9. Cleanup Orphaned Sessions ──────────────────────────────────────────────

export const cleanupOrphanedSessions = async (): Promise<void> => {
  try {
    const activePathNames = await sessionManager.getAllActivePathNames()
    await mediaGateway.reconcileOrphans(activePathNames)
  } catch (err) {
    console.error('Orphaned session cleanup error:', err)
  }
}