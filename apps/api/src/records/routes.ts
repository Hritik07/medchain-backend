/**
 * Patient record endpoints (mounted at /api/v1/records). EVERY route runs authorizePatient first:
 * the patient themself, or staff holding an active (unexpired, unrevoked) consent grant. No exceptions.
 * Every successful call also writes an access_logs row (Step 7) before any data is sent back.
 *   POST /:patientId/entries                    multipart: file + type (+ title, date) -> stores, hashes, triggers n8n
 *   GET  /:patientId/timeline?type=&limit=      timeline, newest first, lab values flagged
 *   GET  /:patientId/entries/:entryId           one entry
 *   GET  /:patientId/entries/:entryId/file      the stored file itself
 *   GET  /:patientId/entries/:entryId/verify    re-hash file -> compare with doc_hash and with Solana (badge)
 */
import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { RECORD_TYPES } from '../config/constants';
import { labResults } from '../db/mongo';
import { AppError } from '../middleware/errors';
import { asyncHandler } from '../middleware/asyncHandler';
import { rateLimit } from '../middleware/rateLimit';
import { requireAuth, requireRole, requireVerifiedProvider } from '../auth/middleware';
import { getFile } from '../integrations/storage';
import { verifyDocumentOnChain } from '../integrations/solana';
import { logAccess, type AccessAction } from '../access-log/service';
import { authorizePatientAccess, createEntry, getEntry, getTimeline, toEntryDto, type PatientAccess } from './service';
import { sha256Hex } from './files';
import { uploadSingleFile } from './upload';

export const recordsRouter = Router();
recordsRouter.use(requireAuth, requireRole('patient', 'doctor', 'pharmacy', 'diagnostic'), requireVerifiedProvider);

const Uuid = z.string().uuid('patientId must be a valid id');
const UploadFields = z.object({
  type: z.enum(RECORD_TYPES),
  title: z.string().trim().max(200).optional(),
  date: z.coerce
    .date()
    .refine((d) => d.getTime() <= Date.now() + 86_400_000, 'date cannot be in the future')
    .optional(),
});
const TimelineQuery = z.object({
  type: z.enum(RECORD_TYPES).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(200),
});

// Consent gate, runs BEFORE the upload is even read into memory.
const authorizePatient = asyncHandler(async (req, res, next) => {
  const patientId = Uuid.parse(req.params.patientId);
  res.locals.patientId = patientId;
  res.locals.access = await authorizePatientAccess(req.user!, patientId);
  next();
});

/** Writes the access_logs row. Awaited BEFORE responding: if logging fails, no data is returned. */
function log(req: Request, res: Response, action: AccessAction, recordIds: string[]) {
  const access = res.locals.access as PatientAccess;
  return logAccess({ patientId: res.locals.patientId, accessor: req.user!, grantId: access.grant?.id ?? null, action, recordIds });
}

recordsRouter.post(
  '/:patientId/entries',
  rateLimit({ name: 'upload', windowMs: 10 * 60_000, max: 30 }),
  authorizePatient,
  uploadSingleFile,
  asyncHandler(async (req, res) => {
    if (!req.file) throw new AppError(400, 'FILE_REQUIRED', 'Attach the document in a form field named "file"');
    const fields = UploadFields.parse(req.body);
    const entry = await createEntry({
      user: req.user!,
      patientId: res.locals.patientId,
      file: req.file,
      type: fields.type,
      title: fields.title ?? null,
      date: fields.date ?? new Date(),
    });
    await log(req, res, 'upload', [entry.id]);
    res.status(201).json(entry);
  }),
);

recordsRouter.get(
  '/:patientId/timeline',
  authorizePatient,
  asyncHandler(async (req, res) => {
    const q = TimelineQuery.parse(req.query);
    const timeline = await getTimeline(res.locals.patientId, q);
    await log(req, res, 'view_timeline', timeline.entries.map((e) => e.id));
    res.json(timeline);
  }),
);

recordsRouter.get(
  '/:patientId/entries/:entryId',
  authorizePatient,
  asyncHandler(async (req, res) => {
    const entry = await getEntry(res.locals.patientId, req.params.entryId);
    const lab = await (await labResults()).findOne({ entry_id: entry._id.toHexString() });
    await log(req, res, 'view_record', [entry._id.toHexString()]);
    res.json(toEntryDto(entry, lab));
  }),
);

recordsRouter.get(
  '/:patientId/entries/:entryId/file',
  authorizePatient,
  asyncHandler(async (req, res) => {
    const entry = await getEntry(res.locals.patientId, req.params.entryId);
    const file = await getFile(entry.file_ref);
    await log(req, res, 'view_file', [entry._id.toHexString()]);
    res.setHeader('Content-Type', entry.file_ref.mime);
    res.setHeader('Content-Disposition', `inline; filename="${entry._id.toHexString()}.${entry.file_ref.mime === 'application/pdf' ? 'pdf' : 'webp'}"`);
    res.setHeader('Cache-Control', 'private, no-store'); // medical files must not sit in shared caches
    res.send(file);
  }),
);

recordsRouter.get(
  '/:patientId/entries/:entryId/verify',
  authorizePatient,
  asyncHandler(async (req, res) => {
    const entry = await getEntry(res.locals.patientId, req.params.entryId);
    const file = await getFile(entry.file_ref);
    const storedFileIntact = sha256Hex(file) === entry.doc_hash;
    await log(req, res, 'verify_record', [entry._id.toHexString()]);
    if (!entry.solana_tx) {
      return res.json({ status: 'not-recorded', chainStatus: entry.chain_status, storedFileIntact });
    }
    const chain = await verifyDocumentOnChain(file, entry.solana_tx);
    res.json({ ...chain, storedFileIntact });
  }),
);
