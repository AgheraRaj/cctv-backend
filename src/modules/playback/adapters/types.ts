/**
 * adapters/types.ts
 *
 * The VendorPlaybackAdapter contract. Exactly two implementers exist
 * (HikvisionAdapter, HiFocusAdapter) and none are planned — this is NOT a
 * generic multi-vendor abstraction. It exists purely to move vendor-specific
 * logic out of PlaybackService's orchestration code and into testable,
 * independently-changeable units (Phase 2).
 */
import type { RecordingSegment } from '../hikvision.search.js'

export type NVRType = 'HIKVISION' | 'HIFOCUS'

export interface AdapterNVR {
  type: NVRType
  ip: string
  httpPort: number
  rtspPort: number
  username: string
}

/**
 * Opaque per-vendor state carried inside PlaybackSession.vendorMeta.
 * PlaybackSessionManager never inspects its contents — only the adapter that
 * produced it ever reads/writes keys inside it (Phase 7).
 *
 * For Hikvision this is always {}.
 * For HiFocus this holds { tzOffsetMs } — the empirically-derived NVR
 * timezone offset, cached after the first ONVIF GetReplayUri call so every
 * subsequent seek skips the round-trip entirely (Phase 5).
 */
export type VendorMeta = Record<string, unknown>

export interface StreamSource {
  rtspUrl: string
  vendorMeta: VendorMeta
}

export interface VendorPlaybackAdapter {
  readonly vendorType: NVRType

  /** Vendor-normalized recording search — always returns the shared RecordingSegment shape. */
  searchRecordings(
    nvr: AdapterNVR,
    password: string,
    channel: number,
    startTime: Date,
    endTime: Date
  ): Promise<RecordingSegment[]>

  /**
   * Builds a ready-to-use RTSP source URL for the given time range.
   * `previousVendorMeta` is passed on seeks so vendors that need a one-time
   * round-trip (HiFocus) can skip it on subsequent calls. Hikvision ignores it.
   */
  buildStreamSource(
    nvr: AdapterNVR,
    password: string,
    channel: number,
    startTime: Date,
    endTime: Date,
    previousVendorMeta: VendorMeta
  ): Promise<StreamSource>

  /** Whether this vendor's playback backend tolerates a client-side pause (stream kept open, not consumed). */
  supportsPause(): boolean

  /** Whether this vendor supports the given trick-play speed at the NVR/RTSP level (not client-side rate control). */
  supportsSpeed(speed: number): boolean
}