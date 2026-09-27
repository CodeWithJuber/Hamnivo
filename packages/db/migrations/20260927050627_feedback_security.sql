-- Customer feedback (W15): forced RLS on the new table, like every tenant table.
SELECT app.harden_tenant_tables();
