import { Router } from 'express'
import { authenticate } from '../../middleware/auth.js'
import { getActiveDetection } from './detection.controller.js'

const router = Router()

router.get('/active', authenticate, getActiveDetection)

export default router