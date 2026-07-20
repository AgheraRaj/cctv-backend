// src/modules/playback/download/strategies/hifocus.strategy.ts
//
// HiFocus download strategy.
//
// WHY NO NATIVE DOWNLOAD API:
//   HiFocus NVRs expose playback only via ONVIF GetReplayUri (RTSP) and do
//   not provide any documented HTTP file export endpoint in their ONVIF or
//   proprietary API surface. Unlike Hikvision's ISAPI, there is no
//   ContentMgmt/download equivalent. RTSP + ffmpeg is the only option.
//
// This class exists purely for the strategy pattern — it delegates entirely
// to RtspDownloadStrategy. Having a named HiFocus strategy keeps the service
// layer clean (callers don't need to know "HiFocus uses RTSP") and makes it
// easy to add a native API here in the future if HiFocus ever documents one.

import type { NVR } from '@prisma/client'
import type { DownloadContext, DownloadStrategy } from '../types.js'

import { RtspDownloadStrategy } from './rtsp.strategy.js'

export class HifocusDownloadStrategy implements DownloadStrategy {
  readonly name = 'hifocus-rtsp'

  private readonly rtsp = new RtspDownloadStrategy()

  supports(nvr: NVR): boolean {
    return nvr.type === 'HIFOCUS'
  }

  async download(ctx: DownloadContext): Promise<void> {
    console.log(
      `[${this.name}] HiFocus has no native HTTP download API — using RTSP+ffmpeg. ` +
      `Note: download speed is limited to 1× real-time by the NVR's RTSP playback server.`
    )
    return this.rtsp.download(ctx)
  }
}