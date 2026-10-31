/**
 * Signs and verifies JWTs (HS256, secret from JWT_SECRET, lifetime from JWT_EXPIRES_IN).
 * Token payload is minimal: sub (user id), role, providerId. No names, mobile numbers or medical data.
 */
import jwt from 'jsonwebtoken';
import { config } from '../config';
import { ROLES, type Role } from '../config/constants';
import { AppError } from '../middleware/errors';
import type { AuthUser } from './types';

interface TokenPayload {
  sub: string;
  role: Role;
  providerId: string | null;
}

export function signToken(user: AuthUser): string {
  const payload: TokenPayload = { sub: user.id, role: user.role, providerId: user.providerId };
  return jwt.sign(payload, config.JWT_SECRET, {
    algorithm: 'HS256',
    expiresIn: config.JWT_EXPIRES_IN as jwt.SignOptions['expiresIn'],
    issuer: 'medchain-api',
  });
}

export function verifyToken(token: string): AuthUser {
  try {
    const decoded = jwt.verify(token, config.JWT_SECRET, {
      algorithms: ['HS256'],
      issuer: 'medchain-api',
    }) as jwt.JwtPayload & Partial<TokenPayload>;

    if (!decoded.sub || !decoded.role || !ROLES.includes(decoded.role)) {
      throw new AppError(401, 'INVALID_TOKEN', 'Token payload is invalid');
    }
    return { id: decoded.sub, role: decoded.role, providerId: decoded.providerId ?? null };
  } catch (err) {
    if (err instanceof AppError) throw err;
    if (err instanceof jwt.TokenExpiredError) {
      throw new AppError(401, 'TOKEN_EXPIRED', 'Session expired, please log in again');
    }
    throw new AppError(401, 'INVALID_TOKEN', 'Invalid authentication token');
  }
}
