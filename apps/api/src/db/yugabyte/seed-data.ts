/**
 * FAKE demo data: 3 verified providers, 1 admin, 3 staff users, 2 patients.
 * Fixed UUIDs so the whole team (frontend, n8n, Solana) can reference the same demo accounts.
 * Safe to re-run (ON CONFLICT DO NOTHING). Refuses in production unless DEMO_MODE=true.
 * Used by `npm run seed` (seed.ts) and by startup when SEED_DEMO_DATA=true (main.ts).
 */
import bcrypt from 'bcryptjs';
import { config, isProd } from '../../config';
import { hashIdentifier } from '../../auth/identifier';
import { pool } from './index';

export const DEMO_PASSWORD = 'Demo@1234';

const PROVIDERS = [
  { id: '11111111-1111-4111-8111-000000000001', type: 'doctor', name: 'Sharma Family Clinic (DEMO)', reg: 'DMC-DEMO-0001' },
  { id: '11111111-1111-4111-8111-000000000002', type: 'pharmacy', name: 'Jan Aushadhi Demo Pharmacy', reg: 'DL-DEMO-0002' },
  { id: '11111111-1111-4111-8111-000000000003', type: 'diagnostic', name: 'City Diagnostics (DEMO)', reg: 'NABL-DEMO-0003' },
];

const STAFF = [
  { id: '22222222-2222-4222-8222-000000000001', role: 'admin', name: 'MedChain Admin', email: 'admin@medchain.demo', provider: null },
  { id: '22222222-2222-4222-8222-000000000002', role: 'doctor', name: 'Dr. Anita Sharma', email: 'doctor@medchain.demo', provider: PROVIDERS[0].id },
  { id: '22222222-2222-4222-8222-000000000003', role: 'pharmacy', name: 'Jan Aushadhi Counter', email: 'pharmacy@medchain.demo', provider: PROVIDERS[1].id },
  { id: '22222222-2222-4222-8222-000000000004', role: 'diagnostic', name: 'City Diagnostics Desk', email: 'lab@medchain.demo', provider: PROVIDERS[2].id },
];

// Obviously fake 12-digit IDs (real Aadhaar never starts with 0) and the reserved +91 99999 test range.
const PATIENTS = [
  { id: '33333333-3333-4333-8333-000000000001', name: 'Ramesh Kumar (DEMO, 72y)', idNumber: '000000000001', mobile: '+919999900001' },
  { id: '33333333-3333-4333-8333-000000000002', name: 'Sunita Devi (DEMO, 65y)', idNumber: '000000000002', mobile: '+919999900002' },
];

export async function seedDemoData(): Promise<void> {
  if (isProd && !config.DEMO_MODE) {
    throw new Error('Refusing to seed demo data in production (set DEMO_MODE=true for a hosted hackathon demo).');
  }
  const passwordHash = await bcrypt.hash(DEMO_PASSWORD, 10);

  for (const p of PROVIDERS) {
    await pool.query(
      `INSERT INTO providers (id, type, name, registration_number, verified_status, verified_at)
       VALUES ($1, $2, $3, $4, 'verified', now()) ON CONFLICT (id) DO NOTHING`,
      [p.id, p.type, p.name, p.reg],
    );
  }
  for (const s of STAFF) {
    await pool.query(
      `INSERT INTO users (id, role, name, email, password_hash, provider_id)
       VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (id) DO NOTHING`,
      [s.id, s.role, s.name, s.email, passwordHash, s.provider],
    );
  }
  for (const p of PATIENTS) {
    await pool.query(
      `INSERT INTO users (id, role, name, hashed_identifier, mobile)
       VALUES ($1, 'patient', $2, $3, $4) ON CONFLICT (id) DO NOTHING`,
      [p.id, p.name, hashIdentifier(p.idNumber), p.mobile],
    );
  }

  console.log('✅ Demo data seeded. Staff logins (password for all: ' + DEMO_PASSWORD + '):');
  for (const s of STAFF) console.log(`   ${s.role.padEnd(10)} ${s.email}`);
  console.log('   Patients (fake IDs, log in by OTP):');
  for (const p of PATIENTS) console.log(`   ${p.name}: ID ${p.idNumber}, mobile ${p.mobile}`);
}

