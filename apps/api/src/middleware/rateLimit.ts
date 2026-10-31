/**
 * Small in-memory, per-IP rate limiter (fine for a single API instance at a hackathon).
 * rateLimit({ name: 'login', windowMs: 600_000, max: 10 }) -> 429 RATE_LIMITED once exceeded, with Retry-After.
 * If the API ever runs as several instances, swap this for a shared store (e.g. Redis).
 */
import type { NextFunction, Request, Response } from 'express';
import { AppError } from './errors';

interface Bucket {
  count: number;
  resetAt: number;
}
const buckets = new Map<string, Bucket>();

// Sweep expired buckets every minute so memory doesn't grow. unref() lets the process exit normally.
setInterval(() => {
  const now = Date.now();
  for (const [key, b] of buckets) if (b.resetAt <= now) buckets.delete(key);
}, 60_000).unref();

export function rateLimit(opts: { name: string; windowMs: number; max: number }) {
  return (req: Request, res: Response, next: NextFunction) => {
    const key = `${opts.name}:${req.ip}`;
    const now = Date.now();
    let bucket = buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      bucket = { count: 0, resetAt: now + opts.windowMs };
      buckets.set(key, bucket);
    }
    bucket.count++;
    if (bucket.count > opts.max) {
      const retryAfterSeconds = Math.ceil((bucket.resetAt - now) / 1000);
      res.setHeader('Retry-After', String(retryAfterSeconds));
      return next(new AppError(429, 'RATE_LIMITED', 'Too many requests, please try again later', { retryAfterSeconds }));
    }
    next();
  };
}

/** Used by tests (Step 11) to start each test with clean limits. */
export function resetRateLimits() {
  buckets.clear();
}
