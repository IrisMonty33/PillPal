import pino from 'pino';
import { config, isProduction, isTest } from '../config';

/**
 * Structured logger. Pretty-printed in development, JSON in production, quiet in tests.
 */
export const logger = pino({
  level: isTest ? 'silent' : config.LOG_LEVEL,
  ...(isProduction
    ? {}
    : {
        transport: {
          target: 'pino-pretty',
          options: { colorize: true, translateTime: 'HH:MM:ss', ignore: 'pid,hostname' },
        },
      }),
});
