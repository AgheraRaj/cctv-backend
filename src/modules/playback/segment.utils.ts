// src/modules/playback/segment.utils.ts
//
// Vendor-agnostic post-processing for recording search results. Works on the
// same RecordingSegment[] shape both hikvision.search.ts and hifocus.search.ts
// already produce, so it can sit in front of either adapter's raw output.
//
// Pipeline: mergeIntervals -> findRecordingGaps (optional) -> splitIntoFixedDurationSegments -> toSegmentDTOs

import type { RecordingSegment } from './hikvision.search.js'

// ── Merge overlapping/adjacent intervals ────────────────────────────────────
// Collapses raw NVR items (which may include overlapping event-type entries,
// e.g. HiFocus INTELLIGENT/MOTION items nested inside a SCHEDULE block) into
// real continuous recording blocks. Safe default when it's unconfirmed
// whether event-triggered recTypes can have footage outside a SCHEDULE
// window — if they always nest inside, this is a no-op vs. SCHEDULE-only.

export const mergeIntervals = (
  segments: RecordingSegment[],
  toleranceMs: number = 1000 // items within 1s of each other count as continuous
): RecordingSegment[] => {
  if (segments.length === 0) return []

  const sorted = [...segments].sort((a, b) => a.startTime.getTime() - b.startTime.getTime())
  const merged: RecordingSegment[] = [{ ...sorted[0] }]

  for (let i = 1; i < sorted.length; i++) {
    const last = merged[merged.length - 1]
    const current = sorted[i]

    if (current.startTime.getTime() <= last.endTime.getTime() + toleranceMs) {
      if (current.endTime.getTime() > last.endTime.getTime()) last.endTime = current.endTime
    } else {
      merged.push({ ...current })
    }
  }

  return merged
}

// ── Gap detection ────────────────────────────────────────────────────────────
// Must be called on merged (or otherwise raw/unsplit) segments — hourly-split
// chunks are contiguous by construction and would produce false zero-length
// "gaps" at every chunk boundary.

export interface RecordingGap {
  channel: number
  gapStart: Date // when recording stopped
  gapEnd: Date // when recording resumed
  durationMs: number
}

export const findRecordingGaps = (
  segments: RecordingSegment[],
  minGapMs: number = 1000 // ignore sub-second jitter as a "gap"
): RecordingGap[] => {
  const sorted = [...segments].sort((a, b) => a.startTime.getTime() - b.startTime.getTime())
  const gaps: RecordingGap[] = []

  for (let i = 1; i < sorted.length; i++) {
    const prevEnd = sorted[i - 1].endTime
    const nextStart = sorted[i].startTime
    const durationMs = nextStart.getTime() - prevEnd.getTime()

    if (durationMs > minGapMs) {
      gaps.push({ channel: sorted[i].channel, gapStart: prevEnd, gapEnd: nextStart, durationMs })
    }
  }

  return gaps
}

// ── Hourly (fixed-duration) split ────────────────────────────────────────────
// Splits each raw segment into fixed-duration chunks measured from that
// segment's own start time (not clock-aligned). Never bridges across two
// separate raw segments, so real recording gaps are preserved automatically —
// chunking only ever happens inside one continuous block.

export const splitIntoFixedDurationSegments = (
  segments: RecordingSegment[],
  intervalMs: number = 60 * 60 * 1000
): RecordingSegment[] => {
  const result: RecordingSegment[] = []

  for (const seg of segments) {
    let chunkStart = new Date(seg.startTime)

    while (chunkStart < seg.endTime) {
      const chunkEnd = new Date(Math.min(chunkStart.getTime() + intervalMs, seg.endTime.getTime()))
      result.push({ channel: seg.channel, startTime: chunkStart, endTime: chunkEnd })
      chunkStart = chunkEnd
    }
  }

  return result
}

// ── Frontend DTO ──────────────────────────────────────────────────────────────
// Strips everything except what the client actually needs. Kept as a separate
// mapping step (rather than trimming fields earlier in the pipeline) so
// channel/recType/etc. stay available internally for logging if needed.

export interface PlaybackSegmentDTO {
  startTime: string
  endTime: string
}

export const toSegmentDTOs = (segments: RecordingSegment[]): PlaybackSegmentDTO[] =>
  segments.map((s) => ({
    startTime: s.startTime.toISOString(),
    endTime: s.endTime.toISOString(),
  }))