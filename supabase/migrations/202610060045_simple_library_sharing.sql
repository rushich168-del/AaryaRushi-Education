BEGIN;
DO $$ BEGIN
 IF to_regclass('public.organizations') IS NOT NULL OR to_regclass('ksc_private.library_archives') IS NULL THEN RAISE EXCEPTION 'Expected KSC common-library baseline'; END IF;
END $$;
ALTER TABLE ksc_private.library_versions ADD COLUMN summary jsonb;
CREATE FUNCTION ksc_private.library_summary(p jsonb) RETURNS jsonb
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT jsonb_build_object('title',p->>'title','version',coalesce(p->>'version','1'),'question_count',jsonb_array_length(p->'questions'),
 'duration',p->>'duration','marks',p->>'marks','negative',p->>'negative',
 'subjects',(SELECT jsonb_agg(subject ORDER BY first) FROM (SELECT coalesce(q->>'subject','General / mixed subjects') subject,min(pos) first
 FROM jsonb_array_elements(p->'questions') WITH ORDINALITY a(q,pos) GROUP BY coalesce(q->>'subject','General / mixed subjects')) x))
$$;
CREATE FUNCTION ksc_private.set_library_summary() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN NEW.summary:=ksc_private.library_summary(NEW.paper);RETURN NEW;END $$;
REVOKE ALL ON FUNCTION ksc_private.library_summary(jsonb),ksc_private.set_library_summary() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER library_summary_insert BEFORE INSERT ON ksc_private.library_versions FOR EACH ROW EXECUTE FUNCTION ksc_private.set_library_summary();
UPDATE ksc_private.library_versions SET summary=ksc_private.library_summary(paper);
ALTER TABLE ksc_private.library_versions ALTER COLUMN summary SET NOT NULL;
CREATE OR REPLACE FUNCTION public.ksc_exam_library_list() RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER
SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT coalesce(jsonb_agg(jsonb_build_object('id',v.id,'exam_id',v.exam_id,'exam_name',e.name,'level_id',v.level_id,
 'source_id',v.request_id,'title',v.summary->>'title','version',v.summary->>'version','question_count',(v.summary->>'question_count')::integer,
 'duration',(v.summary->>'duration')::integer,'marks',(v.summary->>'marks')::numeric,'negative',(v.summary->>'negative')::numeric,
 'subjects',v.summary->'subjects',
 'created_at',v.created_at,'can_delete',public.ksc_is_admin() OR (v.actor=auth.uid() AND EXISTS(SELECT 1 FROM public.ksc_staff_access s JOIN public.ksc_creator_exams ce ON ce.user_id=s.user_id WHERE s.user_id=auth.uid() AND s.role='creator' AND ce.exam_id=v.exam_id)),'can_bring_back',public.ksc_is_admin() OR (v.actor=auth.uid() AND EXISTS(SELECT 1 FROM public.ksc_staff_access s JOIN public.ksc_creator_exams ce ON ce.user_id=s.user_id WHERE s.user_id=auth.uid() AND s.role='creator' AND ce.exam_id=v.exam_id))) ORDER BY v.created_at DESC),'[]')
 FROM ksc_private.library_versions v JOIN public.exams e ON e.id=v.exam_id WHERE EXISTS(SELECT 1 FROM public.ksc_staff_access s WHERE s.user_id=auth.uid() AND s.role IN('admin','teacher','creator') AND s.state='active' AND NOT s.password_change_required) AND NOT EXISTS(SELECT 1 FROM ksc_private.library_archives a WHERE a.version_id=v.id)
$$;
-- Image-heavy validated ready versions need a longer function-local REST timeout.
-- Other API operations and role-wide timeouts remain unchanged.
ALTER FUNCTION public.ksc_library_add_ready(uuid,uuid,uuid,jsonb) SET statement_timeout TO '120s';
CREATE FUNCTION public.ksc_library_bring_back(p_version uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp SET statement_timeout TO '120s' AS $$
DECLARE v ksc_private.library_versions;
BEGIN
 PERFORM public.ksc_library_archive_ready(p_version);
 SELECT * INTO v FROM ksc_private.library_versions WHERE id=p_version;
 RETURN jsonb_build_object('paper',v.paper,'exam_id',v.exam_id,'version_id',v.id);
END $$;
CREATE FUNCTION public.ksc_library_restore_ready(p_version uuid) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 -- Reuse the existing owner/admin/program check and version lock before restore.
 PERFORM public.ksc_library_archive_ready(p_version);
 DELETE FROM ksc_private.library_archives WHERE version_id=p_version;
 RETURN p_version;
END $$;
REVOKE ALL ON FUNCTION public.ksc_library_bring_back(uuid),public.ksc_library_restore_ready(uuid) FROM PUBLIC,anon,service_role;
GRANT EXECUTE ON FUNCTION public.ksc_library_bring_back(uuid),public.ksc_library_restore_ready(uuid) TO authenticated;
NOTIFY pgrst,'reload config';
NOTIFY pgrst,'reload schema';
COMMIT;
