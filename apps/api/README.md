# MedChain API (Member 1 — Backend & Databases)

Node.js + TypeScript + Express. Plain SQL against YugabyteDB (Postgres-compatible), MongoDB Atlas for timeline records,
Member 3's Solana service for hash proofs, Member 2's n8n for the AI pipeline and WhatsApp bot.

- Endpoint reference for the frontend: `contracts/frontend-api.md`
- Machine-readable spec (client generation): `contracts/openapi.yaml`

## Run locally

**Option A: everything in Docker** (from the repo root)
```bash
cp apps/api/.env.example apps/api/.env
docker compose up --build
curl http://localhost:4000/health
```

**Option B: DB in Docker, API on your machine (hot reload, best while coding)**
```bash
docker compose up -d db                 # Postgres on localhost:5433
cd apps/api
cp .env.example .env                    # then fill MONGO_URI, SERVICE_API_KEY, SOLANA_SERVICE_URL...
npm install
npm run migrate                         # create/upgrade tables
npm run seed                            # fake demo accounts (password Demo@1234)
npm run dev                             # restarts on code changes (NOT on .env changes: restart for those)
```

## Scripts
| Command | What it does |
|---|---|
| `npm run dev` | API with hot reload |
| `npm run migrate` | Apply pending SQL migrations (safe to re-run) |
| `npm run seed` | Insert fake demo users/providers (refuses in production) |
| `npm test` | Automated tests (needs `docker compose up -d db`) |
| `npm run typecheck` | TypeScript check without building |
| `npm run build` / `npm start` | Production build / run |

## Tests
```bash
docker compose up -d db
cd apps/api
npm test
```
Tests use a separate database, `medchain_test`, on the same Postgres container. It is dropped and rebuilt on every
run, so your dev data is never touched. MongoDB, Solana and n8n are switched off; OTP codes are captured in memory.

Covered: consent required / expiry / revocation / per-accessor grants / OTP ownership, wrong role for every role,
missing / tampered / expired tokens, provider suspension, service key on internal routes, OTP wrong-code lock-out,
one-time use, expiry, resend cooldown, per-mobile send limit, demo OTP disabled outside development, login rate limit.

## Expected responses
- `GET /health` → `200 {"status":"ok","services":{"yugabyte":"up","mongo":"up","solana":{"status":"reachable"}},...}`
- DB stopped → `503 {"status":"degraded",...}`
- Unknown route → `404 {"error":{"code":"NOT_FOUND","message":"..."}}`

## Error format (all endpoints)
```json
{ "error": { "code": "SOME_CODE", "message": "Human readable", "details": {} } }
```

## Build status
- [x] Step 1: project setup, config, Docker
- [x] Step 2: migrations (`npm run migrate`)
- [x] Step 3: auth & roles (`npm run seed` for demo users)
- [x] Step 4: OTP (patient register/login, limits)
- [x] Step 5: consent (OTP grant, revoke, Solana hash + background sync)
- [x] Step 6: records (MongoDB timeline, upload + WebP, n8n trigger, internal callback)
- [x] Step 7: access log (every read logged before data is returned, staff views on Solana)
- [x] Step 8: WhatsApp phone linking + n8n resolve/timeline/upload/chat-history
- [x] Step 9: provider sign-up + admin verify/reject (enforced on every staff request)
- [x] Step 10: contracts/openapi.yaml (37 operations, checked against the routes)
- [x] Step 11: automated tests (`npm test`)
- [ ] Step 12: deployment on Vultr (Nginx + HTTPS, deploy.md) — waiting on the Vultr account
- [x] Render deployment ready (plan B): repo-root `render.yaml` + `infra/render.md`

## Deploying on Render
See `infra/render.md`. Short version: push to GitHub → Render → New → Blueprint → pick the repo → fill `MONGO_URI`
and the other blank values → deploy. The API migrates and seeds itself on startup (`RUN_MIGRATIONS_ON_START`,
`SEED_DEMO_DATA`), and `DEMO_MODE=true` accepts OTP `123456` for judges (fake data only).
