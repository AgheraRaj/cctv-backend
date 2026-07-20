import { Router } from 'express';
import { getAuditLogs } from './audit.controller.js';
import { authenticate } from '../../middleware/auth.js';
import { requireAdmin } from '../../middleware/requireAdmin.js';

const router = Router();

// Only ADMIN users should view audit logs
router.get('/', authenticate, requireAdmin, getAuditLogs);

export default router;
