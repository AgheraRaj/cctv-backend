/**
 * playback-session-manager.ts
 *
 * Wraps session.store.ts (raw Redis CRUD) with the actual BEHAVIORS
 * PlaybackService needs — most importantly a validated state machine
 * (Phase 3), so illegal transitions (e.g. seeking twice concurrently, or
 * resuming a session that isn't paused) are rejected explicitly instead of
 * racing.
 *
 * State graph:
 *
 *        create()
 *           │
 *           ▼
 *      ┌─────────┐   pause()    ┌────────┐
 *      │ PLAYING │ ───────────► │ PAUSED │
 *      └────┬────┘ ◄─────────── └────┬───┘
 *           │         resume()        │
 *           │ seek()/speed()          │ seek() (allowed while paused)
 *           ▼                         │
 *      ┌─────────┐ ◄──────────────────┘
 *      │ SEEKING │──► back to whatever `previousState` was
 *      └────┬────┘
 *           │ stop() / TTL expiry / heartbeat timeout
 *           ▼
 *      ┌─────────┐
 *      │ STOPPED │ (terminal — session deleted)
 *      └─────────┘
 */
import { AppError } from '../../middleware/errorHandler.js'
import logger from '../../utils/logger.js'
import {
  createSession as storeCreateSession,
  getSession as storeGetSession,
  updateSession as storeUpdateSession,
  deleteSession as storeDeleteSession,
  getAllSessions as storeGetAllSessions,
  getChannelSessionId as storeGetChannelSessionId,
  type PlaybackSession,
  type PlaybackState,
} from './session.store.js'

export type { PlaybackSession, PlaybackState } from './session.store.js'

// Legal transitions: from-state -> set of to-states a transition() call may request.
const LEGAL_TRANSITIONS: Record<PlaybackState, PlaybackState[]> = {
  PLAYING: ['PAUSED', 'SEEKING', 'STOPPED'],
  PAUSED: ['PLAYING', 'SEEKING', 'STOPPED'],
  SEEKING: ['PLAYING', 'PAUSED', 'STOPPED'], // the "back to previousState" landing
  STOPPED: [],
}

export const startSession = async (
  data: Omit<PlaybackSession, 'sessionId' | 'createdAt' | 'lastActivityAt'>
): Promise<PlaybackSession> => {
  return storeCreateSession(data)
}

export const getSessionOrThrow = async (sessionId: string): Promise<PlaybackSession> => {
  const session = await storeGetSession(sessionId)
  if (!session) throw new AppError(404, `Session ${sessionId} not found or expired.`)
  return session
}

export const getSession = async (sessionId: string): Promise<PlaybackSession | null> => {
  return storeGetSession(sessionId)
}

export const getActiveSession = async (nvrId: string, channel: number): Promise<PlaybackSession | null> => {
  const sessionId = await storeGetChannelSessionId(nvrId, channel)
  if (!sessionId) return null
  return storeGetSession(sessionId)
}

/**
 * Validated state transition. Throws 409 on an illegal transition (e.g. a
 * second seek arriving while one is already in flight) rather than silently
 * racing the in-progress MediaMTX path teardown/rebuild — this is the
 * specific concurrency bug Phase 3 identified in the original code.
 */
export const transition = async (
  sessionId: string,
  toState: PlaybackState,
  extraPatch: Partial<Omit<PlaybackSession, 'sessionId' | 'createdAt' | 'state'>> = {}
): Promise<PlaybackSession> => {
  const session = await getSessionOrThrow(sessionId)

  const allowed = LEGAL_TRANSITIONS[session.state] ?? []
  if (!allowed.includes(toState)) {
    throw new AppError(409, `Cannot transition session ${sessionId} from ${session.state} to ${toState}.`)
  }

  const patch: Partial<PlaybackSession> = { ...extraPatch, state: toState }

  // Entering SEEKING: remember what to return to afterwards.
  if (toState === 'SEEKING') {
    patch.previousState = session.state === 'PAUSED' ? 'PAUSED' : 'PLAYING'
  }

  // Leaving SEEKING back to PLAYING/PAUSED: clear the breadcrumb.
  if (session.state === 'SEEKING' && (toState === 'PLAYING' || toState === 'PAUSED')) {
    patch.previousState = undefined
  }

  if (toState === 'PAUSED') {
    patch.pausedAt = new Date().toISOString()
  }
  if (toState === 'PLAYING' && session.state === 'PAUSED') {
    patch.pausedAt = undefined
  }

  const updated = await storeUpdateSession(sessionId, patch)
  if (!updated) throw new AppError(404, `Session ${sessionId} not found or expired.`)
  return updated
}

/** Heartbeat — updates position and refreshes TTL, no state change. */
export const touch = async (sessionId: string, currentPositionMs: number): Promise<PlaybackSession> => {
  const updated = await storeUpdateSession(sessionId, { currentPositionMs })
  if (!updated) throw new AppError(404, `Session ${sessionId} not found.`)
  return updated
}

/** Generic patch without a state change (e.g. after a seek completes: new path/position). */
export const patch = async (
  sessionId: string,
  fields: Partial<Omit<PlaybackSession, 'sessionId' | 'createdAt'>>
): Promise<PlaybackSession> => {
  const updated = await storeUpdateSession(sessionId, fields)
  if (!updated) throw new AppError(404, `Session ${sessionId} not found or expired.`)
  return updated
}

export const stop = async (sessionId: string, nvrId?: string, channel?: number): Promise<void> => {
  await storeDeleteSession(sessionId, nvrId, channel)
}

export const getAllSessions = async (): Promise<PlaybackSession[]> => {
  return storeGetAllSessions()
}

export const getAllActivePathNames = async (): Promise<string[]> => {
  const sessions = await storeGetAllSessions()
  return sessions.map((s) => s.mediamtxPathName)
}

logger.debug('PlaybackSessionManager initialized')