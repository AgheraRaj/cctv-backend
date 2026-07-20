import { PrismaClient } from '@prisma/client'
import { PrismaPg } from '@prisma/adapter-pg'
import { env } from './env.js'
import { asyncLocalStorage } from '../middleware/asyncContext.js'
import { addAuditLog } from '../modules/audit/audit.queue.js'
import { sanitizePayload } from '../utils/sanitize.js'

const WRITE_OPERATIONS = new Set(['create', 'update', 'delete', 'createMany', 'updateMany', 'deleteMany', 'upsert'])

const adapter = new PrismaPg({ connectionString: env.DATABASE_URL })

const prismaBase = new PrismaClient({
  adapter,
  log: env.NODE_ENV === 'development' ? ['query', 'error', 'warn'] : ['error'],
})

const prisma = prismaBase.$extends({
  query: {
    $allModels: {
      async $allOperations({ model, operation, args, query }) {
        // Never audit the AuditLog table itself — prevents infinite loops
        if ((model as string) === 'AuditLog') {
          return (query as Function)(args)
        }

        // Fetch old record before mutation so we can diff it in the audit log
        let oldValues: any = undefined
        if ((operation === 'update' || operation === 'upsert' || operation === 'delete') && (args as any).where) {
          try {
            const modelDelegate = (prismaBase as any)[model!.charAt(0).toLowerCase() + model!.slice(1)]
            if (modelDelegate?.findFirst) {
              const existing = await modelDelegate.findFirst({ where: (args as any).where })
              if (existing) oldValues = sanitizePayload(existing)
            }
          } catch {
            // If pre-fetch fails, continue without oldValues
          }
        }

        const result = await query(args)

        if (WRITE_OPERATIONS.has(operation)) {
          const store = asyncLocalStorage.getStore()

          let newValues: any = undefined
          let resourceId: string | undefined = undefined

          if (operation === 'create' || operation === 'update' || operation === 'upsert') {
            newValues = sanitizePayload((args as any).data)
            if (result && typeof result === 'object' && 'id' in result) {
              resourceId = String((result as any).id)
            }
          } else if (operation === 'delete') {
            if (result && typeof result === 'object' && 'id' in result) {
              resourceId = String((result as any).id)
            }
          }

          // store is undefined for background jobs — those are SYSTEM actions
          const isSystemAction = !store

          addAuditLog({
            userId: store?.userId,
            userEmail: store?.userEmail,
            action: isSystemAction ? `SYSTEM_${operation.toUpperCase()}` : operation.toUpperCase(),
            resourceType: model ?? 'UNKNOWN',
            resourceId,
            newValues,
            oldValues,
            ipAddress: store?.ipAddress,
            userAgent: store?.userAgent,
            requestId: store?.requestId,
          })
        }

        return result
      },
    },
  },
})

export default prisma as unknown as typeof prismaBase