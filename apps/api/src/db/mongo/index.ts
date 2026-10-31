/**
 * MongoDB Atlas connection + typed collection helpers for the patient timeline.
 *   timeline_entries: one document per uploaded record (prescription, bill, lab report...)
 *   lab_results:      parsed lab values for a lab_report entry (written via n8n -> /internal callback)
 * Connects lazily on first use and creates indexes once. Only file METADATA lives here; files go to storage.
 */
import { MongoClient, type Collection, type Db, type ObjectId } from 'mongodb';
import { config } from '../../config';
import type { RecordSource, RecordType, Role } from '../../config/constants';
import type { ChainStatus } from '../../integrations/solana';
import { AppError } from '../../middleware/errors';

export type LabStatus = 'high' | 'low' | 'normal' | 'unknown';
export type ProcessingStatus = 'pending' | 'processed' | 'failed' | 'skipped';

export interface TimelineEntryDoc {
  _id: ObjectId;
  patient_id: string;                 // users.id (UUID) from YugabyteDB
  type: RecordType;
  title: string | null;
  date: Date;                         // date of the visit / bill / report (not the upload time)
  source: RecordSource;               // provider | patient_uploaded
  verified: boolean;                  // false for patient_uploaded ("Patient-uploaded, unverified")
  uploaded_by: { user_id: string; role: Role; provider_id: string | null; provider_name: string | null };
  file_ref: {
    storage: 'local' | 's3';
    key: string;
    mime: string;
    size: number;                     // stored (compressed) size
    original_name: string;
    original_size: number;
  };
  doc_hash: string;                   // SHA-256 (hex) of the STORED file bytes; this is what gets anchored
  solana_tx: string | null;
  chain_status: ChainStatus;
  chain_queue_id: string | null;
  processing_status: ProcessingStatus; // AI pipeline (n8n + Gemini) progress
  processing_error?: string | null;
  extracted?: Record<string, unknown> | null; // optional structured data from the AI pipeline
  created_at: Date;
  updated_at: Date;
}

export interface LabTest {
  name: string;
  value: number | string;
  unit: string | null;
  range_low: number | null;           // reference range PRINTED ON THE REPORT
  range_high: number | null;
  status: LabStatus;                  // computed by plain code (records/lab.ts), never by AI
  confidence: number | null;
}

export interface LabResultDoc {
  entry_id: string;                   // timeline_entries._id as hex string
  patient_id: string;
  tests: LabTest[];
  created_at: Date;
  updated_at: Date;
}

let client: MongoClient | null = null;
let dbPromise: Promise<Db> | null = null;

export function isMongoConfigured(): boolean {
  return Boolean(config.MONGO_URI);
}

export async function getDb(): Promise<Db> {
  if (!config.MONGO_URI) {
    throw new AppError(503, 'MONGO_NOT_CONFIGURED', 'Records database is not configured (set MONGO_URI)');
  }
  if (!dbPromise) {
    client = new MongoClient(config.MONGO_URI, { serverSelectionTimeoutMS: 8000, appName: 'medchain-api' });
    dbPromise = client
      .connect()
      .then(async (c) => {
        const db = c.db(config.MONGO_DB_NAME);
        await ensureIndexes(db);
        console.log(`🍃 Connected to MongoDB (db: ${config.MONGO_DB_NAME})`);
        return db;
      })
      .catch((err) => {
        dbPromise = null; // allow a retry on the next request
        client = null;
        throw err;
      });
  }
  return dbPromise;
}

async function ensureIndexes(db: Db) {
  await db.collection('timeline_entries').createIndexes([
    { key: { patient_id: 1, date: -1 }, name: 'patient_timeline' },
    { key: { chain_status: 1 }, name: 'chain_status' },
  ]);
  await db.collection('lab_results').createIndex({ entry_id: 1 }, { unique: true, name: 'entry_unique' });
}

export async function timelineEntries(): Promise<Collection<TimelineEntryDoc>> {
  return (await getDb()).collection<TimelineEntryDoc>('timeline_entries');
}

export async function labResults(): Promise<Collection<LabResultDoc>> {
  return (await getDb()).collection<LabResultDoc>('lab_results');
}

export async function pingMongo(): Promise<'up' | 'down' | 'not_configured'> {
  if (!isMongoConfigured()) return 'not_configured';
  try {
    await (await getDb()).command({ ping: 1 });
    return 'up';
  } catch (err) {
    console.error('MongoDB ping failed:', (err as Error).message);
    return 'down';
  }
}

export async function closeMongo() {
  await client?.close().catch(() => undefined);
}
