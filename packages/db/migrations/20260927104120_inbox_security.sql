-- Staff inbox (H01–H17): forced RLS on the new tables, like every tenant table.
SELECT app.harden_tenant_tables();
