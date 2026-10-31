/**
 * WhatsApp bot routes for Member 2's n8n (mounted at /api/v1/internal, x-service-key required).
 *   POST /whatsapp/resolve                  {phone}  -> {patientId, name}  (only VERIFIED links resolve)
 *   GET  /patients/:patientId/timeline              -> patient's own records, for answering their questions
 *   POST /patients/:patientId/entries               multipart upload from a WhatsApp photo/PDF ("Patient-uploaded, unverified")
 *   GET  /patients/:patientId/chat-history?limit=   fallback chat memory when Meko is down
 *   POST /patients/:patientId/chat-history  {role, message}
 * Phone numbers travel in the POST body, never in the URL (keeps them out of server/proxy logs).
 * Bot reads/uploads are logged in the access log as the patient acting on their own records.
 */
import { Router } from 'express';
import { z } from 'zod';
import { query } from '../db/yugabyte';
import { AppError } from '../middleware/errors';
import { asyncHandler } from '../middleware/asyncHandler';
import { requireServiceKey } from '../middleware/serviceKey';
import { RECORD_TYPES } from '../config/constants';
import { normalizeMobile } from '../otp/service';
import { logAccess } from '../access-log/service';
import { createEntry, getTimeline } from '../records/service';
import { uploadSingleFile } from '../records/upload';
import type { AuthUser } from '../auth/types';

export const internalPatientsRouter = Router();
internalPatientsRouter.use(requireServiceKey);

const Uuid = z.string().uuid('patientId must be a valid id');
const ResolveBody = z.object({ phone: z.string().min(8) });
const ChatBody = z.object({ role: z.enum(['user', 'assistant', 'system']), message: z.string().min(1).max(4000) });
const ChatQuery = z.object({ limit: z.coerce.number().int().min(1).max(100).default(20) });
const UploadFields = z.object({
  type: z.enum(RECORD_TYPES).default('other'),
  title: z.string().trim().max(200).optional(),
});

/** Twilio sends "whatsapp:+919999900001", Meta sends "919999900001": both become "+919999900001". */
function normalizeWhatsApp(raw: string): string {
  return normalizeMobile(raw.replace(/^whatsapp:/i, '').trim());
}

/** The bot acts AS the patient, so it gets exactly the patient's own access (nothing more). */
async function patientActor(patientIdRaw: string): Promise<AuthUser> {
  const patientId = Uuid.parse(patientIdRaw);
  const { rows } = await query("SELECT 1 FROM users WHERE id = $1 AND role = 'patient'", [patientId]);
  if (!rows[0]) throw new AppError(404, 'PATIENT_NOT_FOUND', 'Patient not found');
  return { id: patientId, role: 'patient', providerId: null };
}

internalPatientsRouter.post(
  '/whatsapp/resolve',
  asyncHandler(async (req, res) => {
    let phone: string;
    try {
      phone = normalizeWhatsApp(ResolveBody.parse(req.body).phone);
    } catch {
      throw new AppError(404, 'PHONE_NOT_LINKED', 'This number is not linked to a MedChain patient');
    }
    const { rows } = await query<{ patient_id: string; name: string | null }>(
      `SELECT w.patient_id, u.name FROM whatsapp_links w JOIN users u ON u.id = w.patient_id
        WHERE w.phone_e164 = $1 AND w.verified_at IS NOT NULL`,
      [phone],
    );
    if (!rows[0]) {
      // Bot should reply: "This number isn't linked. Link it in the MedChain app first."
      throw new AppError(404, 'PHONE_NOT_LINKED', 'This number is not linked to a MedChain patient');
    }
    res.json({ patientId: rows[0].patient_id, name: rows[0].name });
  }),
);

internalPatientsRouter.get(
  '/patients/:patientId/timeline',
  asyncHandler(async (req, res) => {
    const actor = await patientActor(req.params.patientId);
    const timeline = await getTimeline(actor.id, { limit: 200 });
    await logAccess({ patientId: actor.id, accessor: actor, grantId: null, action: 'view_timeline', recordIds: timeline.entries.map((e) => e.id) });
    res.json(timeline);
  }),
);

internalPatientsRouter.post(
  '/patients/:patientId/entries',
  asyncHandler(async (req, res, next) => {
    res.locals.actor = await patientActor(req.params.patientId);
    next();
  }),
  uploadSingleFile,
  asyncHandler(async (req, res) => {
    if (!req.file) throw new AppError(400, 'FILE_REQUIRED', 'Attach the document in a form field named "file"');
    const actor = res.locals.actor as AuthUser;
    const fields = UploadFields.parse(req.body);
    const entry = await createEntry({
      user: actor, // => source "patient_uploaded", verified false
      patientId: actor.id,
      file: req.file,
      type: fields.type,
      title: fields.title ?? 'Sent via WhatsApp',
      date: new Date(),
    });
    await logAccess({ patientId: actor.id, accessor: actor, grantId: null, action: 'upload', recordIds: [entry.id] });
    res.status(201).json(entry);
  }),
);

internalPatientsRouter.get(
  '/patients/:patientId/chat-history',
  asyncHandler(async (req, res) => {
    const actor = await patientActor(req.params.patientId);
    const { limit } = ChatQuery.parse(req.query);
    const { rows } = await query<{ role: string; message: string; created_at: Date }>(
      `SELECT role, message, created_at FROM chat_history_fallback
        WHERE patient_id = $1 ORDER BY created_at DESC LIMIT $2`,
      [actor.id, limit],
    );
    // Oldest first, ready to feed to the model as conversation history.
    res.json({ messages: rows.reverse().map((r) => ({ role: r.role, message: r.message, createdAt: new Date(r.created_at).toISOString() })) });
  }),
);

internalPatientsRouter.post(
  '/patients/:patientId/chat-history',
  asyncHandler(async (req, res) => {
    const actor = await patientActor(req.params.patientId);
    const body = ChatBody.parse(req.body);
    await query('INSERT INTO chat_history_fallback (patient_id, role, message) VALUES ($1, $2, $3)', [actor.id, body.role, body.message]);
    // Keep only the latest 200 messages per patient (it's a fallback, not an archive).
    await query(
      `DELETE FROM chat_history_fallback WHERE patient_id = $1 AND id NOT IN (
         SELECT id FROM chat_history_fallback WHERE patient_id = $1 ORDER BY created_at DESC LIMIT 200)`,
      [actor.id],
    );
    res.status(201).json({ ok: true });
  }),
);
