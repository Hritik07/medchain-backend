/**
 * Builds the Express app (middleware + routes) without starting a server.
 * Splitting this from main.ts lets the tests in Step 11 import the app directly.
 * Feature routers (auth, otp, consent, records...) get mounted here as each step is built.
 */
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { config } from './config';
import { errorHandler, notFoundHandler } from './middleware/errors';
import { pingYugabyte } from './db/yugabyte';
import { pingMongo } from './db/mongo';
import { probeChainService } from './integrations/solana';
import { authRouter } from './auth/routes';
import { patientAuthRouter } from './auth/patient-routes';
import { consentRouter } from './consent/routes';
import { recordsRouter } from './records/routes';
import { internalRouter } from './records/internal-routes';
import { accessLogRouter } from './access-log/routes';
import { patientsRouter } from './patients/routes';
import { internalPatientsRouter } from './patients/internal-routes';
import { providersRouter } from './providers/routes';
import { adminProvidersRouter } from './providers/admin-routes';

export function createApp() {
  const app = express();
  if (config.TRUST_PROXY) app.set('trust proxy', 1); // one proxy hop (Nginx / Render's router) in front of the API
  app.disable('x-powered-by');

  // Liveness: instant 200 if the process is up. Used by hosting health checks (Render), which must be fast
  // and must not fail just because Mongo or the Solana tunnel is slow. /health below is the detailed check.
  app.get('/health/live', (_req, res) => {
    res.json({ status: 'alive', time: new Date().toISOString() });
  });

  app.use(helmet());
  app.use(cors({ origin: config.CORS_ORIGIN }));
  app.use(express.json({ limit: '1mb' })); // file uploads use multipart (multer), not JSON

  // Health check: used by Docker, Nginx and the team to confirm the API and DBs are up.
  app.get('/health', async (_req, res) => {
    const yugabyte = await pingYugabyte();
    const [mongo, solana] = await Promise.all([pingMongo(), probeChainService()]);
    res.status(yugabyte ? 200 : 503).json({
      status: yugabyte ? 'ok' : 'degraded',
      env: config.NODE_ENV,
      demoMode: config.DEMO_MODE,
      services: { yugabyte: yugabyte ? 'up' : 'down', mongo, solana },
      time: new Date().toISOString(),
    });
  });

  // --- Feature routers (one per module, all under /api/v1) ---
  app.use('/api/v1/auth/patient', patientAuthRouter);
  app.use('/api/v1/auth', authRouter);
  app.use('/api/v1/consent', consentRouter);
  app.use('/api/v1/records', recordsRouter);
  app.use('/api/v1/access-log', accessLogRouter);
  app.use('/api/v1/patients', patientsRouter);
  app.use('/api/v1/providers', providersRouter);
  app.use('/api/v1/admin/providers', adminProvidersRouter);
  app.use('/api/v1/internal', internalRouter, internalPatientsRouter); // n8n only (x-service-key)

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
