import bcrypt from 'bcrypt'
import jwt, { SignOptions } from 'jsonwebtoken'
import prisma from '../../config/db.js'
import { env } from '../../config/env.js'
import { AppError } from '../../middleware/errorHandler.js'

export const loginService = async (email: string, password: string) => {
  const user = await prisma.user.findUnique({ where: { email } })

  if (!user) {
    throw new AppError(401, 'Invalid email or password.')
  }

  const isMatch = await bcrypt.compare(password, user.password)

  if (!isMatch) {
    throw new AppError(401, 'Invalid email or password.')
  }

  if (!user.isActive) {
    throw new AppError(403, 'Account has been disabled. Contact your administrator.')
  }

  const token = jwt.sign(
  { id: user.id, email: user.email, role: user.role },
  env.JWT_SECRET,
  { expiresIn: env.JWT_EXPIRES_IN as SignOptions['expiresIn'] }
)
  // Never return password in response
  const { password: _, ...userWithoutPassword } = user

  return { token, user: userWithoutPassword }
}

export const getMeService = async (userId: string) => {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      email: true,
      role: true,
      isActive: true,
      createdAt: true,
    },
  })

  if (!user) {
    throw new AppError(404, 'User not found.')
  }

  return user
}