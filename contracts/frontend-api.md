# MedChain API — Frontend Reference

Every endpoint the frontend calls, with request bodies, responses and error codes.
Owner: Member 1 (backend). Status: all frontend-facing endpoints built (Steps 1–9).
The machine-readable version for client generation is `contracts/openapi.yaml`.

---

## 1. Basics

| | |
|---|---|
| Base URL (dev) | `http://localhost:4000` |
| Base URL (hosted) | `https://medchain-api.onrender.com` (Render) or the Vultr domain later |
| Body format | JSON (`Content-Type: application/json`), except file upload (`multipart/form-data`) |
| Auth | `Authorization: Bearer <token>` on every endpoint except login/register/health |
| Token lifetime | 8 hours. On `401` with `TOKEN_EXPIRED` or `INVALID_TOKEN` → send the user back to login |
| Times | ISO-8601 UTC strings, e.g. `2026-11-01T10:00:00.000Z` |
| IDs | Users/patients/grants: UUID. Records (timeline entries): 24-char hex |

### Roles
`patient`, `doctor`, `pharmacy`, `diagnostic` (labs), `admin`

### Error format (every failure)
```json
{ "error": { "code": "CONSENT_EXPIRED", "message": "Consent has expired, please request a new OTP", "details": {} } }
```
Show `message` to the user; branch UI logic on `code` (never on `message`). `details` is optional.

### Common error codes
| HTTP | code | Meaning / what the UI should do |
|---|---|---|
| 400 | `VALIDATION_ERROR` | A field is missing or invalid; `details.fieldErrors` says which |
| 400 | `INVALID_JSON` | Malformed body |
| 401 | `AUTH_REQUIRED` | No token sent |
| 401 | `TOKEN_EXPIRED` / `INVALID_TOKEN` | Log the user out |
| 403 | `FORBIDDEN_ROLE` | This role can't do this |
| 404 | `NOT_FOUND` | Wrong URL |
| 429 | `RATE_LIMITED` | Too many requests; `details.retryAfterSeconds` |
| 500 | `INTERNAL_ERROR` | Server bug — show a generic error |

### Demo accounts (fake data, `npm run seed`)
| Role | Login | Notes |
|---|---|---|
| admin | `admin@medchain.demo` / `Demo@1234` | |
| doctor | `doctor@medchain.demo` / `Demo@1234` | Dr. Anita Sharma, Sharma Family Clinic |
| pharmacy | `pharmacy@medchain.demo` / `Demo@1234` | |
| diagnostic | `lab@medchain.demo` / `Demo@1234` | |
| patient | ID `000000000001`, mobile `+919999900001` | Ramesh Kumar, patientId `33333333-3333-4333-8333-000000000001` |
| patient | ID `000000000002`, mobile `+919999900002` | Sunita Devi, patientId `33333333-3333-4333-8333-000000000002` |

**OTP in development:** the code is printed in the backend console, and `123456` always works in dev.

---

## 2. Main user flows

**Doctor visit**
1. `POST /api/v1/auth/login` → token
2. Doctor types patient's 12-digit ID → `POST /api/v1/consent/request` → OTP sent to the patient's phone
3. Patient reads the OTP aloud → `POST /api/v1/consent/verify` → grant (contains `patientId`)
4. `GET /api/v1/records/{patientId}/timeline` → full history, abnormal lab values flagged
5. Open a file → `GET /api/v1/records/{patientId}/entries/{entryId}/file`

**Patient app**
1. `POST /api/v1/auth/patient/register` (first time) or `/login` → OTP → `/verify` → token; `user.id` **is** their `patientId`
2. `GET /api/v1/records/{patientId}/timeline`
3. Upload a bill/prescription → `POST /api/v1/records/{patientId}/entries` (shown as "Patient-uploaded, unverified")
4. See and revoke access → `GET /api/v1/consent`, `POST /api/v1/consent/{grantId}/revoke`
5. Who viewed my records → `GET /api/v1/access-log`

