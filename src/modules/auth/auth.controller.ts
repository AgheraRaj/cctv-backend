import { Request, Response, NextFunction } from 'express'
import { loginService, getMeService } from './auth.service.js'
import { AuthRequest } from '../../middleware/auth.js'
import { z } from 'zod'
import { AppError } from '../../middleware/errorHandler.js'

const loginSchema = z.object({
  email: z.string().email('Invalid email format.'),
  password: z.string().min(1, 'Password is required.'),
})

export const login = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const parsed = loginSchema.safeParse(req.body)

    if (!parsed.success) {
      throw new AppError(400, parsed.error.issues[0].message)
    }

    const { email, password } = parsed.data
    const result = await loginService(email, password)

    res.status(200).json(result)
  } catch (err) {
    next(err)
  }
}

export const getMe = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    if (!req.user?.id) {
      throw new AppError(401, 'Unauthorized.')
    }

    const user = await getMeService(req.user.id)
    res.status(200).json(user)
  } catch (err) {
    next(err)
  }
}