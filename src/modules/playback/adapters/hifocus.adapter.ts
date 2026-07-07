/**
 * adapters/hifocus.adapter.ts
 *
 * Wraps the existing, unchanged HiFocus playback internals
 * (hifocus.replay.ts, hifocus.search.ts) behind the shared
 * VendorPlaybackAdapter contract.
 *
 * The one piece of real per-call logic: on the FIRST buildStreamSource call
 * for a session, it does the ONVIF GetReplayUri round-trip and derives
 * tzOffsetMs empirically (see hifocus.replay.ts's own header comment for why
 * — the NVR reports local time with no explicit timezone field). That offset
 * is returned in vendorMeta and must be passed back in on every subsequent
 * call (seek) so the round-trip is skipped — exactly matching the original
 * `cachedTzOffsetMs === 0` branch in playback.service.ts's old buildRtspUrl.
 */
import { getHifocusReplayInfo, buildHifocusRtspUrl } from '../hifocus.replay.js'
import { searchHifocusRecordings } from '../hifocus.search.js'
import type { RecordingSegment } from '../hikvision.search.js'
import type { AdapterNVR, StreamSource, VendorMeta, VendorPlaybackAdapter } from './types.js'

class HiFocusAdapter implements VendorPlaybackAdapter {
  readonly vendorType = 'HIFOCUS' as const

  async searchRecordings(
    nvr: AdapterNVR,
    password: string,
    channel: number,
    startTime: Date,
    endTime: Date
  ): Promise<RecordingSegment[]> {
    return searchHifocusRecordings(nvr.ip, nvr.httpPort, nvr.username, password, channel, startTime, endTime)
  }

  async buildStreamSource(
    nvr: AdapterNVR,
    password: string,
    channel: number,
    startTime: Date,
    endTime: Date,
    previousVendorMeta: VendorMeta
  ): Promise<StreamSource> {
    if (endTime <= startTime) {
      throw new Error('endTime must be after startTime')
    }

    const cachedTzOffsetMs = typeof previousVendorMeta.tzOffsetMs === 'number' ? previousVendorMeta.tzOffsetMs : 0

    // Subsequent calls (seek) — skip the ONVIF round-trip entirely using the
    // offset cached from session creation. This is why HiFocus seeks cost
    // the same as Hikvision's despite the heavier vendor protocol (Phase 5).
    if (cachedTzOffsetMs !== 0) {
      const rtspUrl = buildHifocusRtspUrl(
        nvr.ip,
        nvr.rtspPort,
        nvr.username,
        password,
        channel,
        startTime,
        endTime,
        cachedTzOffsetMs
      )
      return { rtspUrl, vendorMeta: { tzOffsetMs: cachedTzOffsetMs } }
    }

    // First call for this session — one ONVIF SOAP round-trip.
    const { rtspUrl, tzOffsetMs } = await getHifocusReplayInfo(
      nvr.ip,
      nvr.httpPort,
      nvr.rtspPort,
      nvr.username,
      password,
      channel,
      startTime,
      endTime
    )

    return { rtspUrl, vendorMeta: { tzOffsetMs } }
  }

  supportsPause(): boolean {
    // Client-side pause by default. Flip to false for specific firmware
    // known to close the RTSP source under HLS-consumer backpressure
    // (Phase 3 §7) — left true here since no such firmware has been
    // identified yet in this project.
    return true
  }

  supportsSpeed(_speed: number): boolean {
    return false // ONVIF Replay trick-play support is inconsistent across HiFocus firmware; client-side only (Phase 5)
  }
}

export const hifocusAdapter = new HiFocusAdapter()