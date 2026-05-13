import { Router } from 'express'
import { authenticate } from '../../middleware/auth.js'
import { requireAdmin } from '../../middleware/requireAdmin.js'
import {
  listCameras,
  listRecordings,
  getRecording,
  streamRecordingWithToken,
  removeRecording,
  storageStats,
  issueStreamToken,
  getTimeline,
  getRecordingDays,
  seekToTimestamp,
} from './recordings.controller.js'

const router = Router()

// ─── Static routes first ───────────────────────────────────────────
router.get('/stats', authenticate, requireAdmin, storageStats)
router.post('/token/:id', authenticate, issueStreamToken)
router.get('/stream/:id', streamRecordingWithToken)
router.get('/file/:id', authenticate, getRecording)
router.delete('/file/:id', authenticate, requireAdmin, removeRecording)

// ─── Camera-level routes ───────────────────────────────────────────
router.get('/:nvrId/:channel/timeline', authenticate, getTimeline)
router.get('/:nvrId/:channel/days', authenticate, getRecordingDays)
router.get('/:nvrId/:channel/seek', authenticate, seekToTimestamp)

// ─── List routes last ──────────────────────────────────────────────
router.get('/', authenticate, listCameras)
router.get('/:nvrId/:channel', authenticate, listRecordings)

export default router