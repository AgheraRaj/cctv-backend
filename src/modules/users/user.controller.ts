import { Response, NextFunction } from 'express'
import { AuthRequest } from '../../middleware/auth.js'
import { AppError } from '../../middleware/errorHandler.js'
import {
  createUserSchema,
  updateUserSchema,
  setStatusSchema,
  resetPasswordSchema,
  changeOwnPasswordSchema,
} from './users.validation.js'
import * as usersService from './user.service.js'

const actorFrom = (req: AuthRequest) => {
  if (!req.user) throw new AppError(401, 'Unauthorized.')
  return req.user
}

export const getAllUsers = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const users = await usersService.listUsers(actorFrom(req))
    res.status(200).json(users)
  } catch (err) {
    next(err)
  }
}

export const getUserById = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const user = await usersService.getUser(actorFrom(req), req.params.id as string)
    res.status(200).json(user)
  } catch (err) {
    next(err)
  }
}

export const createUser = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const parsed = createUserSchema.safeParse(req.body)
    if (!parsed.success) throw new AppError(400, parsed.error.issues[0].message)

    const user = await usersService.createUser(actorFrom(req), parsed.data)
    res.status(201).json(user)
  } catch (err) {
    next(err)
  }
}

export const updateUser = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const parsed = updateUserSchema.safeParse(req.body)
    if (!parsed.success) throw new AppError(400, parsed.error.issues[0].message)

    const user = await usersService.updateUser(
      actorFrom(req),
      req.params.id as string,
      parsed.data
    )
    res.status(200).json(user)
  } catch (err) {
    next(err)
  }
}

export const deleteUser = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    await usersService.deleteUser(actorFrom(req), req.params.id as string)
    res.status(200).json({ message: 'User deleted successfully.' })
  } catch (err) {
    next(err)
  }
}

export const setUserStatus = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const parsed = setStatusSchema.safeParse(req.body)
    if (!parsed.success) throw new AppError(400, parsed.error.issues[0].message)

    const user = await usersService.setUserStatus(
      actorFrom(req),
      req.params.id as string,
      parsed.data.isActive
    )
    res.status(200).json(user)
  } catch (err) {
    next(err)
  }
}

export const resetUserPassword = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const parsed = resetPasswordSchema.safeParse(req.body)
    if (!parsed.success) throw new AppError(400, parsed.error.issues[0].message)

    await usersService.resetUserPassword(
      actorFrom(req),
      req.params.id as string,
      parsed.data.password
    )
    res.status(200).json({ message: 'Password reset successfully.' })
  } catch (err) {
    next(err)
  }
}

export const changeOwnPassword = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const parsed = changeOwnPasswordSchema.safeParse(req.body)
    if (!parsed.success) throw new AppError(400, parsed.error.issues[0].message)

    await usersService.changeOwnPassword(
      actorFrom(req),
      parsed.data.currentPassword,
      parsed.data.newPassword
    )
    res.status(200).json({ message: 'Password updated successfully.' })
  } catch (err) {
    next(err)
  }
}