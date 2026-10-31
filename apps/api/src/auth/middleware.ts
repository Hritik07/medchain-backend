/**
 * Route guards.
 *   requireAuth            -> needs a valid "Authorization: Bearer <jwt>" header, sets req.user
 *   requireRole('doctor')  -> needs requireAuth first, then checks the role (accepts several roles)
 * Usage: router.get('/x', requireAuth, requireRole('doctor', 'admin'), handler)
 */
import type { NextFunction, Request, Response } from 'express';
import type { Role } from '../config/constants';
import { AppError } from '../middleware/errors';
import { query } from '../db/yugabyte';
import { verifyToken } from './jwt';
import './types';

export function requireAuth(req: Request, _res: Response, next: NextFunction) {
  const header = req.headers.authorization ?? '';
  const [scheme, token] = header.split(' ');
  if (scheme !== 'Bearer' || !token) {
    return next(new AppError(401, 'AUTH_REQUIRED', 'Missing "Authorization: Bearer <token>" header'));
  }
  try {
    req.user = verifyToken(token);
    next();
  } catch (err) {
    next(err);
  }
}

/**
 * For doctor/pharmacy/diagnostic users: their organisation must be verified RIGHT NOW.
 * Checked on every request (not just at login), so rejecting/suspending a provider takes effect
 * immediately even for staff still holding an 8-hour token. Other roles pass straight through.
 */
export async function requireVerifiedProvider(req: Request, _res: Response, next: NextFunction) {
  const u = req.user;
  if (!u || (u.role !== 'doctor' && u.role !== 'pharmacy' && u.role !== 'diagnostic')) return next();
  try {
    const { rows } = await query<{ verified_status: string }>('SELECT verified_status FROM providers WHERE id = $1', [u.providerId]);
    if (rows[0]?.verified_status !== 'verified') {
      return next(new AppError(403, 'PROVIDER_NOT_VERIFIED', 'Your organisation is not verified (pending review or suspended)'));
    }
    next();
  } catch (err) {
    next(err);
  }
}

export function requireRole(...allowed: Role[]) {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.user) {
      return next(new AppError(401, 'AUTH_REQUIRED', 'Not authenticated'));
    }
    if (!allowed.includes(req.user.role)) {
      return next(
        new AppError(403, 'FORBIDDEN_ROLE', `This action requires role: ${allowed.join(' or ')}`, {
          yourRole: req.user.role,
        }),
      );
    }
    next();
  };
}
