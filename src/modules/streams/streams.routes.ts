import { Router } from 'express'
import { authenticate } from '../../middleware/auth.js'
import { resolve } from './streams.controller.js'

const router = Router()

// Both ADMIN and VIEWER can resolve streams
router.post('/resolve', authenticate, resolve)

export default router