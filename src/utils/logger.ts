/**
 * logger.ts — Console-only logger shim.
 *
 * File-based logging has been removed. All audit-worthy events are written
 * directly to the database via addAuditLog() (audit.queue.ts → AuditLog table).
 *
 * This thin wrapper keeps the same surface area as the old Winston logger so
 * callers can be migrated incrementally, but all output goes only to the
 * console — no files are written.
 */

const logger = {
  info:  (...args: unknown[]) => console.log('[INFO]', ...args),
  warn:  (...args: unknown[]) => console.warn('[WARN]', ...args),
  error: (...args: unknown[]) => console.error('[ERROR]', ...args),
  debug: (...args: unknown[]) => console.debug('[DEBUG]', ...args),
}

export default logger