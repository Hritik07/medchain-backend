/**
 * Consent endpoints (mounted at /api/v1/consent):
 *   POST /request                (doctor/pharmacy/diagnostic) {identifier, purpose?, durationHours?} -> OTP to patient
 *   POST /verify                 (same roles) {otpId, code} -> creates the grant + Solana hash
 *   GET  /                       (patient: grants on me | staff: grants I hold)
 *   GET  /check/:patientId       (staff) do I currently have access? -> 200 or 403 CONSENT_*
 *   POST /:grantId/revoke        (the patient, the accessor, or admin)
 *   GET  /:grantId/chain-verify  re-checks the consent hash on Solana for the "Verified" badge
 */
import { Router } from 'express';
import { z } from 'zod';
import { query } from '../db/yugabyte';
import { AppError } from '../middleware/errors';
import { asyncHandler } from '../middleware/asyncHandler';
import { rateLimit } from '../middleware/rateLimit';
import { requireAuth, requireRole, requireVerifiedProvider } from '../auth/middleware';
import { hashIdentifier } from '../auth/identifier';
import { createOtp, verifyOtp } from '../otp/service';
import { verifyConsentOnChain } from '../integrations/solana';
import {
  assertActiveGrant,
  clampDuration,
  createGrant,
  getGrant,
  revokeGrant,
  toGrantDto,
  type GrantJoin,
  type GrantRow,
} from './service';
import type { AuthUser } from '../auth/types';

export const consentRouter = Router();
consentRouter.use(requireAuth, requireVerifiedProvider, rateLimit({ name: 'consent', windowMs: 10 * 60_000, max: 60 }));

const STAFF = ['doctor', 'pharmacy', 'diagnostic'] as const;

const RequestBody = z.object({
  identifier: z.string().min(1),
  purpose: z.string().trim().min(3).max(100).default('treatment'),
  durationHours: z.coerce.number().int().optional(),
});
const VerifyBody = z.object({ otpId: z.string().min(1), code: z.string().regex(/^\d{6}$/, 'OTP must be 6 digits') });
const Uuid = z.string().uuid('Must be a valid id');

/** Only the patient, the accessor on the grant, or an admin may touch a grant. */
function assertParty(g: GrantRow, user: AuthUser) {
  if (user.role === 'admin' || g.patient_id === user.id || g.accessor_id === user.id) return;
  throw new AppError(404, 'CONSENT_NOT_FOUND', 'Consent grant not found'); // 404, not 403: don't reveal it exists
}

consentRouter.post(
  '/request',
  requireRole(...STAFF),
  asyncHandler(async (req, res) => {
    const body = RequestBody.parse(req.body);
    const durationHours = clampDuration(body.durationHours);

    const { rows } = await query<{ id: string; mobile: string | null }>(
      "SELECT id, mobile FROM users WHERE hashed_identifier = $1 AND role = 'patient'",
      [hashIdentifier(body.identifier)],
    );
    const patient = rows[0];
    if (!patient) throw new AppError(404, 'PATIENT_NOT_REGISTERED', 'No MedChain patient found for this ID');
    if (!patient.mobile) throw new AppError(409, 'NO_MOBILE_ON_FILE', 'Patient has no mobile number on file');

    const otp = await createOtp({
      purpose: 'consent',
      mobile: patient.mobile,
      userId: patient.id,
      requestedBy: req.user!.id,
      context: { purpose: body.purpose, durationHours },
    });
    res.status(201).json({ ...otp, durationHours, purpose: body.purpose });
  }),
);

consentRouter.post(
  '/verify',
  requireRole(...STAFF),
  asyncHandler(async (req, res) => {
    const { otpId, code } = VerifyBody.parse(req.body);

    // Check ownership BEFORE consuming, so another doctor can't burn this OTP.
    const owner = await query<{ requested_by: string | null }>(
      "SELECT requested_by FROM otp_requests WHERE id::text = $1 AND purpose = 'consent'",
      [otpId],
    );
    if (owner.rows[0] && owner.rows[0].requested_by !== req.user!.id) {
      throw new AppError(403, 'OTP_NOT_YOURS', 'This consent OTP was requested by a different user');
    }

    const otp = await verifyOtp({ otpId, code, purpose: 'consent' });
    const ctx = otp.context as { purpose: string; durationHours: number };
    const grant = await createGrant({
      patientId: otp.user_id!,
      accessorId: req.user!.id,
      purpose: ctx.purpose,
      durationHours: ctx.durationHours,
    });
    const patient = await query<{ name: string | null }>('SELECT name FROM users WHERE id = $1', [grant.patient_id]);
    res.status(201).json(toGrantDto({ ...grant, patient_name: patient.rows[0]?.name ?? null }));
  }),
);

consentRouter.get(
  '/',
  requireRole('patient', ...STAFF),
  asyncHandler(async (req, res) => {
    const me = req.user!;
    const sql =
      me.role === 'patient'
        ? `SELECT g.*, a.name AS accessor_name, a.role AS accessor_role, p.name AS provider_name
             FROM consent_grants g
             JOIN users a ON a.id = g.accessor_id
             LEFT JOIN providers p ON p.id = a.provider_id
            WHERE g.patient_id = $1 ORDER BY g.granted_at DESC LIMIT 100`
        : `SELECT g.*, pt.name AS patient_name
             FROM consent_grants g JOIN users pt ON pt.id = g.patient_id
            WHERE g.accessor_id = $1 ORDER BY g.granted_at DESC LIMIT 100`;
    const { rows } = await query<GrantRow & GrantJoin>(sql, [me.id]);
    res.json({ grants: rows.map(toGrantDto) });
  }),
);

consentRouter.get(
  '/check/:patientId',
  requireRole(...STAFF),
  asyncHandler(async (req, res) => {
    const patientId = Uuid.parse(req.params.patientId);
    const grant = await assertActiveGrant(patientId, req.user!.id);
    res.json({ active: true, grant: toGrantDto(grant) });
  }),
);

consentRouter.post(
  '/:grantId/revoke',
  asyncHandler(async (req, res) => {
    const grantId = Uuid.parse(req.params.grantId);
    assertParty(await getGrant(grantId), req.user!);
    res.json(toGrantDto(await revokeGrant(grantId)));
  }),
);

consentRouter.get(
  '/:grantId/chain-verify',
  asyncHandler(async (req, res) => {
    const grant = await getGrant(Uuid.parse(req.params.grantId));
    assertParty(grant, req.user!);
    if (!grant.solana_tx || !grant.chain_record) {
      return res.json({ status: 'not-recorded', chainStatus: grant.chain_status });
    }
    res.json(await verifyConsentOnChain(grant.chain_record, grant.solana_tx));
  }),
);