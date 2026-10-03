-- Custom SQL migration file, put your code below! --
-- Setup (A01, A06, W03): forced RLS on the new tables. The look of each brand's chat, the last test
-- of each AI key, the conversations an owner starts to try the chat, and the setup wizard's
-- progress are all rewritten by the gateway, so none of them is append-only.
SELECT app.harden_tenant_tables();
