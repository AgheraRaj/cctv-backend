import { Router } from 'express'
import { authenticate } from '../../middleware/auth.js'
import { resolve, seek, stop, recordings } from './playback.controller.js'

const router = Router()

router.post('/resolve',                       authenticate, resolve)
router.post('/seek',                          authenticate, seek)
router.delete('/:pathName',                   authenticate, stop)
router.get('/recordings/:nvrId/:channel',     authenticate, recordings)

export default router