**Pharmacy / lab**
Login → consent request/verify (same as doctor) → upload bill/report to the patient's timeline.

---

## 3. Auth — staff (doctor, pharmacy, diagnostic, admin)

### `POST /api/v1/auth/login`
Public. Rate limit: 10 per 10 min per IP.
```json
// request
{ "email": "doctor@medchain.demo", "password": "Demo@1234" }
// 200
{ "token": "eyJhbGciOi...", "user": { "id": "2222...0002", "role": "doctor", "providerId": "1111...0001", "name": "Dr. Anita Sharma" } }
```
Errors: `401 INVALID_CREDENTIALS`, `403 PROVIDER_NOT_VERIFIED` (organisation not yet approved by admin), `429 RATE_LIMITED`.

### `GET /api/v1/auth/me`
Any logged-in role.
```json
// 200
{ "id": "2222...0002", "role": "doctor", "name": "Dr. Anita Sharma", "providerId": "1111...0001" }
```

---

## 4. Auth — patients (OTP only, no passwords)

All public. Rate limit: 30 per 10 min per IP. Per mobile: one OTP every 30 s, max 3 per 15 min.
`identifier` = 12-digit ID; spaces and dashes are allowed (`"0000 0000 0001"`). It is hashed immediately and never stored or returned.

### `POST /api/v1/auth/patient/register`
```json
// request
{ "identifier": "000000000009", "name": "Test Patient", "mobile": "9999900009" }
// 201
{ "otpId": "6f1c...", "expiresAt": "2026-11-01T10:05:00.000Z", "sentTo": "+91XXXXXX0009" }
```
`mobile` accepts `9876543210`, `+919876543210`, `09876543210`.
Errors: `400 INVALID_IDENTIFIER`, `400 INVALID_MOBILE`, `409 PATIENT_ALREADY_REGISTERED`, OTP send errors (below).

### `POST /api/v1/auth/patient/register/verify`
```json
// request
{ "otpId": "6f1c...", "code": "123456" }
// 201
{ "token": "eyJ...", "user": { "id": "<patientId>", "role": "patient", "providerId": null, "name": "Test Patient" } }
```

### `POST /api/v1/auth/patient/login`
```json
// request
{ "identifier": "000000000001" }
// 200
{ "otpId": "...", "expiresAt": "...", "sentTo": "+91XXXXXX0001" }
```
Errors: `404 PATIENT_NOT_REGISTERED`, `409 NO_MOBILE_ON_FILE`, OTP send errors.

### `POST /api/v1/auth/patient/login/verify`
Same request/response shape as `register/verify` (200 instead of 201).

### OTP errors (used by every `.../verify` and every OTP request)
| HTTP | code | UI hint |
|---|---|---|
| 429 | `OTP_COOLDOWN` | "Wait N seconds" — `details.retryAfterSeconds` |
| 429 | `OTP_SEND_LIMIT` | Too many OTPs to this number; try later |
| 400 | `OTP_INVALID` | Wrong code — show `details.attemptsLeft` |
| 429 | `OTP_LOCKED` | 5 wrong tries — must request a new OTP |
| 410 | `OTP_EXPIRED` | Valid 5 minutes — request a new one |
| 409 | `OTP_ALREADY_USED` | Request a new OTP |
| 404 | `OTP_NOT_FOUND` | Bad `otpId` |

---

## 5. Consent — `/api/v1/consent`

Requires a token. Rate limit: 60 per 10 min.

