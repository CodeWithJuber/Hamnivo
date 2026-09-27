-- Staff authentication tables are used only by the application role. They are global (one person
-- can be staff in several tenants), so they carry no tenant policy; tenant membership and grants
-- live in public.staff_members and public.grants. The platform role has no access.
REVOKE ALL ON SCHEMA auth FROM PUBLIC;
--> statement-breakpoint
GRANT USAGE ON SCHEMA auth TO hamnivo_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA auth TO hamnivo_app;
--> statement-breakpoint
ALTER DEFAULT PRIVILEGES IN SCHEMA auth GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO hamnivo_app;
