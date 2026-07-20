/**
 * session.store.ts
 *
 * Redis-backed playback session store with channel index.
 *
 * Two key types:
 *   playback:session:{sessionId}     — full session data, 30min TTL
 *   playback:channel:{nvrId}:{ch}    — maps channel → sessionId, same TTL
 *
 * Both keys are written atomically using Redis pipelines so a server crash
 * between the two writes cannot leave them out of sync.
 *
 * TTL on both keys is refreshed together on every updateSession() call,
 * preventing the channel index from expiring while the session is still alive.
 *
 * Schema additions (Phase 7) — all additive/optional so a session written
 * under the previous shape (e.g. mid-deploy) still reads cleanly via
 * normalizeSession():
 *   vendorType, state, previousState, hlsUrl, whepUrl, vendorMeta, pausedAt
 */
import { randomUUID } from 'crypto'
import redis from '../../config/redis.js'


const SESSION_PREFIX = 'playback:session:'
const CHANNEL_PREFIX = 'playback:channel:'
export const SESSION_TTL_SECONDS = 30 * 60 // 30 minutes

// ── Types ─────────────────────────────────────────────────────────────────────

/** Legacy field, kept only so old-shape sessions still parse; no longer written or read for logic. */
export type PlaybackDirection = 'forward' | 'paused'

export type PlaybackState = 'PLAYING' | 'PAUSED' | 'SEEKING' | 'STOPPED'

export interface PlaybackSession {
  sessionId: string
  nvrId: string
  channel: number
  vendorType: 'HIKVISION' | 'HIFOCUS'

  state: PlaybackState
  previousState?: 'PLAYING' | 'PAUSED'

  recordingStart: string // ISO
  recordingEnd: string // ISO
  tzOffsetMs: number // deprecated — superseded by vendorMeta.tzOffsetMs, kept for back-compat reads only
  currentPositionMs: number
  direction: PlaybackDirection // deprecated — superseded by `state`, kept for back-compat reads only
  speed: number

  mediamtxPathName: string
  hlsUrl: string
  whepUrl: string

  vendorMeta: Record<string, unknown>

  createdAt: string
  lastActivityAt: string
  pausedAt?: string
}

// ── Key helpers ───────────────────────────────────────────────────────────────

const sessionKey = (sessionId: string) => `${SESSION_PREFIX}${sessionId}`
const channelKey = (nvrId: string, channel: number) => `${CHANNEL_PREFIX}${nvrId}:${channel}`

// ── Backward-compatible normalization ─────────────────────────────────────────
// A session written before this schema landed (or any partially-populated
// object) is defaulted here so getSession() never throws on missing new
// fields (Migration Phase C — additive, zero-downtime schema change).

const normalizeSession = (raw: any): PlaybackSession => {
  return {
    sessionId: raw.sessionId,
    nvrId: raw.nvrId,
    channel: raw.channel,
    vendorType: raw.vendorType ?? 'HIKVISION',
    state: raw.state ?? (raw.direction === 'paused' ? 'PAUSED' : 'PLAYING'),
    previousState: raw.previousState,
    recordingStart: raw.recordingStart,
    recordingEnd: raw.recordingEnd,
    tzOffsetMs: raw.tzOffsetMs ?? 0,
    currentPositionMs: raw.currentPositionMs ?? 0,
    direction: raw.direction ?? 'forward',
    speed: raw.speed ?? 1,
    mediamtxPathName: raw.mediamtxPathName,
    hlsUrl: raw.hlsUrl ?? '',
    whepUrl: raw.whepUrl ?? '',
    vendorMeta: raw.vendorMeta ?? (raw.tzOffsetMs ? { tzOffsetMs: raw.tzOffsetMs } : {}),
    createdAt: raw.createdAt,
    lastActivityAt: raw.lastActivityAt,
    pausedAt: raw.pausedAt,
  }
}

// ── Session CRUD ──────────────────────────────────────────────────────────────

/**
 * Creates a session AND sets the channel index atomically in one pipeline.
 * If the server crashes mid-write, either both keys exist or neither does.
 */
