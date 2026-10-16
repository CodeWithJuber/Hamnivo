-- How reply-time clocks ended (H12, O04): forced RLS like every tenant table. A row is written once
-- when a clock ends and never changed or deleted by the application; rows whose clock ended more
-- than 13 months ago are removed by the worker's maintenance schedule, so a year can be compared.
SELECT app.harden_tenant_tables();
--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE ON sla_outcomes FROM hamnivo_app;
--> statement-breakpoint
GRANT SELECT (tenant_id, id, ended_at), DELETE ON sla_outcomes TO hamnivo_resolver;
--> statement-breakpoint
CREATE FUNCTION app.purge_sla_outcomes(p_batch integer DEFAULT 5000)
  RETURNS bigint
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = pg_catalog, public
  AS $$
DECLARE
  lim integer := least(greatest(p_batch, 1), 50000);
  removed bigint;
BEGIN
  DELETE FROM public.sla_outcomes AS o
  USING (
    SELECT x.tenant_id, x.id FROM public.sla_outcomes AS x
    WHERE x.ended_at < now() - interval '13 months'
    ORDER BY x.ended_at LIMIT lim
  ) AS d
  WHERE o.tenant_id = d.tenant_id AND o.id = d.id;
  GET DIAGNOSTICS removed = ROW_COUNT;
  RETURN removed;
END
$$;
--> statement-breakpoint
ALTER FUNCTION app.purge_sla_outcomes(integer) OWNER TO hamnivo_resolver;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.purge_sla_outcomes(integer) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.purge_sla_outcomes(integer) TO hamnivo_app;
