import { Router } from 'express'
import { authenticate } from '../../middleware/auth.js'
import { resolve, stop, recordings } from './playback.controller.js'

const router = Router()

// Both ADMIN and VIEWER can access playback
router.post('/resolve', authenticate, resolve)
router.delete('/:pathName', authenticate, stop)
router.get('/recordings/:nvrId/:channel', authenticate, recordings)

export default router