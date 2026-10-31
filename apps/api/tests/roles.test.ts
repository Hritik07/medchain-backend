/**
 * Authentication and role checks: missing/invalid/expired tokens, wrong roles,
 * patients limited to their own records, suspended providers blocked at once, service key on internal routes.
 */
import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import { describe, expect, it } from 'vitest';
import { config } from '../src/config';
import { bearer, createAdmin, createPatient, createStaff, http } from './helpers';

describe('authentication', () => {
  it('rejects requests without a token (AUTH_REQUIRED)', async () => {
    const res = await http().get('/api/v1/auth/me');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('AUTH_REQUIRED');
  });

  it('rejects a tampered token (INVALID_TOKEN)', async () => {
    const res = await http().get('/api/v1/auth/me').set(bearer('not.a.real.token'));
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('INVALID_TOKEN');
  });

  it('rejects a token signed with another secret (INVALID_TOKEN)', async () => {
    const forged = jwt.sign({ sub: crypto.randomUUID(), role: 'admin', providerId: null }, 'some-other-secret-123456', {
      algorithm: 'HS256',
      issuer: 'medchain-api',
    });
    const res = await http().get('/api/v1/auth/me').set(bearer(forged));
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('INVALID_TOKEN');
  });

  it('rejects an expired token (TOKEN_EXPIRED)', async () => {
    const patient = await createPatient();
    const expired = jwt.sign(
      { sub: patient.id, role: 'patient', providerId: null, exp: Math.floor(Date.now() / 1000) - 60 },
      config.JWT_SECRET,
      { algorithm: 'HS256', issuer: 'medchain-api' },
    );
    const res = await http().get('/api/v1/auth/me').set(bearer(expired));
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('TOKEN_EXPIRED');
  });

  it('staff login works and returns a token; wrong password is INVALID_CREDENTIALS', async () => {
    const doctor = await createStaff('doctor');
    const ok = await http().post('/api/v1/auth/login').send({ email: doctor.email, password: doctor.password });
    expect(ok.status).toBe(200);
    expect(ok.body.token).toBeTruthy();
    expect(ok.body.user.role).toBe('doctor');

    const bad = await http().post('/api/v1/auth/login').send({ email: doctor.email, password: 'wrong-pass1' });
    expect(bad.status).toBe(401);
    expect(bad.body.error.code).toBe('INVALID_CREDENTIALS');

    const unknown = await http().post('/api/v1/auth/login').send({ email: 'nobody@test.demo', password: 'whatever1' });
    expect(unknown.status).toBe(401);
    expect(unknown.body.error.code).toBe('INVALID_CREDENTIALS'); // same answer: no email enumeration
  });

  it('staff of an unverified provider cannot log in (PROVIDER_NOT_VERIFIED)', async () => {
    const pending = await createStaff('pharmacy', 'pending');
    const res = await http().post('/api/v1/auth/login').send({ email: pending.email, password: pending.password });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('PROVIDER_NOT_VERIFIED');
  });
});

describe('roles', () => {
  it('a patient cannot request consent (FORBIDDEN_ROLE)', async () => {
    const patient = await createPatient();
    const other = await createPatient();
    const res = await http()
      .post('/api/v1/consent/request')
      .set(bearer(patient.token))
      .send({ identifier: other.identifier });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN_ROLE');
  });

  it("a patient cannot read another patient's records (NOT_YOUR_RECORDS)", async () => {
    const patient = await createPatient();
    const other = await createPatient();
    const res = await http().get(`/api/v1/records/${other.id}/timeline`).set(bearer(patient.token));
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('NOT_YOUR_RECORDS');
  });

  it('a doctor cannot use admin endpoints (FORBIDDEN_ROLE)', async () => {
    const doctor = await createStaff('doctor');
    const res = await http().get('/api/v1/admin/providers').set(bearer(doctor.token));
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN_ROLE');
  });

  it("a doctor cannot read a patient's access log (FORBIDDEN_ROLE)", async () => {
    const doctor = await createStaff('doctor');
    const res = await http().get('/api/v1/access-log').set(bearer(doctor.token));
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN_ROLE');
  });

  it('an admin cannot read patient records directly (FORBIDDEN_ROLE)', async () => {
    const admin = await createAdmin();
    const patient = await createPatient();
    const res = await http().get(`/api/v1/records/${patient.id}/timeline`).set(bearer(admin.token));
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN_ROLE');
  });

  it('a pharmacy cannot link a WhatsApp number (patient-only route)', async () => {
    const pharmacy = await createStaff('pharmacy');
    const res = await http().get('/api/v1/patients/me/whatsapp').set(bearer(pharmacy.token));
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN_ROLE');
  });

  it('suspending a provider blocks its staff immediately, even with a valid token', async () => {
    const admin = await createAdmin();
    const doctor = await createStaff('doctor');

    const before = await http().get('/api/v1/consent').set(bearer(doctor.token));
    expect(before.status).toBe(200);

    const reject = await http()
      .post(`/api/v1/admin/providers/${doctor.providerId}/reject`)
      .set(bearer(admin.token))
      .send({ reason: 'Licence could not be confirmed' });
    expect(reject.status).toBe(200);
    expect(reject.body.verifiedStatus).toBe('rejected');

    const after = await http().get('/api/v1/consent').set(bearer(doctor.token));
    expect(after.status).toBe(403);
    expect(after.body.error.code).toBe('PROVIDER_NOT_VERIFIED');
  });

  it('admin verification lets a newly registered provider log in', async () => {
    const admin = await createAdmin();
    const email = `new-${crypto.randomUUID()}@test.demo`;
    const reg = await http()
      .post('/api/v1/providers/register')
      .send({
        type: 'diagnostic',
        organisationName: 'New Test Lab',
        registrationNumber: 'NABL-TEST',
        staff: { name: 'Lab Desk', email, password: 'LabTest123' },
      });
    expect(reg.status).toBe(201);
    expect(reg.body.provider.verifiedStatus).toBe('pending');

    const blocked = await http().post('/api/v1/auth/login').send({ email, password: 'LabTest123' });
    expect(blocked.body.error.code).toBe('PROVIDER_NOT_VERIFIED');

    const verify = await http().post(`/api/v1/admin/providers/${reg.body.provider.id}/verify`).set(bearer(admin.token));
    expect(verify.status).toBe(200);

    const login = await http().post('/api/v1/auth/login').send({ email, password: 'LabTest123' });
    expect(login.status).toBe(200);
    expect(login.body.user.role).toBe('diagnostic');

    const dup = await http()
      .post('/api/v1/providers/register')
      .send({ type: 'pharmacy', organisationName: 'Dup', registrationNumber: 'DUP-1', staff: { name: 'Dup', email, password: 'Dup12345' } });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('EMAIL_ALREADY_REGISTERED');
  });
});

describe('internal (n8n) routes', () => {
  it('require the service key', async () => {
    const none = await http().post('/api/v1/internal/whatsapp/resolve').send({ phone: '+919999900001' });
    expect(none.status).toBe(401);
    expect(none.body.error.code).toBe('INVALID_SERVICE_KEY');

    const wrong = await http()
      .post('/api/v1/internal/whatsapp/resolve')
      .set('x-service-key', 'wrong-key')
      .send({ phone: '+919999900001' });
    expect(wrong.status).toBe(401);
  });

  it('a user JWT is not accepted instead of the service key', async () => {
    const admin = await createAdmin();
    const res = await http()
      .post('/api/v1/internal/whatsapp/resolve')
      .set(bearer(admin.token))
      .send({ phone: '+919999900001' });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('INVALID_SERVICE_KEY');
  });
});
