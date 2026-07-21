import bcrypt from 'bcrypt'
import prisma from '../../config/db.js'
import { AppError } from '../../middleware/errorHandler.js'
import { UserRole } from '../../middleware/auth.js'

type Actor = { id: string; email: string; role: UserRole }

const SELECT_SAFE = {
  id: true,
  email: true,
  role: true,
  isActive: true,
  createdAt: true,
  updatedAt: true,
} as const

// Who each role is allowed to CREATE / UPDATE / DELETE / DISABLE / RESET
// THE PASSWORD OF. Read access (list all / get one) is handled separately
// in listUsers/getUser — both ADMIN and SUPER_ADMIN may view every account
// regardless of this table, per spec ("Admin: view all users").
//
// Note SUPER_ADMIN cannot manage SUPER_ADMIN, and ADMIN cannot manage ADMIN.
// That single property is also what gives us self-protection for free:
// nobody's own account ever appears in their own "manageable" set, so an
// Admin can never edit/disable/delete themselves through these endpoints.
// We still add an explicit self-check below for a clearer error message.
const MANAGEABLE_TARGETS: Record<UserRole, UserRole[]> = {
  SUPER_ADMIN: ['ADMIN', 'VIEWER'],
  ADMIN: ['VIEWER'],
  VIEWER: [],
}

const humanRole = (role: UserRole) => role.replace('_', ' ')

const assertCanManage = (actor: Actor, targetRole: UserRole, action: string) => {
  if (!MANAGEABLE_TARGETS[actor.role].includes(targetRole)) {
    throw new AppError(
      403,
      `${humanRole(actor.role)} accounts cannot ${action} ${humanRole(targetRole)} accounts.`
    )
  }
}

const getUserOr404 = async (id: string) => {
  const user = await prisma.user.findUnique({ where: { id } })
  if (!user) throw new AppError(404, 'User not found.')
  return user
}

export const listUsers = async (_actor: Actor) => {
  return prisma.user.findMany({ select: SELECT_SAFE, orderBy: { createdAt: 'desc' } })
}

export const getUser = async (_actor: Actor, targetId: string) => {
  const user = await prisma.user.findUnique({ where: { id: targetId }, select: SELECT_SAFE })
  if (!user) throw new AppError(404, 'User not found.')
  return user
}

export const createUser = async (
  actor: Actor,
  data: { email: string; password: string; role: 'ADMIN' | 'VIEWER' }
) => {
  assertCanManage(actor, data.role, 'create')

  const hashedPassword = await bcrypt.hash(data.password, 10)

  return prisma.user.create({
    data: {
      email: data.email,
      password: hashedPassword,
      role: data.role,
    },
    select: SELECT_SAFE,
  })
}

export const updateUser = async (
  actor: Actor,
  targetId: string,
  data: { email?: string; role?: 'ADMIN' | 'VIEWER' }
) => {
  if (targetId === actor.id) {
    throw new AppError(403, 'You cannot modify your own account through this endpoint.')
  }

  const target = await getUserOr404(targetId)
  assertCanManage(actor, target.role as UserRole, 'update')

  if (data.role) {
    // Re-check against the *new* role too. Without this, an Admin could
    // take a Viewer they're allowed to edit and flip their role to Admin —
    // a textbook privilege-escalation-by-proxy bug.
    assertCanManage(actor, data.role, 'assign the role of')
  }

  return prisma.user.update({
    where: { id: targetId },
    data,
    select: SELECT_SAFE,
  })
}

export const deleteUser = async (actor: Actor, targetId: string) => {
  if (targetId === actor.id) {
    throw new AppError(403, 'You cannot delete your own account.')
  }

  const target = await getUserOr404(targetId)
  assertCanManage(actor, target.role as UserRole, 'delete')

  await prisma.user.delete({ where: { id: targetId } })
}

export const setUserStatus = async (actor: Actor, targetId: string, isActive: boolean) => {
  if (targetId === actor.id) {
    throw new AppError(403, 'You cannot enable or disable your own account.')
  }

  const target = await getUserOr404(targetId)
  assertCanManage(actor, target.role as UserRole, isActive ? 'enable' : 'disable')

  return prisma.user.update({
    where: { id: targetId },
    data: { isActive },
    select: SELECT_SAFE,
  })
}

export const resetUserPassword = async (actor: Actor, targetId: string, newPassword: string) => {
  if (targetId === actor.id) {
    throw new AppError(400, 'Use PATCH /api/users/me/password to change your own password.')
  }

  const target = await getUserOr404(targetId)
  assertCanManage(actor, target.role as UserRole, "reset the password of")

  const hashedPassword = await bcrypt.hash(newPassword, 10)

  await prisma.user.update({
    where: { id: targetId },
    data: { password: hashedPassword },
  })
}

export const changeOwnPassword = async (
  actor: Actor,
  currentPassword: string,
  newPassword: string
) => {
  const user = await getUserOr404(actor.id)

  const isMatch = await bcrypt.compare(currentPassword, user.password)
  if (!isMatch) {
    throw new AppError(401, 'Current password is incorrect.')
  }

  const hashedPassword = await bcrypt.hash(newPassword, 10)

  await prisma.user.update({
    where: { id: actor.id },
    data: { password: hashedPassword },
  })
}