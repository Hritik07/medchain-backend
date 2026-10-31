/**
 * Records logic.
 *   authorizePatientAccess() -> the gate in front of EVERY record read/upload:
 *        patient -> only their own records; doctor/pharmacy/diagnostic -> only with an active consent grant
 *   createEntry()            -> validate + compress + store file, save metadata in Mongo, hash to Solana, trigger n8n
 *   getTimeline()/getEntry() -> reads, with lab results merged in and abnormal values counted
 */
import { ObjectId } from 'mongodb';
import { PATIENT_UPLOAD_LABEL, type RecordType } from '../config/constants';
import { labResults, timelineEntries, type LabResultDoc, type TimelineEntryDoc } from '../db/mongo';
import { query } from '../db/yugabyte';
import { AppError } from '../middleware/errors';
import { assertActiveGrant, type GrantRow } from '../consent/service';
import { anchorDocument } from '../integrations/solana';
import { triggerUploadPipeline } from '../integrations/n8n';
import { putFile } from '../integrations/storage';
import type { AuthUser } from '../auth/types';
import { detectFileType, prepareForStorage, sha256Hex } from './files';

export interface PatientAccess {
  grant: GrantRow | null; // null when the patient is reading their own records
}

export async function authorizePatientAccess(user: AuthUser, patientId: string): Promise<PatientAccess> {
  if (user.role === 'patient') {
    if (user.id !== patientId) throw new AppError(403, 'NOT_YOUR_RECORDS', 'Patients can only access their own records');
    return { grant: null };
  }
  if (user.role === 'doctor' || user.role === 'pharmacy' || user.role === 'diagnostic') {
    return { grant: await assertActiveGrant(patientId, user.id) }; // throws CONSENT_REQUIRED / _EXPIRED / _REVOKED
  }
  throw new AppError(403, 'FORBIDDEN_ROLE', 'This role cannot access patient records');
}

export function parseEntryId(id: string): ObjectId {
  if (!/^[0-9a-f]{24}$/i.test(id)) throw new AppError(404, 'RECORD_NOT_FOUND', 'Record not found');
  return new ObjectId(id);
}

export async function createEntry(input: {
  user: AuthUser;
  patientId: string;
  file: { buffer: Buffer; originalname: string; size: number };
  type: RecordType;
  title: string | null;
  date: Date;
}) {
  const detected = detectFileType(input.file.buffer);
  if (!detected) {
    throw new AppError(415, 'UNSUPPORTED_FILE_TYPE', 'Only JPG, PNG, WebP images and PDF files are accepted');
  }
  const { body, mime, ext } = await prepareForStorage(input.file.buffer, detected);

  const isPatient = input.user.role === 'patient';
  let providerName: string | null = null;
  if (input.user.providerId) {
    const p = await query<{ name: string }>('SELECT name FROM providers WHERE id = $1', [input.user.providerId]);
    providerName = p.rows[0]?.name ?? null;
  }

  const _id = new ObjectId();
  const entryId = _id.toHexString();
  const fileRef = await putFile(`${input.patientId}/${entryId}.${ext}`, body, mime);
  const now = new Date();

  const doc: TimelineEntryDoc = {
    _id,
    patient_id: input.patientId,
    type: input.type,
    title: input.title,
    date: input.date,
    source: isPatient ? 'patient_uploaded' : 'provider',
    verified: !isPatient,
    uploaded_by: { user_id: input.user.id, role: input.user.role, provider_id: input.user.providerId, provider_name: providerName },
    file_ref: { ...fileRef, mime, size: body.length, original_name: input.file.originalname.slice(0, 200), original_size: input.file.size },
    doc_hash: sha256Hex(body),
    solana_tx: null,
    chain_status: 'not_recorded',
    chain_queue_id: null,
    processing_status: 'pending',
    processing_error: null,
    extracted: null,
    created_at: now,
    updated_at: now,
  };
  const col = await timelineEntries();
  await col.insertOne(doc);

  // Chain + n8n run after the record is safely saved; neither can fail the upload.
  const chain = await anchorDocument(entryId, body);
  const pipeline = await triggerUploadPipeline({
    entry_id: entryId,
    patient_id: input.patientId,
    type: input.type,
    source: doc.source,
    mime,
    doc_hash: doc.doc_hash,
  });
  const processing_status = pipeline === 'triggered' ? 'pending' : pipeline === 'not_configured' ? 'skipped' : 'failed';

  const updated = await col.findOneAndUpdate(
    { _id },
    {
      $set: {
        solana_tx: chain.solanaTx,
        chain_status: chain.status,
        chain_queue_id: chain.queueId,
        processing_status,
        updated_at: new Date(),
      },
    },
    { returnDocument: 'after' },
  );
  return toEntryDto(updated ?? doc, null);
}

export async function getEntry(patientId: string, entryId: string): Promise<TimelineEntryDoc> {
  const col = await timelineEntries();
  const doc = await col.findOne({ _id: parseEntryId(entryId), patient_id: patientId });
  if (!doc) throw new AppError(404, 'RECORD_NOT_FOUND', 'Record not found');
  return doc;
}

export async function getTimeline(patientId: string, opts: { type?: RecordType; limit: number }) {
  const col = await timelineEntries();
  const filter: Partial<Pick<TimelineEntryDoc, 'patient_id' | 'type'>> = { patient_id: patientId };
  if (opts.type) filter.type = opts.type;
  const entries = await col.find(filter).sort({ date: -1, created_at: -1 }).limit(opts.limit).toArray();

  const ids = entries.map((e) => e._id.toHexString());
  const labs = ids.length ? await (await labResults()).find({ entry_id: { $in: ids } }).toArray() : [];
  const labByEntry = new Map(labs.map((l) => [l.entry_id, l]));

  const items = entries.map((e) => toEntryDto(e, labByEntry.get(e._id.toHexString()) ?? null));
  return {
    patientId,
    count: items.length,
    abnormalCount: items.reduce((n, i) => n + (i.labResults?.abnormalCount ?? 0), 0),
    entries: items,
  };
}

/** API shape for an entry. Never exposes storage keys. */
export function toEntryDto(e: TimelineEntryDoc, lab: LabResultDoc | null) {
  const tests = lab?.tests ?? [];
  const abnormal = tests.filter((t) => t.status === 'high' || t.status === 'low');
  return {
    id: e._id.toHexString(),
    patientId: e.patient_id,
    type: e.type,
    title: e.title,
    date: e.date.toISOString(),
    source: e.source,
    verified: e.verified,
    sourceLabel: e.source === 'patient_uploaded' ? PATIENT_UPLOAD_LABEL : `Uploaded by ${e.uploaded_by.provider_name ?? e.uploaded_by.role}`,
    uploadedBy: { role: e.uploaded_by.role, providerName: e.uploaded_by.provider_name },
    file: { mime: e.file_ref.mime, size: e.file_ref.size, originalName: e.file_ref.original_name },
    docHash: e.doc_hash,
    chain: { status: e.chain_status, solanaTx: e.solana_tx },
    processingStatus: e.processing_status,
    extracted: e.extracted ?? null,
    labResults: lab
      ? {
          tests: tests.map((t) => ({
            name: t.name,
            value: t.value,
            unit: t.unit,
            rangeLow: t.range_low,
            rangeHigh: t.range_high,
            status: t.status,
            abnormal: t.status === 'high' || t.status === 'low',
            confidence: t.confidence,
          })),
          abnormalCount: abnormal.length,
        }
      : null,
    createdAt: e.created_at.toISOString(),
  };
}
