/**
 * Patient self-service (mounted at /api/v1/patients, patient token required).
 *   POST   /me/whatsapp/link     {mobile}        -> OTP to that number (proves the patient owns it)
 *   POST   /me/whatsapp/verify   {otpId, code}   -> links it; the WhatsApp bot can now recognise them
 *   GET    /me/whatsapp                          -> linked? (masked number)
 *   DELETE /me/whatsapp                          -> unlink
 *   DELETE /me/chat-history                      -> erase fallback chatbot history (right to erasure)
 * Aadhaar is never involved here: the bot identifies patients ONLY by this verified number.
 */
import { Router } from 'express';
import { z } from 'zod';
import { query } from '../db/yugabyte';
import { AppError } from '../middleware/errors';
import { asyncHandler } from '../middleware/asyncHandler';
import { rateLimit } from '../middleware/rateLimit';
import { requireAuth, requireRole } from '../auth/middleware';
import { createOtp, maskMobile, normalizeMobile, verifyOtp } from '../otp/service';

export const patientsRouter = Router();
patientsRouter.use(requireAuth, requireRole('patient'), rateLimit({ name: 'patients', windowMs: 10 * 60_000, max: 60 }));

const LinkBody = z.object({ mobile: z.string().min(10) });
const VerifyBody = z.object({ otpId: z.string().min(1), code: z.string().regex(/^\d{6}$/, 'OTP must be 6 digits') });

/** Throws if this number is already the verified WhatsApp of a DIFFERENT patient. */
async function assertPhoneFree(phone: string, patientId: string) {
  const { rows } = await query<{ patient_id: string }>('SELECT patient_id FROM whatsapp_links WHERE phone_e164 = $1', [phone]);
  if (rows[0] && rows[0].patient_id !== patientId) {
    throw new AppError(409, 'PHONE_LINKED_TO_ANOTHER_PATIENT', 'This number is already linked to another MedChain account');
  }
}

patientsRouter.post(
  '/me/whatsapp/link',
  asyncHandler(async (req, res) => {
    const phone = normalizeMobile(LinkBody.parse(req.body).mobile);
    await assertPhoneFree(phone, req.user!.id);
    const otp = await createOtp({ purpose: 'phone_link', mobile: phone, userId: req.user!.id });
    res.status(201).json(otp);
  }),
);

patientsRouter.post(
  '/me/whatsapp/verify',
  asyncHandler(async (req, res) => {
    const { otpId, code } = VerifyBody.parse(req.body);

    // Ownership check BEFORE consuming the OTP.
    const owner = await query<{ user_id: string | null }>(
      "SELECT user_id FROM otp_requests WHERE id::text = $1 AND purpose = 'phone_link'",
      [otpId],
    );
    if (owner.rows[0] && owner.rows[0].user_id !== req.user!.id) {
      throw new AppError(403, 'OTP_NOT_YOURS', 'This OTP belongs to a different account');
    }

    const otp = await verifyOtp({ otpId, code, purpose: 'phone_link' });
    await assertPhoneFree(otp.mobile, req.user!.id); // re-check: someone may have linked it meanwhile

    try {
      // One number per patient: linking a new one replaces the old one.
      const { rows } = await query<{ phone_e164: string; verified_at: Date }>(
        `INSERT INTO whatsapp_links (patient_id, phone_e164, verified_at)
         VALUES ($1, $2, now())
         ON CONFLICT (patient_id) DO UPDATE SET phone_e164 = EXCLUDED.phone_e164, verified_at = now()
         RETURNING phone_e164, verified_at`,
        [req.user!.id, otp.mobile],
      );
      res.json({ linked: true, phone: maskMobile(rows[0].phone_e164), verifiedAt: new Date(rows[0].verified_at).toISOString() });
    } catch (err) {
      if ((err as { code?: string }).code === '23505') {
        throw new AppError(409, 'PHONE_LINKED_TO_ANOTHER_PATIENT', 'This number is already linked to another MedChain account');
      }
      throw err;
    }
  }),
);

patientsRouter.get(
  '/me/whatsapp',
  asyncHandler(async (req, res) => {
    const { rows } = await query<{ phone_e164: string; verified_at: Date }>(
      'SELECT phone_e164, verified_at FROM whatsapp_links WHERE patient_id = $1',
      [req.user!.id],
    );
    const link = rows[0];
    res.json(
      link
        ? { linked: true, phone: maskMobile(link.phone_e164), verifiedAt: new Date(link.verified_at).toISOString() }
        : { linked: false, phone: null, verifiedAt: null },
    );
  }),
);

patientsRouter.delete(
  '/me/whatsapp',
  asyncHandler(async (req, res) => {
    await query('DELETE FROM whatsapp_links WHERE patient_id = $1', [req.user!.id]);
    res.json({ linked: false });
  }),
);

patientsRouter.delete(
  '/me/chat-history',
  asyncHandler(async (req, res) => {
    const { rowCount } = await query('DELETE FROM chat_history_fallback WHERE patient_id = $1', [req.user!.id]);
    // Meko (primary chatbot memory) is erased by Member 2's service; this clears our fallback copy.
    res.json({ deleted: rowCount ?? 0 });
  }),
);
