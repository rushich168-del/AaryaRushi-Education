-- Preserve each student's saved preparation tracks independently of course enrollment.
BEGIN;
DO $$ BEGIN IF to_regclass('public.organizations') IS NOT NULL OR to_regclass('public.ksc_student_program_preferences') IS NULL THEN RAISE EXCEPTION 'KSC program baseline required'; END IF; END $$;
CREATE TABLE public.ksc_student_program_memberships (
 user_id uuid NOT NULL REFERENCES public.student_profiles(id) ON DELETE CASCADE,
 level_id uuid NOT NULL REFERENCES public.exam_levels(id) ON DELETE RESTRICT,
 created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(user_id,level_id)
);
ALTER TABLE public.ksc_student_program_memberships ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.ksc_student_program_memberships FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON public.ksc_student_program_memberships TO authenticated;
CREATE POLICY own_or_admin_memberships ON public.ksc_student_program_memberships FOR SELECT TO authenticated USING(user_id=auth.uid() OR public.ksc_is_admin());
INSERT INTO public.ksc_student_program_memberships(user_id,level_id) SELECT user_id,level_id FROM public.ksc_student_program_preferences ON CONFLICT DO NOTHING;

CREATE OR REPLACE FUNCTION public.ksc_student_program_state() RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
 SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE uid uuid:=ksc_private.require_student_program_user(); selected jsonb; enrolled jsonb; suggested uuid; hint text; memberships jsonb;
BEGIN
 SELECT jsonb_build_object('exam_id',e.id,'level_id',l.id,'program',e.name,'track',CASE WHEN l.name='Default' THEN 'General preparation' ELSE l.name END,
 'version',p.version,'available',e.is_active AND l.is_active AND coalesce(c.is_active,true)) INTO selected
 FROM public.ksc_student_program_preferences p JOIN public.exam_levels l ON l.id=p.level_id JOIN public.exams e ON e.id=l.exam_id
 LEFT JOIN public.program_categories c ON c.id=e.category_id WHERE p.user_id=uid;
 SELECT coalesce(jsonb_agg(jsonb_build_object('exam_id',q.exam_id,'level_id',q.level_id,'program',q.program,'track',q.track) ORDER BY q.program,q.track),'[]') INTO enrolled
 FROM (SELECT DISTINCT e.id exam_id,l.id level_id,e.name program,CASE WHEN l.name='Default' THEN 'General preparation' ELSE l.name END track
 FROM public.ksc_enrollments n JOIN public.ksc_batches b ON b.id=n.batch_id JOIN public.ksc_course_tracks ct ON ct.course_id=b.course_id
 JOIN public.exam_levels l ON l.id=ct.level_id JOIN public.exams e ON e.id=l.exam_id LEFT JOIN public.program_categories c ON c.id=e.category_id
 WHERE n.student_id=uid AND e.is_active AND l.is_active AND coalesce(c.is_active,true)) q;
 IF selected IS NULL THEN
  SELECT raw_user_meta_data->>'ksc_requested_level' INTO hint FROM auth.users WHERE id=uid;
  IF hint ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
   SELECT l.id INTO suggested FROM public.exam_levels l JOIN public.exams e ON e.id=l.exam_id JOIN public.ksc_signup_programs s ON s.exam_id=e.id
   LEFT JOIN public.program_categories c ON c.id=e.category_id
   WHERE l.id=hint::uuid AND s.enabled AND e.is_active AND l.is_active AND coalesce(c.is_active,true);
  END IF;
  IF suggested IS NULL AND jsonb_array_length(enrolled)=1 THEN suggested:=(enrolled->0->>'level_id')::uuid; END IF;
 END IF;
 SELECT coalesce(jsonb_agg(jsonb_build_object('exam_id',e.id,'level_id',l.id,'program',e.name,'track',CASE WHEN l.name='Default' THEN 'General preparation' ELSE l.name END,
 'available',e.is_active AND l.is_active AND coalesce(c.is_active,true)) ORDER BY e.name,l.name),'[]') INTO memberships
 FROM public.ksc_student_program_memberships m JOIN public.exam_levels l ON l.id=m.level_id JOIN public.exams e ON e.id=l.exam_id
 LEFT JOIN public.program_categories c ON c.id=e.category_id WHERE m.user_id=uid;
 RETURN jsonb_build_object('selection',selected,'enrolled',enrolled,'memberships',memberships,'suggested_level_id',suggested);
END $$;

CREATE OR REPLACE FUNCTION public.ksc_set_student_program(p_level uuid,p_version bigint,p_user uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
 SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE uid uuid:=ksc_private.require_student_program_user(); previous public.ksc_student_program_preferences; exam uuid; BEGIN
 IF p_user IS DISTINCT FROM uid THEN RAISE EXCEPTION 'Student session changed. Sign in again.'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(uid::text,38));
 SELECT * INTO previous FROM public.ksc_student_program_preferences WHERE user_id=uid FOR UPDATE;
 IF p_version IS NULL OR p_version<>coalesce(previous.version,0) THEN RAISE EXCEPTION 'Program selection changed. Refresh and try again.'; END IF;
 SELECT e.id INTO exam FROM public.exam_levels l JOIN public.exams e ON e.id=l.exam_id LEFT JOIN public.program_categories c ON c.id=e.category_id
 WHERE l.id=p_level AND l.is_active AND e.is_active AND coalesce(c.is_active,true) FOR SHARE OF l,e;
 IF exam IS NULL THEN RAISE EXCEPTION 'This program track is unavailable'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.ksc_signup_programs WHERE exam_id=exam AND enabled)
 AND previous.level_id IS DISTINCT FROM p_level AND NOT EXISTS(SELECT 1 FROM public.ksc_student_program_memberships WHERE user_id=uid AND level_id=p_level) AND NOT EXISTS(
 SELECT 1 FROM public.ksc_enrollments n JOIN public.ksc_batches b ON b.id=n.batch_id JOIN public.ksc_course_tracks ct ON ct.course_id=b.course_id
 WHERE n.student_id=uid AND ct.level_id=p_level) THEN RAISE EXCEPTION 'This program is not open for signup'; END IF;
 IF previous.user_id IS NULL THEN INSERT INTO public.ksc_student_program_preferences(user_id,level_id) VALUES(uid,p_level);
 ELSIF previous.level_id IS DISTINCT FROM p_level THEN UPDATE public.ksc_student_program_preferences SET level_id=p_level,version=version+1,updated_at=now() WHERE user_id=uid;
 END IF;
 INSERT INTO public.ksc_student_program_memberships(user_id,level_id) VALUES(uid,p_level) ON CONFLICT DO NOTHING;
 RETURN public.ksc_student_program_state();
END $$;


NOTIFY pgrst, 'reload schema';
COMMIT;
