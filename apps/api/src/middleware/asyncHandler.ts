/**
 * Express 4 doesn't catch errors thrown inside async route handlers.
 * Wrap handlers with asyncHandler(...) so thrown AppErrors reach the JSON error handler instead of crashing.
 */
import type { NextFunction, Request, RequestHandler, Response } from 'express';

export const asyncHandler =
  (fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>): RequestHandler =>
  (req, res, next) => {
    fn(req, res, next).catch(next);
  };