### Grant object (returned by several endpoints)
```json
{
  "id": "9b2e...",                       // grantId
  "patientId": "3333...0001",
  "accessorId": "2222...0002",
  "purpose": "General checkup",
  "state": "active",                     // active | expired | revoked
  "grantedAt": "2026-11-01T10:00:00.000Z",
  "expiresAt": "2026-11-02T10:00:00.000Z",
  "revokedAt": null,
  "chain": { "status": "confirmed", "solanaTx": "5Kq..." },     // confirmed | chain_pending | not_recorded
  "revokeChain": null,                   // same shape once revoked
  // only in some responses:
  "patientName": "Ramesh Kumar (DEMO, 72y)",                    // staff views
  "accessorName": "Dr. Anita Sharma", "accessorRole": "doctor", "providerName": "Sharma Family Clinic (DEMO)"  // patient view
}
```

### `POST /api/v1/consent/request`
Roles: doctor, pharmacy, diagnostic. Sends an OTP to the **patient's** registered mobile.
```json
// request (purpose and durationHours optional)
{ "identifier": "000000000001", "purpose": "General checkup", "durationHours": 24 }
// 201
{ "otpId": "...", "expiresAt": "...", "sentTo": "+91XXXXXX0001", "durationHours": 24, "purpose": "General checkup" }
```
`durationHours`: 1–72, default 24. `purpose`: 3–100 chars, default `"treatment"`.
Errors: `404 PATIENT_NOT_REGISTERED`, `409 NO_MOBILE_ON_FILE`, `400 INVALID_DURATION`, OTP send errors.

### `POST /api/v1/consent/verify`
Roles: doctor, pharmacy, diagnostic — must be the same user who requested it.
```json
// request
{ "otpId": "...", "code": "123456" }
// 201 → Grant object (with patientName). Use grant.patientId for the records endpoints.
```
Errors: `403 OTP_NOT_YOURS`, OTP verify errors.

### `GET /api/v1/consent`
Roles: patient (grants **on me**, with accessor/provider names) or staff (grants **I hold**, with patient names). Newest first, max 100.
```json
{ "grants": [ /* Grant objects */ ] }
```

### `GET /api/v1/consent/check/{patientId}`
Roles: doctor, pharmacy, diagnostic. "Do I currently have access?"
```json
// 200
{ "active": true, "grant": { /* Grant */ } }
```
Errors: `403 CONSENT_REQUIRED` (never granted), `403 CONSENT_EXPIRED`, `403 CONSENT_REVOKED` → show "Request access" button.

### `POST /api/v1/consent/{grantId}/revoke`
Roles: the patient on the grant, the staff user on the grant, or admin. No body.
```json
// 200 → Grant object with state "revoked"
```
Errors: `404 CONSENT_NOT_FOUND`, `409 CONSENT_ALREADY_REVOKED`, `409 CONSENT_ALREADY_EXPIRED`.

### `GET /api/v1/consent/{grantId}/chain-verify`
Parties to the grant. Re-checks the consent hash on Solana.
```json
{ "status": "verified" }   // verified | mismatch | not-found | not-recorded | unavailable
```

---

## 6. Records — `/api/v1/records`

Roles: patient (own records only), doctor/pharmacy/diagnostic (**only with an active consent grant**).
Every successful call is written to the patient's access log.

**Consent errors on any records endpoint:** `403 CONSENT_REQUIRED`, `403 CONSENT_EXPIRED`, `403 CONSENT_REVOKED`
→ send staff to the consent flow. Patients get `403 NOT_YOUR_RECORDS` for someone else's `patientId`.

