/**
 * Writes one access_logs row per record read/upload. Called by the records routes BEFORE data is returned:
 * if the log can't be written, the read fails ("fail closed"), so no view ever goes unrecorded.
 * Views by staff are then hashed to Solana in the background (never delays the response).
 */
import crypto from 'node:crypto';
import { config } from '../config';
import { query } from '../db/yugabyte';
import { anchorAccessLog, nowToSecond, toChainTimestamp, type AccessLogRecord } from '../integrations/solana';
import type { AuthUser } from '../auth/types';

export type AccessAction = 'view_timeline' | 'view_record' | 'view_file' | 'verify_record' | 'upload';

export async function logAccess(input: {
  patientId: string;
  accessor: AuthUser;
  grantId: string | null;
  action: AccessAction;
  recordIds: string[];
}): Promise<string> {
  const id = crypto.randomUUID();
  const at = nowToSecond();
  const isSelf = input.accessor.id === input.patientId;
  const toChain = !isSelf && config.ACCESS_LOG_TO_CHAIN;
  const documentId = input.action === 'view_timeline' ? 'timeline' : input.recordIds[0] ?? 'none';

  const record: AccessLogRecord | null = toChain
    ? {
        log_id: id,
        doctor_id: input.accessor.id,
        patient_id_token: input.patientId,
        document_id: documentId,
        accessed_at: toChainTimestamp(at),
        action: input.action,
      }
    : null;

  await query(
    `INSERT INTO access_logs (id, patient_id, accessor_id, grant_id, action, record_ids, viewed_at, document_id, chain_status, chain_record)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [id, input.patientId, input.accessor.id, input.grantId, input.action, input.recordIds, at, documentId,
     record ? 'not_recorded' : null, record ? JSON.stringify(record) : null],
  );

  if (record) {
    // Fire-and-forget: the chain-sync job retries anything that doesn't land here.
    void anchorAccessLog(record)
      .then((r) =>
        query('UPDATE access_logs SET entry_hash = $2, solana_tx = $3, chain_status = $4, chain_queue_id = $5 WHERE id = $1', [
          id, r.hash, r.solanaTx, r.status, r.queueId,
        ]),
      )
      .catch((err) => console.warn('access log chain update failed:', (err as Error).message));
  }
  return id;
}
