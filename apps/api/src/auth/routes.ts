/**
 * Auth endpoints (mounted at /api/v1/auth):
 *   POST /login  - email + password for doctor/pharmacy/diagnostic/admin -> JWT
 *   GET  /me     - who am I (any logged-in role)
 * Patient login uses OTP to their mobile and is added in Step 4.
 * Dev-only: GET /role-test/:role to try the role guard quickly.
 */
import crypto from 'node:crypto';
import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { isDev } from '../config';
import { ROLES, type Role } from '../config/constants';
import { query } from '../db/yugabyte';
import { AppError } from '../middleware/errors';
import { asyncHandler } from '../middleware/asyncHandler';
import { rateLimit } from '../middleware/rateLimit';
import { signToken } from './jwt';
import { requireAuth, requireRole } from './middleware';

export const authRouter = Router();

const LoginBody = z.object({
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(1),
});

// Hash of a random string, compared against when the email doesn't exist,
// so "unknown email" and "wrong password" take the same time (prevents email enumeration).
const DUMMY_HASH = bcrypt.hashSync(crypto.randomBytes(16).toString('hex'), 10);

interface UserRow {
  id: string;
  role: Role;
  name: string | null;
  password_hash: string | null;
  provider_id: string | null;
  verified_status: string | null;
}

authRouter.post(
  '/login',
  rateLimit({ name: 'staff-login', windowMs: 10 * 60_000, max: 10 }), // slows down password guessing
  asyncHandler(async (req, res) => {
    const { email, password } = LoginBody.parse(req.body);

    const { rows } = await query<UserRow>(
      `SELECT u.id, u.role, u.name, u.password_hash, u.provider_id, p.verified_status
         FROM users u LEFT JOIN providers p ON p.id = u.provider_id
        WHERE u.email = $1`,
      [email],
    );
    const user = rows[0];
    const ok = await bcrypt.compare(password, user?.password_hash ?? DUMMY_HASH);
    if (!user || !user.password_hash || !ok) {
      throw new AppError(401, 'INVALID_CREDENTIALS', 'Email or password is incorrect');
    }

    // Staff of a provider that the admin hasn't verified yet can't log in (Step 9).
    if (user.provider_id && user.verified_status !== 'verified') {
      throw new AppError(403, 'PROVIDER_NOT_VERIFIED', 'Your organisation is awaiting admin verification');
    }

    const authUser = { id: user.id, role: user.role, providerId: user.provider_id };
    res.json({ token: signToken(authUser), user: { ...authUser, name: user.name } });
  }),
);

authRouter.get(
  '/me',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { rows } = await query<{ id: string; role: Role; name: string | null; provider_id: string | null }>(
      'SELECT id, role, name, provider_id FROM users WHERE id = $1',
      [req.user!.id],
    );
    if (!rows[0]) throw new AppError(401, 'USER_NOT_FOUND', 'Account no longer exists');
    const u = rows[0];
    // Deliberately no hashed_identifier, mobile or password_hash in the response.
    res.json({ id: u.id, role: u.role, name: u.name, providerId: u.provider_id });
  }),
);

// Dev-only helper to check the role guard: GET /api/v1/auth/role-test/doctor
if (isDev) {
  for (const role of ROLES) {
    authRouter.get(`/role-test/${role}`, requireAuth, requireRole(role), (req, res) => {
      res.json({ ok: true, message: `You have role "${role}"`, user: req.user });
    });
  }
}
