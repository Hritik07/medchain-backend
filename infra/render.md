# Deploying the MedChain API on Render (free tier)

Plan B / alternative to Vultr. Render builds `apps/api/Dockerfile`, gives you HTTPS automatically
(no Nginx needed), and runs a free Postgres. The repo-root `render.yaml` describes everything.

> Check the hackathon rules first: Vultr is in the required tech stack. If judging needs Vultr, use Render only as a backup.

## Free-tier facts that affect the demo
| Fact | Impact | What we do |
|---|---|---|
| Sleeps after 15 min idle; ~1 min to wake | First request after idle is slow; chain-sync pauses while asleep | Open `/health` ~1 min before demoing |
| Free Postgres: 1 GB, deleted 30 days after creation | Fine for a hackathon | Recreate (redeploy) after 30 days if needed |
| Local disk is wiped on restart/redeploy (and every wake-up) | Uploaded files would disappear | Use S3-compatible storage (`STORAGE_DRIVER=s3`) |
| No shell on free tier | Can't run `npm run migrate:prod` by hand | `RUN_MIGRATIONS_ON_START=true` (API migrates itself) |
| No fixed outbound IP | Atlas IP allowlist can't target Render | Allow `0.0.0.0/0` in Atlas Network Access |

## 1. Before you start
1. Push the repo to GitHub (the `.env` file is git-ignored; never push it).
2. **MongoDB Atlas → Network Access:** add `0.0.0.0/0` (anywhere). The database password still protects it.
3. **File storage (recommended):** create a bucket on any S3-compatible service (Backblaze B2, Cloudflare R2,
   Supabase Storage, ...). Note its endpoint URL, bucket name, access key and secret key. Keep the bucket **private**.

## 2. Create the services
1. Render dashboard → **New → Blueprint** → connect GitHub → pick the repo. Render finds `render.yaml`.
2. It proposes **medchain-api** (web, Docker) and **medchain-db** (Postgres). Fill the `sync: false` values:

| Variable | Value |
|---|---|
| `MONGO_URI` | Your Atlas connection string |
| `API_PUBLIC_URL` | `https://medchain-api.onrender.com` (your real service URL; you can set it after the first deploy) |
| `SOLANA_SERVICE_URL`, `SOLANA_SERVICE_API_KEY` | From Member 3 (leave empty if not ready; consent still works, hashes sync later) |
| `N8N_UPLOAD_WEBHOOK_URL` | From Member 2 (optional) |
| `S3_ENDPOINT`, `S3_BUCKET`, `S3_ACCESS_KEY`, `S3_SECRET_KEY` | From step 1.3 (optional at first) |

3. Apply. The first build takes a few minutes. In the service **Logs** you should see:
   ```
   🗄️  6 migration(s) applied at startup
   ✅ Demo data seeded. Staff logins (password for all: Demo@1234): ...
   🩺 MedChain API listening ...
   🍃 Connected to MongoDB ...            (on the first records request)
   ```
4. Once you have S3 details: set `STORAGE_DRIVER=s3` and the `S3_*` values under **Environment**; Render redeploys.

## 3. Check it
```bash
curl https://medchain-api.onrender.com/health/live    # {"status":"alive"}
curl https://medchain-api.onrender.com/health         # yugabyte "up", mongo "up", demoMode true
```
Then repeat the usual flows against the Render URL (doctor login → consent request → verify with `123456` → timeline).

## 4. Share with the team
- **Member 4 (frontend):** API base URL = your Render URL. Set `CORS_ORIGIN` to the frontend's URL once it's deployed.
- **Member 2 (n8n):** `SERVICE_API_KEY` (Environment tab → reveal) for the `x-service-key` header, and the API URL.
  If n8n runs on someone's laptop, Render can't call back into it unless it's exposed (e.g. ngrok).
- **Member 3 (Solana):** nothing to change; the API calls their URL.

## 5. Demo-mode settings (important)
`render.yaml` sets `DEMO_MODE=true` and `SEED_DEMO_DATA=true` so judges can log in with the fake demo accounts and
OTP `123456`. That means **anyone who knows a patient ID can log in as that patient**, which is acceptable only because
all data is fake. For anything beyond the demo: set `DEMO_MODE=false`, `SEED_DEMO_DATA=false`, and deliver OTPs via
n8n (`OTP_DELIVERY=n8n`, `N8N_OTP_WEBHOOK_URL`).

## Using YugabyteDB instead of Render Postgres
Create a free YugabyteDB cloud cluster, allow `0.0.0.0/0`, copy its connection string, then in Render set
`DATABASE_URL` to it (replacing the `fromDatabase` value) and `DATABASE_SSL=true`. You can delete medchain-db.

## Troubleshooting
| Symptom | Fix |
|---|---|
| Build fails at `npm run build` | TypeScript error: run `npm run typecheck` locally and fix what it reports |
| `Database preparation failed` in logs | Check `DATABASE_URL`; for external/Yugabyte URLs set `DATABASE_SSL=true` |
| `/health` shows `mongo: "down"` | Atlas Network Access must allow `0.0.0.0/0`; check the password in `MONGO_URI` |
| Uploads vanish after a while | Expected with `STORAGE_DRIVER=local` on Render; switch to `s3` |
| `STORAGE_NOT_CONFIGURED` on upload | `STORAGE_DRIVER=s3` but an `S3_*` value is missing |
| `Invalid environment configuration` at boot | A variable has an invalid value (e.g. `TRUST_PROXY=yes`); the log names it |
| Every request slow at first | Free instance was asleep; wait ~1 min |
