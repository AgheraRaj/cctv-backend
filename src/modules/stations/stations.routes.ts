import { Router } from 'express'
import { authenticate } from '../../middleware/auth.js'
import { requireAdmin } from '../../middleware/requireAdmin.js'
import { getAll, getById, create, update, remove } from './stations.controller.js'

const router = Router()

// Any logged-in user can view stations
router.get('/', authenticate, getAll)
router.get('/:id', authenticate, getById)

// Admin only — write operations
router.post('/', authenticate, requireAdmin, create)
router.put('/:id', authenticate, requireAdmin, update)
router.delete('/:id', authenticate, requireAdmin, remove)

export default router