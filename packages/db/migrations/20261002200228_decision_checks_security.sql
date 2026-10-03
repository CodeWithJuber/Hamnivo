-- Decision checks around AI replies: forced RLS on the new table, and its rows are written once.
-- A check record says what the provider answered and what Hamnivo did; nothing may rewrite it.
SELECT app.harden_tenant_tables();
--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE ON decision_checks FROM hamnivo_app;
