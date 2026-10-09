-- Custom SQL migration file, put your code below! --
-- Tickets, chat forms and consent: forced RLS on the new tables, like every tenant table. A
-- customer's agreement to a brand's words is a record of what happened, so the application only
-- ever adds to it; counters only ever go up, so the application never removes one.
SELECT app.harden_tenant_tables();
--> statement-breakpoint
-- The application role only ever holds SELECT, INSERT, UPDATE and DELETE (the default privileges
-- in the foundations migration), so these are the rights taken back here.
REVOKE UPDATE, DELETE ON chat_consents FROM hamnivo_app;
--> statement-breakpoint
REVOKE DELETE ON tenant_counters FROM hamnivo_app;
