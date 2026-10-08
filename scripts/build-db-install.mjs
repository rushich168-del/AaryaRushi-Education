import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

// Explicit allowlist: never include inherited Atlas migrations or local auth scaffolding.
const files = [
 '202609100001_ksc_v1_foundation.sql',
 '202609110002_test_builder.sql',
 '202609110003_student_exam_engine.sql',
 '202609110004_fix_rls.sql',
 '202609110005_results_foundation.sql',
 '202609110006_fix_results_types.sql',
 '202609110007_content_hierarchy.sql',
 '202609110008_exam_contract_repair.sql',
 '202609110009_exam_contract_closure.sql',
 '202609130010_student_provisioning.sql',
];
const fixture = await readFile(new URL('fixtures/ksc-auto-rls.sql', import.meta.url), 'utf8');
const reviewedBody = fixture.split('$function$')[1];
let sql = `-- KSC fresh installation; preflight reviewed 2026-09-13.
-- Only for REPLACE_WITH_NEW_PROJECT_REF (KSC). Select that project in the dashboard.
-- SQL cannot independently prove the dashboard project reference.
-- All-or-nothing fresh install; rejects existing public tables/auth triggers.
BEGIN;
SET LOCAL lock_timeout = '5s';
DO $$ BEGIN
 IF EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
            WHERE n.nspname='public' AND c.relkind IN ('r','p','v','m','f'))
 OR EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid='auth.users'::regclass AND NOT tgisinternal)
 OR EXISTS (SELECT 1 FROM pg_namespace WHERE nspname='ksc_private')
 THEN RAISE EXCEPTION 'Fresh KSC target required; existing objects found. No changes applied.';
 END IF;
END $$;
`;
sql += `
-- Preserve the reviewed platform RLS event function; reject other implementations.
DO $check$ DECLARE f record; BEGIN
 SELECT p.*, l.lanname INTO f FROM pg_proc p JOIN pg_language l ON l.oid=p.prolang
 WHERE p.oid=to_regprocedure('public.rls_auto_enable()');
 IF NOT FOUND OR f.prorettype <> 'event_trigger'::regtype OR NOT f.prosecdef
 OR f.lanname <> 'plpgsql' OR f.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog']
 OR regexp_replace(f.prosrc, '[[:space:]]', '', 'g') IS DISTINCT FROM
    regexp_replace($reviewed$${reviewedBody}$reviewed$, '[[:space:]]', '', 'g')
 THEN RAISE EXCEPTION 'Automatic RLS function differs from reviewed preflight; stop and inspect'; END IF;
 IF NOT EXISTS (SELECT 1 FROM pg_event_trigger WHERE evtfoid=f.oid AND evtenabled IN ('O','A'))
 THEN RAISE EXCEPTION 'Automatic RLS event trigger is not enabled'; END IF;
END $check$;
REVOKE ALL ON FUNCTION public.rls_auto_enable() FROM PUBLIC, anon, authenticated, service_role;
`;
const manifest = [];
for (const file of files) {
 let content = await readFile(new URL('../supabase/migrations/' + file, import.meta.url), 'utf8');
 manifest.push({file, sha256:createHash('sha256').update(content).digest('hex')});
 // New Supabase projects may not provide legacy default table grants.
 // Baseline RLS restricts these operations; 0009 subsequently revokes snapshot writes.
 if (file === '202609110009_exam_contract_closure.sql') {
  const original = "WHERE n.nspname='public' AND p.prosecdef LOOP";
  if (content.split(original).length !== 2) throw new Error('0009 adapter anchor changed');
  content = content.replace(original, "WHERE n.nspname='public' AND p.prosecdef AND p.oid <> 'public.rls_auto_enable()'::regprocedure LOOP");
  manifest.at(-1).adapter = 'Exclude only preflight-validated rls_auto_enable() from exam definer loop; revoke its API grants separately';
  manifest.at(-1).renderedSha256 = createHash('sha256').update(content).digest('hex');
  sql += '\nGRANT USAGE ON SCHEMA public TO anon, authenticated;\n';
  sql += 'GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO anon, authenticated;\n';
 }
 sql += `\n-- SOURCE: ${file}\n${content}\n`;
}
sql += `
NOTIFY pgrst, 'reload schema';
COMMIT;
SELECT 'KSC installation complete' AS status;
`;
const out = new URL('../docs/ksc/setup/', import.meta.url);
await mkdir(out, {recursive:true});
await writeFile(new URL('KSC-INSTALL.sql', out), sql);
await writeFile(new URL('KSC-INSTALL-DRAFT.sql', out), '-- Superseded. Use the tested KSC-INSTALL.sql in this folder.\n');
await writeFile(new URL('manifest.json', out), JSON.stringify(manifest,null,2)+'\n');
console.log('Generated KSC-only installation and SHA-256 source manifest.');
