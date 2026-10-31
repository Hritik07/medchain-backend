/**
 * Admin review of providers (mounted at /api/v1/admin/providers, admin token required).
 *   GET  /?status=pending|verified|rejected|all&type=   verification queue (default: pending)
 *   POST /:providerId/verify                            approve -> its staff can log in and request consent
 *   POST /:providerId/reject   {reason}                 reject (or suspend a verified one) -> staff blocked immediately
 */
import { Router } from 'express';
import { z } from 'zod';
import { query } from '../db/yugabyte';
import { AppError } from '../middleware/errors';
import { asyncHandler } from '../middleware/asyncHandler';
import { requireAuth, requireRole } from '../auth/middleware';
import { toProviderDto, type ProviderJoin, type ProviderRow } from './service';

export const adminProvidersRouter = Router();
adminProvidersRouter.use(requireAuth, requireRole('admin'));

const ListQuery = z.object({
  status: z.enum(['pending', 'verified', 'rejected', 'all']).default('pending'),
  type: z.enum(['doctor', 'pharmacy', 'diagnostic']).optional(),
});
const Uuid = z.string().uuid('providerId must be a valid id');
const RejectBody = z.object({ reason: z.string().trim().min(3).max(300) });

adminProvidersRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const q = ListQuery.parse(req.query);
    const { rows } = await query<ProviderRow & ProviderJoin>(
      `SELECT p.*, s.name AS staff_name, s.email AS staff_email,
              (SELECT count(*) FROM users x WHERE x.provider_id = p.id) AS staff_count
         FROM providers p
         LEFT JOIN LATERAL (
           SELECT name, email FROM users WHERE provider_id = p.id ORDER BY created_at LIMIT 1
         ) s ON true
        WHERE ($1 = 'all' OR p.verified_status = $1)
          AND ($2::text IS NULL OR p.type = $2)
        ORDER BY p.created_at DESC
        LIMIT 200`,
      [q.status, q.type ?? null],
    );
    res.json({ providers: rows.map(toProviderDto) });
  }),
);

adminProvidersRouter.post(
  '/:providerId/verify',
  asyncHandler(async (req, res) => {
    const id = Uuid.parse(req.params.providerId);
    const { rows } = await query<ProviderRow>(
      `UPDATE providers SET verified_status = 'verified', verified_at = now(), reviewed_by = $2, rejection_reason = NULL
        WHERE id = $1 AND verified_status <> 'verified' RETURNING *`,
      [id, req.user!.id],
    );
    if (!rows[0]) {
      const exists = await query('SELECT 1 FROM providers WHERE id = $1', [id]);
      if (!exists.rowCount) throw new AppError(404, 'PROVIDER_NOT_FOUND', 'Provider not found');
      throw new AppError(409, 'PROVIDER_ALREADY_VERIFIED', 'This provider is already verified');
    }
    res.json(toProviderDto(rows[0]));
  }),
);

adminProvidersRouter.post(
  '/:providerId/reject',
  asyncHandler(async (req, res) => {
    const id = Uuid.parse(req.params.providerId);
    const { reason } = RejectBody.parse(req.body);
    const { rows } = await query<ProviderRow>(
      `UPDATE providers SET verified_status = 'rejected', verified_at = NULL, reviewed_by = $2, rejection_reason = $3
        WHERE id = $1 RETURNING *`,
      [id, req.user!.id, reason],
    );
    if (!rows[0]) throw new AppError(404, 'PROVIDER_NOT_FOUND', 'Provider not found');
    res.json(toProviderDto(rows[0]));
  }),
);