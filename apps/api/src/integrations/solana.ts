/**
 * Client for Member 3's Solana service (see their chain record contract). Only hashes ever reach the chain.
 * Every anchor call NEVER throws: if the service is down or slow, it returns status 'not_recorded'
 * and the chain-sync job retries later, so a chain problem never blocks a doctor or patient.
 */
import { config } from '../config';

export type ChainStatus = 'confirmed' | 'chain_pending' | 'not_recorded';

export interface ChainResult {
  status: ChainStatus;
  solanaTx: string | null;
  queueId: string | null;
  hash: string | null;
}

// Exact bodies from the contract. IDs: [A-Za-z0-9_-]{1,64}. Timestamps: toChainTimestamp().
export interface ConsentRecord {
  consent_grant_id: string;
  patient_id_token: string;
  accessor_id: string;
  granted_at: string;
  expires_at: string;
}
export interface AccessLogRecord {
  log_id: string;
  doctor_id: string; // the accessor (doctor, pharmacy or lab user id)
  patient_id_token: string;
  document_id: string;
  accessed_at: string;
  action: string;
}
export interface RevokeRecord {
  consent_grant_id: string;
  patient_id_token: string;
  accessor_id: string;
  revoked_at: string;
}

/** Contract format: ISO-8601 UTC, whole seconds, e.g. 2026-10-31T10:00:00Z (no milliseconds). */
export function toChainTimestamp(d: Date): string {
  return d.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** Current time rounded down to the second, so the DB value and the hashed string always match. */
export function nowToSecond(): Date {
  return new Date(Math.floor(Date.now() / 1000) * 1000);
}

export function isChainConfigured(): boolean {
  return Boolean(config.SOLANA_SERVICE_URL);
}

async function call<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
  if (!config.SOLANA_SERVICE_URL) throw new Error('SOLANA_SERVICE_URL is not set');
  const url = config.SOLANA_SERVICE_URL.trim().replace(/\/+$/, '') + path;
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': config.SOLANA_SERVICE_API_KEY ?? '',
        'ngrok-skip-browser-warning': 'true', // free ngrok tunnels otherwise return an HTML warning page
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(config.SOLANA_TIMEOUT_MS),
    });
  } catch (err) {
    // Node's fetch hides the real reason in err.cause (DNS failure, refused, TLS, timeout...)
    const cause = (err as { cause?: { code?: string; message?: string } }).cause;
    const reason = (err as Error).name === 'TimeoutError' ? `timed out after ${config.SOLANA_TIMEOUT_MS}ms` : cause?.code ?? cause?.message ?? (err as Error).message;
    throw new Error(`cannot reach ${url} (${reason})`);
  }
  if (!res.ok) {
    const text = (await res.text().catch(() => '')).slice(0, 200);
    throw new Error(`${method} ${url} -> HTTP ${res.status} ${text}`);
  }
  const text = await res.text();
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`${method} ${url} returned non-JSON (is the URL right? starts with: ${text.slice(0, 80)})`);
  }
}

/**
 * Used by /health. Calls GET /status/<probe> and reads the outcome:
 *   network error -> unreachable | 401/403 -> unauthorized (wrong SOLANA_SERVICE_API_KEY) | any other reply -> reachable
 */
export async function probeChainService(): Promise<{ status: 'not_configured' | 'reachable' | 'unauthorized' | 'unreachable'; detail?: string }> {
  if (!config.SOLANA_SERVICE_URL) return { status: 'not_configured' };
  try {
    await call('GET', '/status/healthcheck-probe');
    return { status: 'reachable' };
  } catch (err) {
    const msg = (err as Error).message;
    if (/HTTP 40[13]/.test(msg)) return { status: 'unauthorized', detail: msg };
    if (/HTTP \d{3}/.test(msg)) return { status: 'reachable', detail: 'service answered (probe id unknown is fine)' };
    return { status: 'unreachable', detail: msg };
  }
}

interface RawAnchorResponse {
  status?: string;
  solana_tx?: string | null;
  queue_id?: string | null;
  hash?: string | null;
}

