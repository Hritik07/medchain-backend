/**
 * "Who viewed my records" (mounted at /api/v1/access-log).
 *   GET /?limit=50&before=<ISO time>&includeSelf=false
 *     patient -> their own log (their own views hidden unless includeSelf=true)
 *     admin   -> any patient's log via ?patientId=<uuid> (audit)
 * Paginate by passing the returned nextBefore as ?before=.
 */
import { Router } from 'express';
import { z } from 'zod';
import { query } from '../db/yugabyte';
import { asyncHandler } from '../middleware/asyncHandler';
import { requireAuth, requireRole } from '../auth/middleware';

export const accessLogRouter = Router();
accessLogRouter.use(requireAuth, requireRole('patient', 'admin'));

const Query = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  before: z.coerce.date().optional(),
  includeSelf: z.enum(['true', 'false']).default('false'),
  patientId: z.string().uuid().optional(),
});

interface LogRow {
  id: string;
  accessor_id: string;
  accessor_name: string | null;
  accessor_role: string;
  provider_name: string | null;
  grant_id: string | null;
  purpose: string | null;
  action: string;
  record_ids: string[];
  viewed_at: Date;
  chain_status: string | null;
  solana_tx: string | null;
}

accessLogRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const q = Query.parse(req.query);
    const patientId = req.user!.role === 'admin' ? q.patientId : req.user!.id;
    if (!patientId) {
      return res.status(400).json({ error: { code: 'PATIENT_ID_REQUIRED', message: 'Admins must pass ?patientId=' } });
    }

    const { rows } = await query<LogRow>(
      `SELECT l.id, l.accessor_id, a.name AS accessor_name, a.role AS accessor_role, p.name AS provider_name,
              l.grant_id, g.purpose, l.action, l.record_ids, l.viewed_at, l.chain_status, l.solana_tx
         FROM access_logs l
         JOIN users a ON a.id = l.accessor_id
         LEFT JOIN providers p ON p.id = a.provider_id
         LEFT JOIN consent_grants g ON g.id = l.grant_id
        WHERE l.patient_id = $1
          AND ($2::boolean OR l.accessor_id <> l.patient_id)
          AND ($3::timestamptz IS NULL OR l.viewed_at < $3)
        ORDER BY l.viewed_at DESC
        LIMIT $4`,
      [patientId, q.includeSelf === 'true', q.before ?? null, q.limit],
    );

    res.json({
      patientId,
      entries: rows.map((r) => ({
        id: r.id,
        viewedAt: new Date(r.viewed_at).toISOString(),
        action: r.action,
        recordIds: r.record_ids,
        accessor: {
          id: r.accessor_id,
          name: r.accessor_id === patientId ? 'You' : r.accessor_name,
          role: r.accessor_role,
          providerName: r.provider_name,
        },
        consent: r.grant_id ? { grantId: r.grant_id, purpose: r.purpose } : null,
        chain: { status: r.chain_status, solanaTx: r.solana_tx },
      })),
      nextBefore: rows.length === q.limit ? new Date(rows[rows.length - 1].viewed_at).toISOString() : null,
    });
  }),
);
