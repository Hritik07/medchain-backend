/**
 * Consent rules in one place.
 *   createGrant()       -> stores a time-limited grant, then hashes it to Solana (never blocks on the chain)
 *   revokeGrant()       -> ends a grant early, then hashes the revoke event to Solana
 *   assertActiveGrant() -> THE check every record read must call: valid = not revoked AND now < expires_at
 */
import crypto from 'node:crypto';
import { config } from '../config';
import { query } from '../db/yugabyte';
import { AppError } from '../middleware/errors';
import {
  anchorConsent,
  anchorRevoke,
  nowToSecond,
  toChainTimestamp,
  type ChainStatus,
  type ConsentRecord,
  type RevokeRecord,
} from '../integrations/solana';

export interface GrantRow {
  id: string;
  patient_id: string;
  accessor_id: string;
  purpose: string;
  granted_at: Date;
  expires_at: Date;
  revoked_at: Date | null;
  consent_hash: string | null;
  solana_tx: string | null;
  chain_status: ChainStatus;
  chain_queue_id: string | null;
  chain_record: ConsentRecord | null;
  revoke_solana_tx: string | null;
  revoke_chain_status: ChainStatus | null;
}

export type GrantState = 'active' | 'expired' | 'revoked';

export function grantState(g: Pick<GrantRow, 'revoked_at' | 'expires_at'>): GrantState {
  if (g.revoked_at) return 'revoked';
  return new Date(g.expires_at).getTime() > Date.now() ? 'active' : 'expired';
}

/** Optional display columns some queries JOIN in (patient/accessor names). */
export interface GrantJoin {
  patient_name?: string | null;
  accessor_name?: string | null;
  accessor_role?: string | null;
  provider_name?: string | null;
}

/** API shape for a grant (camelCase, chain info grouped). */
export function toGrantDto(g: GrantRow & GrantJoin) {
  return {
    id: g.id,
    patientId: g.patient_id,
    accessorId: g.accessor_id,
    purpose: g.purpose,
    state: grantState(g),
    grantedAt: new Date(g.granted_at).toISOString(),
    expiresAt: new Date(g.expires_at).toISOString(),
    revokedAt: g.revoked_at ? new Date(g.revoked_at).toISOString() : null,
    chain: { status: g.chain_status, solanaTx: g.solana_tx },
    revokeChain: g.revoked_at ? { status: g.revoke_chain_status, solanaTx: g.revoke_solana_tx } : null,
    // Optional joined display fields (present depending on the query)
    ...(g.patient_name !== undefined ? { patientName: g.patient_name } : {}),
    ...(g.accessor_name !== undefined
      ? { accessorName: g.accessor_name, accessorRole: g.accessor_role, providerName: g.provider_name }
      : {}),
  };
}

export async function createGrant(input: { patientId: string; accessorId: string; purpose: string; durationHours: number }) {
  const id = crypto.randomUUID();
  const grantedAt = nowToSecond();
  const expiresAt = new Date(grantedAt.getTime() + input.durationHours * 3600_000);

  // Exactly what gets hashed. Kept in the row so it can be re-verified byte-for-byte later.
  const record: ConsentRecord = {
    consent_grant_id: id,
    patient_id_token: input.patientId, // random UUID, never derived from Aadhaar
    accessor_id: input.accessorId,
    granted_at: toChainTimestamp(grantedAt),
    expires_at: toChainTimestamp(expiresAt),
  };

  await query(
    `INSERT INTO consent_grants (id, patient_id, accessor_id, purpose, granted_at, expires_at, chain_record)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [id, input.patientId, input.accessorId, input.purpose, grantedAt, expiresAt, JSON.stringify(record)],
  );

  const chain = await anchorConsent(record);
  const { rows } = await query<GrantRow>(
    `UPDATE consent_grants SET consent_hash = $2, solana_tx = $3, chain_status = $4, chain_queue_id = $5
      WHERE id = $1 RETURNING *`,
    [id, chain.hash, chain.solanaTx, chain.status, chain.queueId],
  );
  return rows[0];
}

export async function getGrant(grantId: string): Promise<GrantRow> {
  const { rows } = await query<GrantRow>('SELECT * FROM consent_grants WHERE id = $1', [grantId]);
  if (!rows[0]) throw new AppError(404, 'CONSENT_NOT_FOUND', 'Consent grant not found');
  return rows[0];
}

export async function revokeGrant(grantId: string) {
  const grant = await getGrant(grantId);
  const state = grantState(grant);
  if (state === 'revoked') throw new AppError(409, 'CONSENT_ALREADY_REVOKED', 'This consent was already revoked');
  if (state === 'expired') throw new AppError(409, 'CONSENT_ALREADY_EXPIRED', 'This consent has already expired');

  const revokedAt = nowToSecond();
  const record: RevokeRecord = {
    consent_grant_id: grant.id,
    patient_id_token: grant.patient_id,
    accessor_id: grant.accessor_id,
    revoked_at: toChainTimestamp(revokedAt),
  };

  // WHERE revoked_at IS NULL: two simultaneous revokes can't both succeed.
  const upd = await query(
    `UPDATE consent_grants SET revoked_at = $2, revoke_record = $3, revoke_chain_status = 'not_recorded'
      WHERE id = $1 AND revoked_at IS NULL`,
    [grant.id, revokedAt, JSON.stringify(record)],
  );
  if (!upd.rowCount) throw new AppError(409, 'CONSENT_ALREADY_REVOKED', 'This consent was already revoked');

  const chain = await anchorRevoke(record);
  const { rows } = await query<GrantRow>(
    `UPDATE consent_grants SET revoke_hash = $2, revoke_solana_tx = $3, revoke_chain_status = $4, revoke_chain_queue_id = $5
      WHERE id = $1 RETURNING *`,
    [grant.id, chain.hash, chain.solanaTx, chain.status, chain.queueId],
  );
  return rows[0];
}

/**
 * Throws 403 unless `accessorId` holds an active grant for `patientId`. Returns that grant.
 * Error code tells the frontend why: CONSENT_REQUIRED (never granted), CONSENT_EXPIRED, CONSENT_REVOKED.
 */
export async function assertActiveGrant(patientId: string, accessorId: string): Promise<GrantRow> {
  const { rows } = await query<GrantRow>(
    `SELECT * FROM consent_grants
      WHERE patient_id = $1 AND accessor_id = $2
      ORDER BY (revoked_at IS NULL AND expires_at > now()) DESC, granted_at DESC
      LIMIT 1`,
    [patientId, accessorId],
  );
  const g = rows[0];
  if (!g) throw new AppError(403, 'CONSENT_REQUIRED', 'Patient consent is required (request an OTP from the patient)');
  const state = grantState(g);
  if (state === 'revoked') throw new AppError(403, 'CONSENT_REVOKED', 'The patient has revoked this consent');
  if (state === 'expired') throw new AppError(403, 'CONSENT_EXPIRED', 'Consent has expired, please request a new OTP');
  return g;
}

export function clampDuration(hours?: number): number {
  const h = hours ?? config.CONSENT_DEFAULT_HOURS;
  if (h < 1 || h > config.CONSENT_MAX_HOURS) {
    throw new AppError(400, 'INVALID_DURATION', `Consent duration must be between 1 and ${config.CONSENT_MAX_HOURS} hours`);
  }
  return h;
}