function normalize(r: RawAnchorResponse): ChainResult {
  const solanaTx = r.solana_tx ?? null;
  const queueId = r.queue_id ?? null;
  const status: ChainStatus = solanaTx ? 'confirmed' : queueId || r.status === 'chain_pending' ? 'chain_pending' : 'not_recorded';
  return { status, solanaTx, queueId, hash: r.hash ?? null };
}

async function anchor(path: string, body: unknown): Promise<ChainResult> {
  try {
    return normalize(await call<RawAnchorResponse>('POST', path, body));
  } catch (err) {
    console.warn(`⛓️  chain write ${path} not recorded (will retry):`, (err as Error).message);
    return { status: 'not_recorded', solanaTx: null, queueId: null, hash: null };
  }
}

// JSONB in Postgres doesn't keep key order, so always rebuild records in the contract's field order
// before sending. Values (incl. timestamp strings) are untouched, so the hash stays identical.
function orderedConsent(r: ConsentRecord): ConsentRecord {
  return {
    consent_grant_id: r.consent_grant_id,
    patient_id_token: r.patient_id_token,
    accessor_id: r.accessor_id,
    granted_at: r.granted_at,
    expires_at: r.expires_at,
  };
}
function orderedRevoke(r: RevokeRecord): RevokeRecord {
  return {
    consent_grant_id: r.consent_grant_id,
    patient_id_token: r.patient_id_token,
    accessor_id: r.accessor_id,
    revoked_at: r.revoked_at,
  };
}

function orderedAccessLog(r: AccessLogRecord): AccessLogRecord {
  return {
    log_id: r.log_id,
    doctor_id: r.doctor_id,
    patient_id_token: r.patient_id_token,
    document_id: r.document_id,
    accessed_at: r.accessed_at,
    action: r.action,
  };
}

export const anchorAccessLog = (record: AccessLogRecord) => anchor('/access-log', orderedAccessLog(record));
export const anchorConsent = (record: ConsentRecord) => anchor('/consent', orderedConsent(record));
export const anchorRevoke = (record: RevokeRecord) => anchor('/revoke', orderedRevoke(record));

/** POST /document {document_id, file_base64}. document_id = timeline entry id (24-char hex, fits the ID rule). */
export const anchorDocument = (documentId: string, file: Buffer) =>
  anchor('/document', { document_id: documentId, file_base64: file.toString('base64') });

/** POST /verify {file_base64, solana_tx}: re-hashes the file on Member 3's side and compares with the chain. */
export async function verifyDocumentOnChain(file: Buffer, solanaTx: string) {
  try {
    return await call<{ status: 'verified' | 'mismatch' | 'not-found'; timestamp?: string; [k: string]: unknown }>(
      'POST',
      '/verify',
      { file_base64: file.toString('base64'), solana_tx: solanaTx },
    );
  } catch (err) {
    return { status: 'unavailable' as const, error: (err as Error).message };
  }
}

/** Poll a queued write. Returns null on any error (we'll just try again next cycle). */
export async function getQueueStatus(queueId: string): Promise<{ status: string; solanaTx: string | null } | null> {
  try {
    const r = await call<{ status: string; solana_tx: string | null }>('GET', `/status/${encodeURIComponent(queueId)}`);
    return { status: r.status, solanaTx: r.solana_tx ?? null };
  } catch (err) {
    console.warn('⛓️  status check failed:', (err as Error).message);
    return null;
  }
}

/** Badge source. Contract badge rule: "verified" -> Verified, "mismatch" -> Tampered, anything else -> Not recorded / Pending. */
export async function verifyConsentOnChain(record: ConsentRecord, solanaTx: string) {
  try {
    return await call<{ status: 'verified' | 'mismatch' | 'not-found'; timestamp?: string; [k: string]: unknown }>(
      'POST',
      '/verify-consent',
      { consent: orderedConsent(record), solana_tx: solanaTx },
    );
  } catch (err) {
    return { status: 'unavailable' as const, error: (err as Error).message };
  }
}
