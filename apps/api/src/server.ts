import { buildApp } from './app.js';
import { loadEnv } from './config.js';
import { createDb } from './db/index.js';
import { createLogger } from './lib/logger.js';

async function main() {
  const env = loadEnv();
  const logger = createLogger(env);
  const db = createDb(env);
  const app = buildApp({ env, logger, db });

  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'shutting down');
    await app.close();
    await db.destroy();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  try {
    await app.listen({ port: env.PORT, host: '0.0.0.0' });
    logger.info({ port: env.PORT, env: env.APP_ENV }, 'HAVEN API listening');
  } catch (err) {
    logger.error({ err }, 'failed to start');
    process.exit(1);
  }
}

void main();
