import { Router } from 'express'
import { authenticate } from '../../middleware/auth.js'
import { requireAdmin } from '../../middleware/requireAdmin.js'
import { getSlots, getById, create, update, remove } from './cameras.controller.js'

const router = Router({ mergeParams: true })

// GET all 32 slots for an NVR (fills gaps with isActive: false)
router.get('/', authenticate, getSlots)

// GET single camera by id
router.get('/:id', authenticate, getById)

// Admin only — write operations
router.post('/', authenticate, requireAdmin, create)
router.put('/:id', authenticate, requireAdmin, update)
router.delete('/:id', authenticate, requireAdmin, remove)

export default router