/**
 * Background job (every CHAIN_SYNC_INTERVAL_SECONDS) that finishes chain writes which didn't complete instantly:
 *   chain_pending -> polls GET /status/:queue_id and fills in solana_tx once it lands
 *   not_recorded  -> service was unreachable; re-sends the SAME stored record (so the hash is identical)
 * Covers consent grants, revokes, access logs and uploaded documents.
 */
import { config } from '../config';
import { query } from '../db/yugabyte';
import { isMongoConfigured, timelineEntries } from '../db/mongo';
import { anchorAccessLog, anchorConsent, anchorDocument, anchorRevoke, getQueueStatus, isChainConfigured, probeChainService, type ChainResult } from './solana';
import { getFile } from './storage';

interface PendingRow {
  id: string;
  status: string;
  queue_id: string | null;
  record: unknown;
}

async function resolve(row: PendingRow, resend: (record: never) => Promise<ChainResult>): Promise<ChainResult | null> {
  if (row.status === 'chain_pending' && row.queue_id) {
    const s = await getQueueStatus(row.queue_id);
    if (s?.solanaTx) return { status: 'confirmed', solanaTx: s.solanaTx, queueId: row.queue_id, hash: null };
    return null; // still pending, check again next cycle
  }
  if (row.status === 'not_recorded' && row.record) {
    const r = await resend(row.record as never);
    return r.status === 'not_recorded' ? null : r;
  }
  return null;
}

export async function syncChainWrites() {
  if (!isChainConfigured()) return;

  const grants = await query<PendingRow>(
    `SELECT id, chain_status AS status, chain_queue_id AS queue_id, chain_record AS record
       FROM consent_grants WHERE chain_status <> 'confirmed' ORDER BY granted_at LIMIT 50`,
  );
  for (const row of grants.rows) {
    const r = await resolve(row, anchorConsent);
    if (r) {
      await query(
        `UPDATE consent_grants SET solana_tx = $2, chain_status = $3, chain_queue_id = $4,
                consent_hash = COALESCE($5, consent_hash) WHERE id = $1`,
        [row.id, r.solanaTx, r.status, r.queueId, r.hash],
      );
    }
  }

  const revokes = await query<PendingRow>(
    `SELECT id, revoke_chain_status AS status, revoke_chain_queue_id AS queue_id, revoke_record AS record
       FROM consent_grants WHERE revoke_chain_status IN ('chain_pending', 'not_recorded') ORDER BY revoked_at LIMIT 50`,
  );
  for (const row of revokes.rows) {
    const r = await resolve(row, anchorRevoke);
    if (r) {
      await query(
        `UPDATE consent_grants SET revoke_solana_tx = $2, revoke_chain_status = $3, revoke_chain_queue_id = $4,
                revoke_hash = COALESCE($5, revoke_hash) WHERE id = $1`,
        [row.id, r.solanaTx, r.status, r.queueId, r.hash],
      );
    }
  }

  const logs = await query<PendingRow>(
    `SELECT id, chain_status AS status, chain_queue_id AS queue_id, chain_record AS record
       FROM access_logs WHERE chain_status IN ('chain_pending', 'not_recorded')
        AND viewed_at < now() - interval '30 seconds'   -- give the inline write a moment to land first
      ORDER BY viewed_at LIMIT 50`,
  );
  for (const row of logs.rows) {
    const r = await resolve(row, anchorAccessLog);
    if (r) {
      await query(
        `UPDATE access_logs SET solana_tx = $2, chain_status = $3, chain_queue_id = $4,
                entry_hash = COALESCE($5, entry_hash) WHERE id = $1`,
        [row.id, r.solanaTx, r.status, r.queueId, r.hash],
      );
    }
  }

  // Documents (MongoDB). Re-reads the stored file for not_recorded ones, so the hash is the same bytes.
  if (isMongoConfigured()) {
    try {
      const col = await timelineEntries();
      const docs = await col.find({ chain_status: { $ne: 'confirmed' } }).sort({ created_at: 1 }).limit(20).toArray();
      for (const d of docs) {
        let r: ChainResult | null = null;
        if (d.chain_status === 'chain_pending' && d.chain_queue_id) {
          const s = await getQueueStatus(d.chain_queue_id);
          if (s?.solanaTx) r = { status: 'confirmed', solanaTx: s.solanaTx, queueId: d.chain_queue_id, hash: null };
        } else if (d.chain_status === 'not_recorded') {
          const file = await getFile(d.file_ref).catch(() => null);
          if (file) {
            const a = await anchorDocument(d._id.toHexString(), file);
            if (a.status !== 'not_recorded') r = a;
          }
        }
        if (r) {
          await col.updateOne(
            { _id: d._id },
            { $set: { solana_tx: r.solanaTx, chain_status: r.status, chain_queue_id: r.queueId, updated_at: new Date() } },
          );
        }
      }
    } catch (err) {
      console.error('chain sync (documents) error:', (err as Error).message);
    }
  }
}

/** Started from main.ts (not app.ts, so tests don't run it). */
export function startChainSync() {
  if (!isChainConfigured()) {
    console.warn('⛓️  SOLANA_SERVICE_URL not set: consent hashes will be stored as not_recorded and sent once it is configured.');
    return;
  }
  // Say clearly at startup which URL is used and whether it answers.
  console.log(`⛓️  Solana service: ${config.SOLANA_SERVICE_URL}`);
  void probeChainService().then((p) =>
    p.status === 'reachable'
      ? console.log('⛓️  Solana service reachable ✅')
      : console.warn(`⛓️  Solana service ${p.status} ❌ ${p.detail ?? ''}`),
  );

  let running = false;
  const run = async () => {
    if (running) return; // never overlap two runs
    running = true;
    try {
      await syncChainWrites();
    } catch (err) {
      console.error('chain sync error:', (err as Error).message);
    } finally {
      running = false;
    }
  };
  setTimeout(run, 5000).unref(); // first pass shortly after startup: sends anything stored while the service was missing
  setInterval(run, config.CHAIN_SYNC_INTERVAL_SECONDS * 1000).unref();
}