### Entry object
```json
{
  "id": "6724f1c2a9e3b1d4c5e6f7a8",
  "patientId": "3333...0001",
  "type": "lab_report",                    // prescription | pharmacy_bill | lab_report | visit_note | other
  "title": "CBC",
  "date": "2026-10-28T00:00:00.000Z",      // date of the visit/bill/report
  "source": "provider",                    // provider | patient_uploaded
  "verified": true,                        // false for patient uploads
  "sourceLabel": "Uploaded by City Diagnostics (DEMO)",   // or "Patient-uploaded, unverified" — show as-is
  "uploadedBy": { "role": "diagnostic", "providerName": "City Diagnostics (DEMO)" },
  "file": { "mime": "image/webp", "size": 183422, "originalName": "cbc.jpg" },
  "docHash": "a3f5...",                    // SHA-256 of the stored file
  "chain": { "status": "confirmed", "solanaTx": "5Kq..." },
  "processingStatus": "processed",         // pending | processed | failed | skipped (AI reading the document)
  "extracted": null,                       // optional structured data from the AI pipeline
  "labResults": {                          // null until the AI has read a lab report
    "tests": [
      { "name": "Haemoglobin", "value": 9.8, "unit": "g/dL", "rangeLow": 12, "rangeHigh": 15.5,
        "status": "low", "abnormal": true, "confidence": 0.95 },
      { "name": "TSH", "value": 2.1, "unit": "mIU/L", "rangeLow": 0.4, "rangeHigh": 4,
        "status": "normal", "abnormal": false, "confidence": 0.92 }
    ],
    "abnormalCount": 1
  },
  "createdAt": "2026-11-01T10:12:00.000Z"
}
```
`labResults.tests[].status`: `high` | `low` | `normal` | `unknown`. Highlight `abnormal: true` rows.
`rangeLow`/`rangeHigh` are the reference range printed on that report. The app flags values; it **never diagnoses**.
Suggested UI copy: "Outside the range printed on this report — discuss with your doctor."

### `POST /api/v1/records/{patientId}/entries` — upload
`multipart/form-data`. Rate limit: 30 per 10 min.

| Field | Required | Notes |
|---|---|---|
| `file` | yes | JPG, PNG, WebP or PDF; max 10 MB. Images are compressed to WebP by the server |
| `type` | yes | `prescription` \| `pharmacy_bill` \| `lab_report` \| `visit_note` \| `other` |
| `title` | no | up to 200 chars |
| `date` | no | date of the document, e.g. `2026-10-28`; defaults to today; not in the future |

