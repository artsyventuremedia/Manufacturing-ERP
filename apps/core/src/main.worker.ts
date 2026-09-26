import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Logger } from 'nestjs-pino';
import { loadConfig } from './config/config.js';
import { WorkerModule } from './worker.module.js';

const app = await NestFactory.createApplicationContext(WorkerModule.forRoot(loadConfig()), {
  bufferLogs: true,
  abortOnError: false,
});
app.useLogger(app.get(Logger));
app.enableShutdownHooks();
await app.init();
