import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/schema/index.ts',
  schemaFilter: ['public', 'auth'],
  out: './migrations',
  strict: true,
  verbose: true,
  migrations: {
    prefix: 'timestamp',
    table: '__drizzle_migrations',
    schema: 'drizzle',
  },
  dbCredentials: {
    url: process.env.DATABASE_OWNER_URL ?? 'postgres://localhost/hamnivo',
  },
});
