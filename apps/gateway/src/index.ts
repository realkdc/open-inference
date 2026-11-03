import 'dotenv/config';
import { config } from './config.js';
import { communityProvider } from './providers.js';
import { closeServer, createServer } from './server.js';

const app = await createServer();
void communityProvider.start().catch(() => undefined);
await app.listen({ host: config.HOST, port: config.PORT });
app.log.warn(`Open Inference gateway listening on ${config.HOST}:${config.PORT}`);

const shutdown = async () => {
  await app.close().catch(() => undefined);
  await closeServer();
  process.exit(0);
};

process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