```js
const form = new FormData();
form.append('file', fileInput.files[0]);
form.append('type', 'lab_report');
form.append('title', 'CBC');
await fetch(`${API}/api/v1/records/${patientId}/entries`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${token}` },   // do NOT set Content-Type; the browser adds the boundary
  body: form,
});
// 201 → Entry object
```
Errors: `400 FILE_REQUIRED`, `413 FILE_TOO_LARGE`, `415 UNSUPPORTED_FILE_TYPE`, `400 INVALID_IMAGE`, `400 UPLOAD_ERROR`, consent errors.

### `GET /api/v1/records/{patientId}/timeline?type=&limit=`
Newest first. `type` optional filter; `limit` 1–500 (default 200).
```json
{ "patientId": "3333...0001", "count": 12, "abnormalCount": 3, "entries": [ /* Entry objects */ ] }
```

### `GET /api/v1/records/{patientId}/entries/{entryId}`
→ Entry object. Errors: `404 RECORD_NOT_FOUND`.

### `GET /api/v1/records/{patientId}/entries/{entryId}/file`
Returns the file bytes (`image/webp` or `application/pdf`), not JSON.
Because it needs the `Authorization` header, a plain `<img src>` won't work — fetch it as a blob:
```js
const res = await fetch(`${API}/api/v1/records/${patientId}/entries/${entryId}/file`, {
  headers: { Authorization: `Bearer ${token}` },
});
const url = URL.createObjectURL(await res.blob());   // use in <img src> or <iframe src> for PDFs
// call URL.revokeObjectURL(url) when the viewer closes
```

### `GET /api/v1/records/{patientId}/entries/{entryId}/verify`
Re-hashes the stored file and checks it against Solana. Use for the badge.
```json
{ "status": "verified", "storedFileIntact": true, "timestamp": "..." }
```

**Badge rule (from Member 3's contract):**
| Response | Badge |
|---|---|
| `status: "verified"` and `storedFileIntact: true` | ✅ **Verified** |
| `status: "mismatch"` or `storedFileIntact: false` | ⚠️ **Tampered** |
| anything else (`not-recorded`, `not-found`, `unavailable`, pending) | ⏳ **Not recorded / Pending** |

Patient uploads additionally always show the **"Patient-uploaded, unverified"** label (`sourceLabel`) — the hash proves the file wasn't changed after upload, not that its contents are genuine.

---

## 7. Access log — `/api/v1/access-log`

### `GET /api/v1/access-log?limit=50&before=&includeSelf=false`
Roles: patient (own log), admin (any patient via `&patientId=<uuid>`). Newest first.
The patient's own views are hidden unless `includeSelf=true`.
```json
{
  "patientId": "3333...0001",
  "entries": [
    {
      "id": "c0d1...",
      "viewedAt": "2026-11-01T10:15:00.000Z",
      "action": "view_timeline",          // view_timeline | view_record | view_file | verify_record | upload
      "recordIds": ["6724f1c2...", "6724f1d9..."],
      "accessor": { "id": "2222...0002", "name": "Dr. Anita Sharma", "role": "doctor", "providerName": "Sharma Family Clinic (DEMO)" },
      "consent": { "grantId": "9b2e...", "purpose": "General checkup" },   // null for the patient's own views
      "chain": { "status": "confirmed", "solanaTx": "3Xy..." }             // status null = not anchored (own views)
    }
  ],
  "nextBefore": "2026-11-01T09:00:00.000Z"   // pass as ?before= for the next page; null = no more
}
```
Suggested labels: `view_timeline` "Viewed your timeline", `view_record` "Opened a record", `view_file` "Opened a document",
`verify_record` "Checked a document's authenticity", `upload` "Added a document".
Errors: `400 PATIENT_ID_REQUIRED` (admin without `patientId`).

---

## 8. Patient settings — `/api/v1/patients` (patient token)

The WhatsApp bot recognises patients **only** by a number they verified here (Aadhaar is never typed into chat).
One number per patient; linking a new one replaces the old one.

### `POST /api/v1/patients/me/whatsapp/link`
```json
// request
{ "mobile": "9999900001" }
// 201 — OTP sent to THAT number
{ "otpId": "...", "expiresAt": "...", "sentTo": "+91XXXXXX0001" }
```
Errors: `400 INVALID_MOBILE`, `409 PHONE_LINKED_TO_ANOTHER_PATIENT`, OTP send errors.

### `POST /api/v1/patients/me/whatsapp/verify`
```json
// request
{ "otpId": "...", "code": "123456" }
// 200
{ "linked": true, "phone": "+91XXXXXX0001", "verifiedAt": "2026-11-01T10:20:00.000Z" }
```
Errors: `403 OTP_NOT_YOURS`, `409 PHONE_LINKED_TO_ANOTHER_PATIENT`, OTP verify errors.

### `GET /api/v1/patients/me/whatsapp`
```json
{ "linked": true, "phone": "+91XXXXXX0001", "verifiedAt": "..." }   // or { "linked": false, "phone": null, "verifiedAt": null }
```

### `DELETE /api/v1/patients/me/whatsapp`
Unlinks. → `{ "linked": false }`

### `DELETE /api/v1/patients/me/chat-history`
Erases the backend's fallback copy of the chatbot conversation (right to erasure). → `{ "deleted": 14 }`
(The main chatbot memory in Meko is erased via Member 2's service.)

---

## 9. Health — `GET /health`
Public. Useful for a status indicator in dev.
```json
{ "status": "ok", "env": "development", "demoMode": false,
  "services": { "yugabyte": "up", "mongo": "up", "solana": { "status": "reachable" } }, "time": "..." }
