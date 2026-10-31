/**
 * Provider onboarding (mounted at /api/v1/providers).
 *   POST /register  (public)  clinic / pharmacy / lab signs up with its first staff login -> status "pending"
 *   GET  /me        (staff)   my organisation and its verification status
 * Staff of a pending or rejected provider can't log in or touch patient data until an admin verifies it.
 */
import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { query, withTransaction } from '../db/yugabyte';
import { AppError } from '../middleware/errors';
import { asyncHandler } from '../middleware/asyncHandler';
import { rateLimit } from '../middleware/rateLimit';
import { requireAuth, requireRole } from '../auth/middleware';
import { normalizeMobile } from '../otp/service';
import { toProviderDto, type ProviderRow } from './service';

export const providersRouter = Router();

const RegisterBody = z.object({
  type: z.enum(['doctor', 'pharmacy', 'diagnostic']),
  organisationName: z.string().trim().min(3).max(150),
  registrationNumber: z.string().trim().min(3).max(60), // medical council / drug licence / NABL no. (fake in demo)
  staff: z.object({
    name: z.string().trim().min(2).max(100),
    email: z.string().trim().toLowerCase().email(),
    password: z
      .string()
      .min(8, 'Password must be at least 8 characters')
      .max(72) // bcrypt only uses the first 72 bytes
      .regex(/[A-Za-z]/, 'Password needs a letter')
      .regex(/\d/, 'Password needs a number'),
    mobile: z.string().optional(),
  }),
});

providersRouter.post(
  '/register',
  rateLimit({ name: 'provider-register', windowMs: 60 * 60_000, max: 5 }),
  asyncHandler(async (req, res) => {
    const body = RegisterBody.parse(req.body);
    const mobile = body.staff.mobile ? normalizeMobile(body.staff.mobile) : null;
    const passwordHash = await bcrypt.hash(body.staff.password, 10);

    try {
      const provider = await withTransaction(async (client) => {
        const p = await client.query<ProviderRow>(
          `INSERT INTO providers (type, name, registration_number) VALUES ($1, $2, $3) RETURNING *`,
          [body.type, body.organisationName, body.registrationNumber],
        );
        // Staff role matches the provider type: doctor -> doctor, pharmacy -> pharmacy, diagnostic -> diagnostic.
        await client.query(
          `INSERT INTO users (role, name, email, password_hash, mobile, provider_id) VALUES ($1, $2, $3, $4, $5, $6)`,
          [body.type, body.staff.name, body.staff.email, passwordHash, mobile, p.rows[0].id],
        );
        return p.rows[0];
      });
      res.status(201).json({
        provider: toProviderDto(provider),
        message: 'Registration received. You can log in once a MedChain admin verifies your organisation.',
      });
    } catch (err) {
      if ((err as { code?: string }).code === '23505') {
        throw new AppError(409, 'EMAIL_ALREADY_REGISTERED', 'An account with this email already exists');
      }
      throw err;
    }
  }),
);

providersRouter.get(
  '/me',
  requireAuth,
  requireRole('doctor', 'pharmacy', 'diagnostic'),
  asyncHandler(async (req, res) => {
    const { rows } = await query<ProviderRow>('SELECT * FROM providers WHERE id = $1', [req.user!.providerId]);
    if (!rows[0]) throw new AppError(404, 'PROVIDER_NOT_FOUND', 'Organisation not found');
    res.json(toProviderDto(rows[0]));
  }),
);
