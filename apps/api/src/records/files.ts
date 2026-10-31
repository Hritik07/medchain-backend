/**
 * File checks and compression for uploads.
 *   detectFileType()     -> trusts the file's real bytes ("magic numbers"), not its name or the browser's claim
 *   prepareForStorage()  -> images become WebP at quality 90 (visually lossless), auto-rotated, metadata (GPS etc.) stripped;
 *                           PDFs are stored unchanged
 *   sha256Hex()          -> hash of the STORED bytes; this is the doc_hash anchored on Solana
 */
import crypto from 'node:crypto';
import sharp from 'sharp';
import { AppError } from '../middleware/errors';

export type DetectedType = 'image/jpeg' | 'image/png' | 'image/webp' | 'application/pdf';

export function detectFileType(buf: Buffer): DetectedType | null {
  if (buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  if (buf.toString('ascii', 0, 5) === '%PDF-') return 'application/pdf';
  return null;
}

export async function prepareForStorage(buf: Buffer, type: DetectedType): Promise<{ body: Buffer; mime: string; ext: string }> {
  if (type === 'application/pdf') return { body: buf, mime: type, ext: 'pdf' };
  try {
    const body = await sharp(buf, { limitInputPixels: 60_000_000 })
      .rotate() // apply phone camera orientation, then drop EXIF
      .resize({ width: 3000, height: 3000, fit: 'inside', withoutEnlargement: true }) // keeps small print readable
      .webp({ quality: 90 })
      .toBuffer();
    return { body, mime: 'image/webp', ext: 'webp' };
  } catch {
    throw new AppError(400, 'INVALID_IMAGE', 'The image could not be read. Please upload a clear JPG, PNG or WebP photo');
  }
}

export function sha256Hex(buf: Buffer): string {
  return crypto.createHash('sha256').update(buf).digest('hex');
}
