import { Router } from 'express'
import { authenticate } from '../../middleware/auth.js'
import { requireAdmin } from '../../middleware/requireAdmin.js'
import {
  startDetection,
  stopDetection,
  getDetectionStatus,
} from './detection.controller.js'

const router = Router({ mergeParams: true })

// Only admin can start/stop detection
router.post('/start', authenticate, requireAdmin, startDetection)
router.post('/stop', authenticate, requireAdmin, stopDetection)

// Both admin and viewer can check status
router.get('/status', authenticate, getDetectionStatus)

export default router