```
`GET /health/live` → `{ "status": "alive", "time": "..." }`: instant, no database checks (used by hosting health checks).

On the hosted demo (Render), `demoMode: true` means OTP `123456` works with the fake demo accounts.
The free server sleeps when idle: the first request after a while can take ~1 minute.

---

## 10. Providers — onboarding & admin verification

### Provider object
```json
{
  "id": "1111...",
  "type": "pharmacy",                     // doctor | pharmacy | diagnostic
  "name": "Jan Aushadhi Demo Pharmacy",
  "registrationNumber": "DL-DEMO-0002",
  "verifiedStatus": "pending",            // pending | verified | rejected
  "verifiedAt": null,
  "rejectionReason": null,
  "createdAt": "2026-11-01T11:00:00.000Z",
  // admin listing only:
  "contact": { "name": "Ravi Kumar", "email": "ravi@example.demo" },
  "staffCount": 1
}
```

### `POST /api/v1/providers/register`
Public sign-up for a clinic, pharmacy or lab, with its first staff login. Rate limit: 5 per hour per IP.
```json
// request
{
  "type": "pharmacy",
  "organisationName": "Jan Aushadhi Demo Pharmacy 2",
  "registrationNumber": "DL-DEMO-0099",
  "staff": { "name": "Ravi Kumar", "email": "ravi@example.demo", "password": "Pharma123", "mobile": "9999900050" }
}
// 201
{ "provider": { /* Provider, verifiedStatus "pending" */ },
  "message": "Registration received. You can log in once a MedChain admin verifies your organisation." }
```
Password: 8–72 chars, at least one letter and one number. `mobile` optional.
The staff account's role equals `type`. Login returns `403 PROVIDER_NOT_VERIFIED` until an admin approves.
Errors: `409 EMAIL_ALREADY_REGISTERED`, `400 VALIDATION_ERROR`, `429 RATE_LIMITED`.

### `GET /api/v1/providers/me`
Roles: doctor, pharmacy, diagnostic. → Provider object (their own organisation).

### `GET /api/v1/admin/providers?status=pending&type=`
Role: admin. `status`: `pending` (default) | `verified` | `rejected` | `all`. `type` optional. Newest first, max 200.
```json
{ "providers": [ /* Provider objects with contact + staffCount */ ] }
```

### `POST /api/v1/admin/providers/{providerId}/verify`
Role: admin. No body. → Provider with `verifiedStatus: "verified"`.
Errors: `404 PROVIDER_NOT_FOUND`, `409 PROVIDER_ALREADY_VERIFIED`.

### `POST /api/v1/admin/providers/{providerId}/reject`
Role: admin. Rejects a pending provider, or **suspends** a verified one.
```json
// request
{ "reason": "Licence number could not be confirmed" }
// 200 → Provider with verifiedStatus "rejected" and rejectionReason
```
Takes effect immediately: that provider's staff get `403 PROVIDER_NOT_VERIFIED` on every consent and records call,
even with a token they already hold. Errors: `404 PROVIDER_NOT_FOUND`, `400 VALIDATION_ERROR` (reason 3–300 chars).

**Also returned on consent and records endpoints:** `403 PROVIDER_NOT_VERIFIED` → show "Your organisation is pending review or suspended".

---

## 11. Minimal fetch helper

```ts
const API = import.meta.env.VITE_API_URL ?? 'http://localhost:4000';

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public details?: unknown) { super(message); }
}

export async function api<T>(path: string, opts: { method?: string; body?: unknown; token?: string } = {}): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    method: opts.method ?? 'GET',
    headers: {
      ...(opts.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}),
    },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = data.error ?? {};
    throw new ApiError(res.status, e.code ?? 'UNKNOWN', e.message ?? 'Request failed', e.details);
  }
  return data as T;
}

// usage
// const { token, user } = await api('/api/v1/auth/login', { method: 'POST', body: { email, password } });
// try { await api(`/api/v1/records/${pid}/timeline`, { token }) }
// catch (e) { if (e instanceof ApiError && e.code.startsWith('CONSENT_')) showRequestAccess(); }
```
