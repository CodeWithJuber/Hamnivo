import { dropDatabase, loadLocalEnv, prepareTemplateDatabase } from '@hamnivo/db/testing';
import type { TestProject } from 'vitest/node';

declare module 'vitest' {
  export interface ProvidedContext {
    templateDatabase: string;
  }
}

export default async function setup(project: TestProject) {
  loadLocalEnv();
  const template = `hamnivo_tpl_gw_${process.pid}`;
  await prepareTemplateDatabase(template);
  project.provide('templateDatabase', template);
  return async () => {
    await dropDatabase(template);
  };
}
