/**
 * adapters/hikvision.adapter.ts
 *
 * Wraps the existing, unchanged Hikvision playback internals
 * (playback.generator.ts, hikvision.search.ts) behind the shared
 * VendorPlaybackAdapter contract. No NVR round-trip is needed to build a
 * playback URL — it's a pure, deterministic string builder — so
 * buildStreamSource never uses previousVendorMeta and always returns {}.
 */
import { generatePlaybackRTSP } from '../playback.generator.js'
import { searchHikvisionRecordings, type RecordingSegment } from '../hikvision.search.js'
import type { AdapterNVR, StreamSource, VendorMeta, VendorPlaybackAdapter } from './types.js'

class HikvisionAdapter implements VendorPlaybackAdapter {
  readonly vendorType = 'HIKVISION' as const

  async searchRecordings(
    nvr: AdapterNVR,
    password: string,
    channel: number,
    startTime: Date,
    endTime: Date
  ): Promise<RecordingSegment[]> {
    return searchHikvisionRecordings(nvr.ip, nvr.httpPort, nvr.username, password, channel, startTime, endTime)
  }

  async buildStreamSource(
    nvr: AdapterNVR,
    password: string,
    channel: number,
    startTime: Date,
    endTime: Date,
    _previousVendorMeta: VendorMeta
  ): Promise<StreamSource> {
    if (endTime <= startTime) {
      throw new Error('endTime must be after startTime')
    }

    const rtspUrl = generatePlaybackRTSP(
      { username: nvr.username, password, ip: nvr.ip, rtspPort: nvr.rtspPort, type: 'HIKVISION' },
      channel,
      startTime,
      endTime
    )

    // No vendor round-trip → no state to cache between calls.
    return { rtspUrl, vendorMeta: {} }
  }

  supportsPause(): boolean {
    return true // client-side pause — see Phase 3 §7 / Phase 9
  }

  supportsSpeed(_speed: number): boolean {
    return false // no NVR-native trick-play wiring; client-side speed only (Phase 4)
  }
}

export const hikvisionAdapter = new HikvisionAdapter()