/**
 * Consent rules: no grant -> no access, expired -> no access, revoked -> no access,
 * grants are per accessor, and only the requesting staff user can use the consent OTP.
 * Records reads are checked on the timeline route: the consent gate runs before Mongo is touched.
 */
import { describe, expect, it } from 'vitest';
import { query } from '../src/db/yugabyte';
import { bearer, createPatient, createStaff, grantConsent, http, lastOtp } from './helpers';

describe('consent', () => {
  it('denies access when no consent was ever given (CONSENT_REQUIRED)', async () => {
    const doctor = await createStaff('doctor');
    const patient = await createPatient();

    const check = await http().get(`/api/v1/consent/check/${patient.id}`).set(bearer(doctor.token));
    expect(check.status).toBe(403);
    expect(check.body.error.code).toBe('CONSENT_REQUIRED');

    const timeline = await http().get(`/api/v1/records/${patient.id}/timeline`).set(bearer(doctor.token));
    expect(timeline.status).toBe(403);
    expect(timeline.body.error.code).toBe('CONSENT_REQUIRED');
  });

  it('grants access after the patient OTP is verified', async () => {
    const doctor = await createStaff('doctor');
    const patient = await createPatient();

    const grant = await grantConsent(doctor, patient, 24);
    expect(grant.state).toBe('active');
    expect(grant.patientId).toBe(patient.id);
    // 24h window (allow a few seconds of clock drift between DB and test)
    const hours = (new Date(grant.expiresAt).getTime() - Date.now()) / 3_600_000;
    expect(hours).toBeGreaterThan(23.9);
    expect(hours).toBeLessThanOrEqual(24);

    const check = await http().get(`/api/v1/consent/check/${patient.id}`).set(bearer(doctor.token));
    expect(check.status).toBe(200);
    expect(check.body.active).toBe(true);
  });

  it('denies access once consent has expired (CONSENT_EXPIRED)', async () => {
    const doctor = await createStaff('doctor');
    const patient = await createPatient();
    const grant = await grantConsent(doctor, patient, 1);

    // Move the grant into the past instead of waiting an hour.
    await query(
      `UPDATE consent_grants SET granted_at = now() - interval '2 hours', expires_at = now() - interval '1 hour' WHERE id = $1`,
      [grant.id],
    );

    const check = await http().get(`/api/v1/consent/check/${patient.id}`).set(bearer(doctor.token));
    expect(check.status).toBe(403);
    expect(check.body.error.code).toBe('CONSENT_EXPIRED');

    const timeline = await http().get(`/api/v1/records/${patient.id}/timeline`).set(bearer(doctor.token));
    expect(timeline.status).toBe(403);
    expect(timeline.body.error.code).toBe('CONSENT_EXPIRED');

    // An expired grant can't be revoked either.
    const revoke = await http().post(`/api/v1/consent/${grant.id}/revoke`).set(bearer(patient.token));
    expect(revoke.status).toBe(409);
    expect(revoke.body.error.code).toBe('CONSENT_ALREADY_EXPIRED');
  });

  it('denies access immediately after the patient revokes (CONSENT_REVOKED)', async () => {
    const doctor = await createStaff('doctor');
    const patient = await createPatient();
    const grant = await grantConsent(doctor, patient);

    const revoke = await http().post(`/api/v1/consent/${grant.id}/revoke`).set(bearer(patient.token));
    expect(revoke.status).toBe(200);
    expect(revoke.body.state).toBe('revoked');
    expect(revoke.body.revokedAt).toBeTruthy();

    const check = await http().get(`/api/v1/consent/check/${patient.id}`).set(bearer(doctor.token));
    expect(check.status).toBe(403);
    expect(check.body.error.code).toBe('CONSENT_REVOKED');

    const timeline = await http().get(`/api/v1/records/${patient.id}/timeline`).set(bearer(doctor.token));
    expect(timeline.status).toBe(403);
    expect(timeline.body.error.code).toBe('CONSENT_REVOKED');

    const again = await http().post(`/api/v1/consent/${grant.id}/revoke`).set(bearer(patient.token));
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('CONSENT_ALREADY_REVOKED');
  });

  it('a new grant restores access after a revoke', async () => {
    const doctor = await createStaff('doctor');
    const patient = await createPatient();
    const first = await grantConsent(doctor, patient);
    await http().post(`/api/v1/consent/${first.id}/revoke`).set(bearer(patient.token));

    await grantConsent(doctor, patient);
    const check = await http().get(`/api/v1/consent/check/${patient.id}`).set(bearer(doctor.token));
    expect(check.status).toBe(200);
  });

  it("one doctor's grant does not give access to another doctor", async () => {
    const doctorA = await createStaff('doctor');
    const doctorB = await createStaff('doctor');
    const patient = await createPatient();
    await grantConsent(doctorA, patient);

    const check = await http().get(`/api/v1/consent/check/${patient.id}`).set(bearer(doctorB.token));
    expect(check.status).toBe(403);
    expect(check.body.error.code).toBe('CONSENT_REQUIRED');
  });

  it('only the staff user who requested consent can use its OTP (OTP_NOT_YOURS)', async () => {
    const doctorA = await createStaff('doctor');
    const doctorB = await createStaff('doctor');
    const patient = await createPatient();

    const req = await http()
      .post('/api/v1/consent/request')
      .set(bearer(doctorA.token))
      .send({ identifier: patient.identifier });
    expect(req.status).toBe(201);

    const stolen = await http()
      .post('/api/v1/consent/verify')
      .set(bearer(doctorB.token))
      .send({ otpId: req.body.otpId, code: lastOtp(patient.mobile) });
    expect(stolen.status).toBe(403);
    expect(stolen.body.error.code).toBe('OTP_NOT_YOURS');

    // ...and the OTP is still usable by the right doctor.
    const ok = await http()
      .post('/api/v1/consent/verify')
      .set(bearer(doctorA.token))
      .send({ otpId: req.body.otpId, code: lastOtp(patient.mobile) });
    expect(ok.status).toBe(201);
  });

  it('rejects consent durations outside 1-72 hours', async () => {
    const doctor = await createStaff('doctor');
    const patient = await createPatient();
    const res = await http()
      .post('/api/v1/consent/request')
      .set(bearer(doctor.token))
      .send({ identifier: patient.identifier, durationHours: 100 });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_DURATION');
  });

  it('stores the consent even when the Solana service is unavailable', async () => {
    const doctor = await createStaff('doctor');
    const patient = await createPatient();
    const grant = (await grantConsent(doctor, patient)) as unknown as { chain: { status: string } };
    expect(grant.chain.status).toBe('not_recorded'); // retried later by the chain-sync job
  });

  it('never stores the raw identifier', async () => {
    const patient = await createPatient();
    const { rows } = await query<{ hashed_identifier: string }>('SELECT hashed_identifier FROM users WHERE id = $1', [patient.id]);
    expect(rows[0].hashed_identifier).not.toContain(patient.identifier);
    expect(rows[0].hashed_identifier).toMatch(/^[0-9a-f]{64}$/);
  });
});
