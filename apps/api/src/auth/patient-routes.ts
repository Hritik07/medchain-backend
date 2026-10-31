/**
 * Patient auth via OTP (mounted at /api/v1/auth/patient). Patients never use passwords.
 *   POST /register         {identifier, name, mobile} -> OTP to that mobile
 *   POST /register/verify  {otpId, code}              -> creates the patient, returns JWT
 *   POST /login            {identifier}               -> OTP to the patient's registered mobile
 *   POST /login/verify     {otpId, code}              -> JWT
 * The raw identifier is hashed immediately and never stored, logged or echoed back.
 */
import { Router } from 'express';
import { z } from 'zod';
import { query } from '../db/yugabyte';
import { AppError } from '../middleware/errors';
import { asyncHandler } from '../middleware/asyncHandler';
import { rateLimit } from '../middleware/rateLimit';
import { createOtp, normalizeMobile, verifyOtp } from '../otp/service';
import { hashIdentifier } from './identifier';
import { signToken } from './jwt';

export const patientAuthRouter = Router();

// Per-IP limit on top of the per-mobile OTP limits inside createOtp().
patientAuthRouter.use(rateLimit({ name: 'patient-auth', windowMs: 10 * 60_000, max: 30 }));

const RegisterBody = z.object({
  identifier: z.string().min(1),
  name: z.string().trim().min(2).max(100),
  mobile: z.string().min(10),
});
const LoginBody = z.object({ identifier: z.string().min(1) });
const VerifyBody = z.object({ otpId: z.string().min(1), code: z.string().regex(/^\d{6}$/, 'OTP must be 6 digits') });

function patientSession(id: string, name: string | null) {
  const user = { id, role: 'patient' as const, providerId: null };
  return { token: signToken(user), user: { ...user, name } };
}

patientAuthRouter.post(
  '/register',
  asyncHandler(async (req, res) => {
    const body = RegisterBody.parse(req.body);
    const hashedIdentifier = hashIdentifier(body.identifier);
    const mobile = normalizeMobile(body.mobile);

    const existing = await query('SELECT 1 FROM users WHERE hashed_identifier = $1', [hashedIdentifier]);
    if (existing.rowCount) {
      throw new AppError(409, 'PATIENT_ALREADY_REGISTERED', 'This ID is already registered. Please log in instead');
    }
    // Pending registration details ride along with the OTP; the user row is created only after verification.
    const otp = await createOtp({ purpose: 'patient_register', mobile, context: { hashedIdentifier, name: body.name } });
    res.status(201).json(otp);
  }),
);

patientAuthRouter.post(
  '/register/verify',
  asyncHandler(async (req, res) => {
    const { otpId, code } = VerifyBody.parse(req.body);
    const otp = await verifyOtp({ otpId, code, purpose: 'patient_register' });
    const { hashedIdentifier, name } = otp.context as { hashedIdentifier: string; name: string };

    const { rows } = await query<{ id: string; name: string }>(
      `INSERT INTO users (role, name, hashed_identifier, mobile)
       VALUES ('patient', $1, $2, $3)
       ON CONFLICT (hashed_identifier) DO NOTHING
       RETURNING id, name`,
      [name, hashedIdentifier, otp.mobile],
    );
    if (!rows[0]) throw new AppError(409, 'PATIENT_ALREADY_REGISTERED', 'This ID is already registered. Please log in instead');
    res.status(201).json(patientSession(rows[0].id, rows[0].name));
  }),
);

patientAuthRouter.post(
  '/login',
  asyncHandler(async (req, res) => {
    const { identifier } = LoginBody.parse(req.body);
    const { rows } = await query<{ id: string; mobile: string | null }>(
      "SELECT id, mobile FROM users WHERE hashed_identifier = $1 AND role = 'patient'",
      [hashIdentifier(identifier)],
    );
    const patient = rows[0];
    if (!patient) throw new AppError(404, 'PATIENT_NOT_REGISTERED', 'No patient found for this ID. Please register first');
    if (!patient.mobile) throw new AppError(409, 'NO_MOBILE_ON_FILE', 'No mobile number on file for this patient');

    const otp = await createOtp({ purpose: 'patient_login', mobile: patient.mobile, userId: patient.id });
    res.json(otp);
  }),
);

patientAuthRouter.post(
  '/login/verify',
  asyncHandler(async (req, res) => {
    const { otpId, code } = VerifyBody.parse(req.body);
    const otp = await verifyOtp({ otpId, code, purpose: 'patient_login' });
    const { rows } = await query<{ id: string; name: string | null }>('SELECT id, name FROM users WHERE id = $1', [otp.user_id]);
    if (!rows[0]) throw new AppError(404, 'PATIENT_NOT_REGISTERED', 'Patient account no longer exists');
    res.json(patientSession(rows[0].id, rows[0].name));
  }),
);
