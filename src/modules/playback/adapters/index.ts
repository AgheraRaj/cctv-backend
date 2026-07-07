/**
 * adapters/index.ts
 *
 * Deliberately a plain two-branch switch, not a registry/factory pattern.
 * This project supports exactly Hikvision and HiFocus, permanently — a
 * factory class would only add indirection for a set of vendors that will
 * never grow (Phase 2's explicit rationale).
 */
import { AppError } from '../../../middleware/errorHandler.js'
import { hikvisionAdapter } from './hikvision.adapter.js'
import { hifocusAdapter } from './hifocus.adapter.js'
import type { NVRType, VendorPlaybackAdapter } from './types.js'

export const getAdapter = (vendorType: NVRType): VendorPlaybackAdapter => {
  if (vendorType === 'HIKVISION') return hikvisionAdapter
  if (vendorType === 'HIFOCUS') return hifocusAdapter
  throw new AppError(400, `Unsupported NVR type: ${vendorType}`)
}

export type { VendorPlaybackAdapter, AdapterNVR, StreamSource, VendorMeta, NVRType } from './types.js'