import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { pinoHttp } from 'pino-http';
import { config, isTest } from './config';
import { logger } from './lib/logger';
import { errorHandler, notFoundHandler } from './middleware/errorHandler';
import { authRouter } from './routes/auth';
import { medicationsRouter } from './routes/medications';
import { schedulesRouter } from './routes/schedules';
import { dosesRouter } from './routes/doses';
import { devicesRouter } from './routes/devices';
import { deviceRouter } from './routes/device';
import { vitalsRouter } from './routes/vitals';
import { notificationsRouter } from './routes/notifications';
import { caregiversRouter } from './routes/caregivers';
import { dashboardRouter } from './routes/dashboard';
import { systemRouter } from './routes/system';

/**
 * Builds the Express application (without starting the HTTP server) so tests can
 * use it with supertest. `src/index.ts` is the real entry point.
 */
export function createApp() {
  const app = express();

  app.set('trust proxy', 1); // correct client IPs behind Render/Railway/nginx
  app.disable('x-powered-by');

  app.use(helmet());
  app.use(
    cors({
      origin: config.CORS_ORIGINS === '*' ? true : config.CORS_ORIGINS.split(',').map((o) => o.trim()),
      credentials: true,
    }),
  );
  app.use(express.json({ limit: '1mb' }));

  if (!isTest) {
    app.use(
      pinoHttp({
        logger,
        autoLogging: { ignore: (req) => req.url === '/api/v1/health' },
        customLogLevel: (_req, res, err) => (err || res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info'),
        serializers: {
          req: (req) => ({ method: req.method, url: req.url }),
          res: (res) => ({ statusCode: res.statusCode }),
        },
      }),
    );
  }

  app.get('/', (_req, res) => {
    res.json({ name: 'PillPal API', version: '0.1.0', docs: '/api/v1/health', basePath: '/api/v1' });
  });

  const api = express.Router();
  api.use(systemRouter); //            GET  /api/v1/health, POST /api/v1/system/tick
  api.use('/auth', authRouter); //     app: accounts & tokens
  api.use('/medications', medicationsRouter);
  api.use('/schedules', schedulesRouter);
  api.use('/doses', dosesRouter);
  api.use('/devices', devicesRouter); // app: manage dispensers
  api.use('/device', deviceRouter); //  Raspberry Pi endpoints
  api.use('/vitals', vitalsRouter);
  api.use('/notifications', notificationsRouter);
  api.use('/caregivers', caregiversRouter);
  api.use('/dashboard', dashboardRouter);
  app.use('/api/v1', api);

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
