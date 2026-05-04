import { Router } from 'express'
import { login, getMe } from './auth.controller.js'
import { authenticate } from '../../middleware/auth.js'

const router = Router()

router.post('/login', login)
router.get('/me', authenticate, getMe)

export default router