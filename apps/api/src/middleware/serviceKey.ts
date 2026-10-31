/**
 * Guards machine-to-machine routes (n8n -> API) under /api/v1/internal.
 * The caller must send header `x-service-key: <SERVICE_API_KEY>`. Compared in constant time.
 * If SERVICE_API_KEY isn't set, these routes are disabled (503) rather than left open.
 */
import crypto from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { config } from '../config';
import { AppError } from './errors';

export function requireServiceKey(req: Request, _res: Response, next: NextFunction) {
  const expected = config.SERVICE_API_KEY;
  if (!expected) {
    return next(new AppError(503, 'SERVICE_KEY_NOT_CONFIGURED', 'SERVICE_API_KEY is not set on the API'));
  }
  const got = Buffer.from(req.header('x-service-key') ?? '');
  const want = Buffer.from(expected);
  if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) {
    return next(new AppError(401, 'INVALID_SERVICE_KEY', 'Missing or invalid x-service-key header'));
  }
  next();
}
