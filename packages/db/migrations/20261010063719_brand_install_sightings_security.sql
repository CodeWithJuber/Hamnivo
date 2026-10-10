-- Custom SQL migration file, put your code below! --
-- Where a brand's chat code was seen (HNV-01-04): forced RLS like every tenant table. The gateway
-- writes a row when a page on one of the brand's allowed websites asks for the chat's launcher,
-- and deletes it when the website is taken off the brand's list.
SELECT app.harden_tenant_tables();
