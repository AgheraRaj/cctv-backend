import { Router } from 'express'
import { authenticate } from '../../middleware/auth.js'
import { requireAdmin } from '../../middleware/requireAdmin.js'
import {
  getAllUsers,
  getUserById,
  createUser,
  updateUser,
  deleteUser,
  setUserStatus,
  resetUserPassword,
  changeOwnPassword,
} from './user.controller.js'

const router = Router()

// Self-service — any authenticated role (including Viewer) may change their
// own password. Registered before the `/:id/*` routes below so Express
// matches this literal path instead of treating "me" as an :id param.
router.patch('/me/password', authenticate, changeOwnPassword)

// Everything below is user MANAGEMENT — ADMIN and SUPER_ADMIN only.
// Fine-grained "who can touch whom" rules (Admin -> Viewer only,
// Super Admin -> Admin/Viewer only, nobody can touch a Super Admin,
// nobody can touch their own account here) are enforced in
// users.service.ts, not at the route layer.
router.get('/', authenticate, requireAdmin, getAllUsers)
router.get('/:id', authenticate, requireAdmin, getUserById)
router.post('/', authenticate, requireAdmin, createUser)
router.put('/:id', authenticate, requireAdmin, updateUser)
router.delete('/:id', authenticate, requireAdmin, deleteUser)
router.patch('/:id/status', authenticate, requireAdmin, setUserStatus)
router.patch('/:id/password', authenticate, requireAdmin, resetUserPassword)

export default router