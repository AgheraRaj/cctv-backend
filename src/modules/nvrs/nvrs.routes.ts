import { Router } from 'express'
import { authenticate } from '../../middleware/auth.js'
import { requireAdmin } from '../../middleware/requireAdmin.js'
import { getByStation, getById, create, update, remove } from './nvrs.controller.js'

const router = Router({ mergeParams: true })  // needed to access :stationId from parent router

router.get('/', authenticate, getByStation)
router.get('/:id', authenticate, getById)
router.post('/', authenticate, requireAdmin, create)
router.put('/:id', authenticate, requireAdmin, update)
router.delete('/:id', authenticate, requireAdmin, remove)

export default router