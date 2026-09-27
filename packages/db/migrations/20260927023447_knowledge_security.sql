-- Knowledge: forced RLS on the new tables. Chunks keep only derived text and vectors; the original
-- upload stays in document_versions.raw until ingestion finishes and is then cleared.
SELECT app.harden_tenant_tables();
