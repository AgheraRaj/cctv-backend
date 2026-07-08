// src/modules/playback/playback.routes.ts
// Replace the existing download import and route with these:

import { Router } from 'express'
import { authenticate } from '../../middleware/auth.js'
import { recordings, recordingDays } from './playback.controller.js'
import { streamRecording } from './playback.stream.js'
import { downloadRecording } from './download/download.controller.js'

const router = Router()

router.get('/recording-days/:nvrId/:channel', authenticate, recordingDays)
router.get('/recordings/:nvrId/:channel',     authenticate, recordings)
router.get('/stream',                          authenticate, streamRecording)
router.get('/download',                        authenticate, downloadRecording)  // same URL, new handler

export default router