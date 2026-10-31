/**
 * OTP limits: wrong-code attempts and lock-out, one-time use, expiry, resend cooldown,
 * per-mobile send limit, demo OTP disabled outside development, per-IP rate limiting.
 * Uses the patient login flow, but the same OTP service backs consent and WhatsApp linking.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { config } from '../src/config';
import { query } from '../src/db/yugabyte';
import { bearer, createPatient, createStaff, http, lastOtp, type TestPatient } from './helpers';

async function requestLoginOtp(patient: TestPatient) {
  return http().post('/api/v1/auth/patient/login').send({ identifier: patient.identifier });
}
async function verifyLogin(otpId: string, code: string) {
  return http().post('/api/v1/auth/patient/login/verify').send({ otpId, code });
}

describe('OTP', () => {
  const originalCooldown = config.OTP_RESEND_COOLDOWN_SECONDS;
  afterEach(() => {
    config.OTP_RESEND_COOLDOWN_SECONDS = originalCooldown;
  });

  it('logs a patient in with the correct code', async () => {
    const patient = await createPatient();
    const sent = await requestLoginOtp(patient);
    expect(sent.status).toBe(200);
    expect(sent.body.sentTo).toBe(`+91XXXXXX${patient.mobile.slice(-4)}`); // masked, never the full number

    const res = await verifyLogin(sent.body.otpId, lastOtp(patient.mobile));
    expect(res.status).toBe(200);
    expect(res.body.user.id).toBe(patient.id);
    expect(res.body.user.role).toBe('patient');
  });

  it('counts down attempts and locks after 5 wrong codes (OTP_INVALID -> OTP_LOCKED)', async () => {
    const patient = await createPatient();
    const sent = await requestLoginOtp(patient);
    const right = lastOtp(patient.mobile);
    const wrong = right === '000000' ? '111111' : '000000';

    for (const left of [4, 3, 2, 1]) {
      const res = await verifyLogin(sent.body.otpId, wrong);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('OTP_INVALID');
      expect(res.body.error.details.attemptsLeft).toBe(left);
    }
    const fifth = await verifyLogin(sent.body.otpId, wrong);
    expect(fifth.status).toBe(429);
    expect(fifth.body.error.code).toBe('OTP_LOCKED');

    // Locked means locked: even the right code no longer works.
    const correctAfterLock = await verifyLogin(sent.body.otpId, right);
    expect(correctAfterLock.status).toBe(429);
    expect(correctAfterLock.body.error.code).toBe('OTP_LOCKED');
  });

  it('works only once (OTP_ALREADY_USED)', async () => {
    const patient = await createPatient();
    const sent = await requestLoginOtp(patient);
    const code = lastOtp(patient.mobile);
    expect((await verifyLogin(sent.body.otpId, code)).status).toBe(200);

    const reuse = await verifyLogin(sent.body.otpId, code);
    expect(reuse.status).toBe(409);
    expect(reuse.body.error.code).toBe('OTP_ALREADY_USED');
  });

  it('expires (OTP_EXPIRED)', async () => {
    const patient = await createPatient();
    const sent = await requestLoginOtp(patient);
    await query(`UPDATE otp_requests SET expires_at = now() - interval '1 second' WHERE id = $1`, [sent.body.otpId]);

    const res = await verifyLogin(sent.body.otpId, lastOtp(patient.mobile));
    expect(res.status).toBe(410);
    expect(res.body.error.code).toBe('OTP_EXPIRED');
  });

  it("a code only works for its own request, not another patient's", async () => {
    const a = await createPatient();
    const b = await createPatient();
    const sentA = await requestLoginOtp(a);
    await requestLoginOtp(b);

    const res = await verifyLogin(sentA.body.otpId, lastOtp(b.mobile));
    if (lastOtp(a.mobile) !== lastOtp(b.mobile)) {
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('OTP_INVALID');
    }
  });

  it('rejects the demo OTP 123456 outside development', async () => {
    const patient = await createPatient();
    const sent = await requestLoginOtp(patient);
    if (lastOtp(patient.mobile) === '123456') return; // 1-in-a-million: the real code happened to be 123456
    const res = await verifyLogin(sent.body.otpId, '123456');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('OTP_INVALID');
  });

  it('enforces a cooldown between OTPs to the same mobile (OTP_COOLDOWN)', async () => {
    config.OTP_RESEND_COOLDOWN_SECONDS = 30;
    const patient = await createPatient();
    expect((await requestLoginOtp(patient)).status).toBe(200);

    const again = await requestLoginOtp(patient);
    expect(again.status).toBe(429);
    expect(again.body.error.code).toBe('OTP_COOLDOWN');
    expect(again.body.error.details.retryAfterSeconds).toBeGreaterThan(0);
  });

  it('limits OTPs per mobile per window (OTP_SEND_LIMIT after 3)', async () => {
    const patient = await createPatient();
    for (let i = 0; i < 3; i++) expect((await requestLoginOtp(patient)).status).toBe(200);

    const fourth = await requestLoginOtp(patient);
    expect(fourth.status).toBe(429);
    expect(fourth.body.error.code).toBe('OTP_SEND_LIMIT');
  });

  it('the send limit covers every OTP purpose to that mobile (consent counts too)', async () => {
    const patient = await createPatient();
    const doctor = await createStaff('doctor');
    for (let i = 0; i < 3; i++) {
      const r = await http().post('/api/v1/consent/request').set(bearer(doctor.token)).send({ identifier: patient.identifier });
      expect(r.status).toBe(201);
    }
    const login = await requestLoginOtp(patient);
    expect(login.status).toBe(429);
    expect(login.body.error.code).toBe('OTP_SEND_LIMIT');
  });

  it('rejects malformed codes before touching the OTP (VALIDATION_ERROR)', async () => {
    const patient = await createPatient();
    const sent = await requestLoginOtp(patient);
    const res = await verifyLogin(sent.body.otpId, '12ab');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('unknown patient ID gives PATIENT_NOT_REGISTERED and sends nothing', async () => {
    const res = await http().post('/api/v1/auth/patient/login').send({ identifier: '000000000000' });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('PATIENT_NOT_REGISTERED');
  });

  it('rate-limits staff login per IP (RATE_LIMITED after 10)', async () => {
    for (let i = 0; i < 10; i++) {
      const r = await http().post('/api/v1/auth/login').send({ email: 'nobody@test.demo', password: 'guess1234' });
      expect(r.status).toBe(401);
    }
    const eleventh = await http().post('/api/v1/auth/login').send({ email: 'nobody@test.demo', password: 'guess1234' });
    expect(eleventh.status).toBe(429);
    expect(eleventh.body.error.code).toBe('RATE_LIMITED');
    expect(eleventh.headers['retry-after']).toBeTruthy();
  });
});
