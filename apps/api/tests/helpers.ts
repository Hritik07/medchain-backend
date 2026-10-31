/**
 * Test helpers: the app under test, plus quick ways to create fresh users with unique IDs/mobiles
 * (so tests never collide with each other or with per-mobile OTP limits).
 */
import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import request from 'supertest';
import { createApp } from '../src/app';
import { query } from '../src/db/yugabyte';
import { hashIdentifier } from '../src/auth/identifier';
import { signToken } from '../src/auth/jwt';
import { sentOtps } from './otp-capture';

export const app = createApp();
export const http = () => request(app);
export const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

/** 12 digits starting with 0 (real Aadhaar never starts with 0, so these are clearly fake). */
export function randomIdentifier(): string {
  return '0' + crypto.randomInt(10_000_000_000, 99_999_999_999).toString();
}

/** +91 99xxxxxxxx: a valid-looking Indian mobile in a demo range. */
export function randomMobile(): string {
  return '+9199' + crypto.randomInt(10_000_000, 99_999_999).toString();
}

export function lastOtp(mobile: string): string {
  const code = sentOtps.get(mobile);
  if (!code) throw new Error(`No OTP was sent to ${mobile}`);
  return code;
}

export interface TestPatient {
  id: string;
  identifier: string;
  mobile: string;
  token: string;
}

export async function createPatient(): Promise<TestPatient> {
  const identifier = randomIdentifier();
  const mobile = randomMobile();
  const { rows } = await query<{ id: string }>(
    `INSERT INTO users (role, name, hashed_identifier, mobile) VALUES ('patient', 'Test Patient', $1, $2) RETURNING id`,
    [hashIdentifier(identifier), mobile],
  );
  const id = rows[0].id;
  return { id, identifier, mobile, token: signToken({ id, role: 'patient', providerId: null }) };
}

export interface TestStaff {
  id: string;
  providerId: string;
  email: string;
  password: string;
  token: string;
}

export async function createStaff(
  role: 'doctor' | 'pharmacy' | 'diagnostic' = 'doctor',
  status: 'verified' | 'pending' | 'rejected' = 'verified',
): Promise<TestStaff> {
  const provider = await query<{ id: string }>(
    `INSERT INTO providers (type, name, registration_number, verified_status, verified_at)
     VALUES ($1, 'Test Provider', 'TEST-REG', $2, CASE WHEN $2 = 'verified' THEN now() END) RETURNING id`,
    [role, status],
  );
  const providerId = provider.rows[0].id;
  const email = `staff-${crypto.randomUUID()}@test.demo`;
  const password = 'Test1234';
  const user = await query<{ id: string }>(
    `INSERT INTO users (role, name, email, password_hash, provider_id) VALUES ($1, 'Test Staff', $2, $3, $4) RETURNING id`,
    [role, email, bcrypt.hashSync(password, 4), providerId],
  );
  const id = user.rows[0].id;
  return { id, providerId, email, password, token: signToken({ id, role, providerId }) };
}

export async function createAdmin(): Promise<{ id: string; token: string }> {
  const { rows } = await query<{ id: string }>(
    `INSERT INTO users (role, name, email) VALUES ('admin', 'Test Admin', $1) RETURNING id`,
    [`admin-${crypto.randomUUID()}@test.demo`],
  );
  return { id: rows[0].id, token: signToken({ id: rows[0].id, role: 'admin', providerId: null }) };
}

/** Full consent flow through the API (request -> captured OTP -> verify). Returns the grant JSON. */
export async function grantConsent(staff: TestStaff, patient: TestPatient, durationHours = 24) {
  const req = await http()
    .post('/api/v1/consent/request')
    .set(bearer(staff.token))
    .send({ identifier: patient.identifier, purpose: 'Test visit', durationHours });
  if (req.status !== 201) throw new Error(`consent request failed: ${req.status} ${JSON.stringify(req.body)}`);
  const ver = await http()
    .post('/api/v1/consent/verify')
    .set(bearer(staff.token))
    .send({ otpId: req.body.otpId, code: lastOtp(patient.mobile) });
  if (ver.status !== 201) throw new Error(`consent verify failed: ${ver.status} ${JSON.stringify(ver.body)}`);
  return ver.body as { id: string; state: string; patientId: string; expiresAt: string };
}
