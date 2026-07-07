import { Router } from 'express'
import { authenticate } from '../../middleware/auth.js'
import { recordingDays, recordings } from './playback.controller.js'
import { streamRecording } from './playback.stream.js'

const router = Router()

router.get('/recording-days/:nvrId/:channel', authenticate, recordingDays)
router.get('/recordings/:nvrId/:channel',     authenticate, recordings)
router.get('/stream',                          authenticate, streamRecording)

export default router