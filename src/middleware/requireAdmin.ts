import { Response, NextFunction } from 'express'
import { AuthRequest, UserRole } from './auth.js'
import { AppError } from './errorHandler.js'

// Numeric rank, used only for "at least this privileged" checks like
// requireMinRole. The fine-grained "who can create/edit/delete whom" rules
// for user management live in src/modules/users/users.service.ts — role
// rank alone isn't expressive enough for those (e.g. an Admin must not be
// able to touch another Admin even though they outrank a Viewer).
const ROLE_RANK: Record<UserRole, number> = {
  VIEWER: 0,
  ADMIN: 1,
  SUPER_ADMIN: 2,
}

export const requireRole = (...allowedRoles: UserRole[]) => {
  return (req: AuthRequest, _res: Response, next: NextFunction): void => {
    if (!req.user || !allowedRoles.includes(req.user.role)) {
      next(new AppError(403, 'You do not have permission to perform this action.'))
      return
    }
    next()
  }
}

export const requireMinRole = (minRole: UserRole) => {
  return (req: AuthRequest, _res: Response, next: NextFunction): void => {
    if (!req.user || ROLE_RANK[req.user.role] < ROLE_RANK[minRole]) {
      next(new AppError(403, 'You do not have permission to perform this action.'))
      return
    }
    next()
  }
}

// ADMIN and SUPER_ADMIN both get full application access outside of the
// user-management restrictions enforced in the users module. This keeps the
// existing import (`import { requireAdmin } from '.../requireAdmin.js'`)
// working unchanged across cameras, nvrs, detection, and audit routes —
// Super Admins now pass this check too, exactly as they should.
export const requireAdmin = requireRole('ADMIN', 'SUPER_ADMIN')

// Reserved for the rare action that only a Super Admin may perform.
export const requireSuperAdmin = requireRole('SUPER_ADMIN')