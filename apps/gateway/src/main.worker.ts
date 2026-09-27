import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { loadConfig } from './config.js';
import { WorkerModule } from './worker.module.js';

const config = loadConfig();
const app = await NestFactory.createApplicationContext(WorkerModule.forRoot(config), {
  logger: ['error', 'warn', 'log'],
});
app.enableShutdownHooks();
