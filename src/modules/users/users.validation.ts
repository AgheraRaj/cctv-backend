import { z } from 'zod'

// SUPER_ADMIN is intentionally excluded here. Nobody — not even another
// Super Admin — can create or promote a user to SUPER_ADMIN through the
// API. Super Admin accounts are only ever provisioned by the seed script
// or a trusted operational process outside the app. This single line closes
// off the most dangerous privilege-escalation path in the whole system.
export const assignableRoleSchema = z.enum(['ADMIN', 'VIEWER'])

const passwordSchema = z
  .string()
  .min(8, 'Password must be at least 8 characters.')
  .regex(/[A-Z]/, 'Password must contain at least one uppercase letter.')
  .regex(/[a-z]/, 'Password must contain at least one lowercase letter.')
  .regex(/[0-9]/, 'Password must contain at least one number.')

export const createUserSchema = z.object({
  email: z.string().email('Invalid email format.'),
  password: passwordSchema,
  role: assignableRoleSchema.default('VIEWER'),
})

export const updateUserSchema = z
  .object({
    email: z.string().email('Invalid email format.').optional(),
    role: assignableRoleSchema.optional(),
  })
  .refine((data) => Object.keys(data).length > 0, {
    message: 'At least one field must be provided.',
  })

export const setStatusSchema = z.object({
  isActive: z.boolean(),
})

export const resetPasswordSchema = z.object({
  password: passwordSchema,
})

export const changeOwnPasswordSchema = z.object({
  currentPassword: z.string().min(1, 'Current password is required.'),
  newPassword: passwordSchema,
})