export const createSession = async (
  data: Omit<PlaybackSession, 'sessionId' | 'createdAt' | 'lastActivityAt'>
): Promise<PlaybackSession> => {
  const sessionId = randomUUID()
  const now = new Date().toISOString()

  const session: PlaybackSession = {
    ...data,
    sessionId,
    createdAt: now,
    lastActivityAt: now,
  }

  const pipeline = redis.pipeline()
  pipeline.setex(sessionKey(sessionId), SESSION_TTL_SECONDS, JSON.stringify(session))
  pipeline.setex(channelKey(data.nvrId, data.channel), SESSION_TTL_SECONDS, sessionId)
  await pipeline.exec()

  console.log(`Playback session created: ${sessionId} (${data.nvrId} ch${data.channel})`)
  return session
}

export const getSession = async (sessionId: string): Promise<PlaybackSession | null> => {
  const raw = await redis.get(sessionKey(sessionId))
  if (!raw) return null
  try {
    return normalizeSession(JSON.parse(raw))
  } catch {
    return null
  }
}

/**
 * Updates a session AND refreshes the channel index TTL atomically.
 * This prevents the channel key from expiring while the session is still alive.
 */
export const updateSession = async (
  sessionId: string,
  patch: Partial<Omit<PlaybackSession, 'sessionId' | 'createdAt'>>
): Promise<PlaybackSession | null> => {
  const session = await getSession(sessionId)
  if (!session) return null

  const updated: PlaybackSession = {
    ...session,
    ...patch,
    lastActivityAt: new Date().toISOString(),
  }

  // Refresh both keys in one pipeline — keeps TTLs in sync
  const pipeline = redis.pipeline()
  pipeline.setex(sessionKey(sessionId), SESSION_TTL_SECONDS, JSON.stringify(updated))
  pipeline.setex(channelKey(session.nvrId, session.channel), SESSION_TTL_SECONDS, sessionId)
  await pipeline.exec()

  return updated
}

/**
 * Deletes the session AND the channel index atomically.
 * After this, the channel appears free for a new session.
 */
export const deleteSession = async (sessionId: string, nvrId?: string, channel?: number): Promise<void> => {
  const session = nvrId && channel !== undefined ? null : await getSession(sessionId)

  const resolvedNvrId = nvrId ?? session?.nvrId
  const resolvedChannel = channel ?? session?.channel

  const pipeline = redis.pipeline()
  pipeline.del(sessionKey(sessionId))
  if (resolvedNvrId && resolvedChannel !== undefined) {
    pipeline.del(channelKey(resolvedNvrId, resolvedChannel))
  }
  await pipeline.exec()

  console.log(`Playback session deleted: ${sessionId}`)
}

/**
 * Non-blocking cursor-based scan, replacing the original KEYS-based
 * implementation (Phase 7 / Migration Phase I) — safe at any keyspace size.
 */
export const getAllSessions = async (): Promise<PlaybackSession[]> => {
  const list: PlaybackSession[] = []
  let cursor = '0'

  do {
    const [nextCursor, keys] = await redis.scan(cursor, 'MATCH', `${SESSION_PREFIX}*`, 'COUNT', 200)
    cursor = nextCursor

    if (keys.length > 0) {
      const values = await redis.mget(...keys)
      for (const raw of values) {
        if (!raw) continue
        try {
          list.push(normalizeSession(JSON.parse(raw)))
        } catch {
          // skip malformed entries
        }
      }
    }
  } while (cursor !== '0')

  return list
}

// ── Channel index ─────────────────────────────────────────────────────────────

/**
 * Returns the active sessionId for an NVR channel, or null if none.
 * Used by createPlaybackSession to detect and evict existing sessions.
 */
export const getChannelSessionId = async (nvrId: string, channel: number): Promise<string | null> => {
  return redis.get(channelKey(nvrId, channel))
}

/**
 * Clears the channel index without deleting the session.
 * Used only in edge cases — normally deleteSession clears it.
 */
export const clearChannelSession = async (nvrId: string, channel: number): Promise<void> => {
  await redis.del(channelKey(nvrId, channel))
}