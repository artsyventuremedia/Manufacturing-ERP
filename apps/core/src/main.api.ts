import { createApiApp } from './bootstrap.js';
import { loadConfig } from './config/config.js';

const config = loadConfig();
const app = await createApiApp(config);
await app.listen({ host: config.http.host, port: config.http.port });
