-- Read-only. Run ONLY in new KSC project REPLACE_WITH_NEW_PROJECT_REF.
-- Export results as CSV so full definitions are retained. No account rows queried.
SELECT 'table' AS category, n.nspname || '.' || c.relname AS object_name,
       'RLS=' || c.relrowsecurity::text AS definition
FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
WHERE n.nspname='public' AND c.relkind IN ('r','p')
UNION ALL
SELECT 'auth_trigger', t.tgname, pg_get_triggerdef(t.oid) || E'\n' || pg_get_functiondef(t.tgfoid)
FROM pg_trigger t WHERE t.tgrelid='auth.users'::regclass AND NOT t.tgisinternal
UNION ALL
SELECT 'event_trigger', e.evtname,
       'enabled=' || e.evtenabled::text || E'\n' || pg_get_functiondef(e.evtfoid)
FROM pg_event_trigger e
UNION ALL
SELECT 'public_definer', p.oid::regprocedure::text, pg_get_functiondef(p.oid)
FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
WHERE n.nspname='public' AND p.prosecdef AND p.prokind='f'
UNION ALL
SELECT 'inspection', 'complete', 'No user records were queried'
ORDER BY category, object_name;
