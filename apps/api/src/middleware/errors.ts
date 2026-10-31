/**
 * Consistent JSON errors. Every failure returns: { "error": { "code": "SOME_CODE", "message": "...", "details"?: ... } }
 * Throw `new AppError(status, code, message)` anywhere; the handler below formats it.
 * Unknown errors become 500 INTERNAL_ERROR and never leak stack traces in production.
 */
import type { NextFunction, Request, Response } from 'express';
import multer from 'multer';
import { ZodError } from 'zod';
import { config, isProd } from '../config';

export class AppError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

export function notFoundHandler(req: Request, _res: Response, next: NextFunction) {
  next(new AppError(404, 'NOT_FOUND', `Route ${req.method} ${req.path} not found`));
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction) {
  if (err instanceof AppError) {
    return res.status(err.status).json({ error: { code: err.code, message: err.message, details: err.details } });
  }
  if (err instanceof ZodError) {
    return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'Invalid request', details: err.flatten() } });
  }
  // Upload problems from multer (file too big, wrong field name, etc.)
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({ error: { code: 'FILE_TOO_LARGE', message: `File exceeds the ${config.MAX_UPLOAD_MB} MB limit` } });
    }
    return res.status(400).json({ error: { code: 'UPLOAD_ERROR', message: `${err.message} (send the file in a form field named "file")` } });
  }
  // Malformed JSON body from express.json()
  if (err instanceof SyntaxError && 'body' in (err as object)) {
    return res.status(400).json({ error: { code: 'INVALID_JSON', message: 'Request body is not valid JSON' } });
  }
  console.error('Unhandled error:', err);
  return res.status(500).json({
    error: { code: 'INTERNAL_ERROR', message: isProd ? 'Something went wrong' : String((err as Error)?.message ?? err) },
  });
}
