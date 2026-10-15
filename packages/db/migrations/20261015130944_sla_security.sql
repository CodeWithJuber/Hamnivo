-- Custom SQL migration file, put your code below! ---- Reply-time targets (H12): a brand's targets per priority, and the clock kept with each
-- conversation's inbox state. Forced RLS like every tenant table.
SELECT app.harden_tenant_tables();
