import { Response, NextFunction } from 'express'
import { z } from 'zod'
import { AuthRequest } from '../../middleware/auth.js'
import { AppError } from '../../middleware/errorHandler.js'
import { resolveStreams } from './streams.service.js'

const resolveSchema = z.array(
  z.object({
    nvrId: z.string().min(1, 'nvrId is required.'),
    channel: z.number().int().min(1, 'channel must be at least 1.'),
  })
).min(1, 'At least one stream request is required.')
 .max(16, 'Maximum 16 streams per request.')  // limit to one screen grid

export const resolve = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const parsed = resolveSchema.safeParse(req.body)
    if (!parsed.success) {
      throw new AppError(400, parsed.error.issues[0].message)
    }

    const results = await resolveStreams(parsed.data)
    res.status(200).json(results)
  } catch (err) {
    next(err)
  }
}