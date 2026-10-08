-- KSC-only forward migration. Program preference is not enrollment or a test entitlement.
BEGIN;
DO $$ BEGIN
 IF to_regclass('public.organizations') IS NOT NULL OR to_regclass('public.ksc_creator_exams') IS NULL
 THEN RAISE EXCEPTION 'Verified KSC baseline through 0037 required'; END IF;
END $$;
CREATE TABLE public.ksc_signup_programs (
 exam_id uuid PRIMARY KEY REFERENCES public.exams(id) ON DELETE CASCADE,
 enabled boolean NOT NULL DEFAULT false
);
CREATE TABLE public.ksc_student_program_preferences (
 user_id uuid PRIMARY KEY REFERENCES public.student_profiles(id) ON DELETE CASCADE,
 level_id uuid NOT NULL REFERENCES public.exam_levels(id) ON DELETE RESTRICT,
 version bigint NOT NULL DEFAULT 1 CHECK(version>0),
 updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.ksc_signup_programs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ksc_student_program_preferences ENABLE ROW LEVEL SECURITY;
CREATE POLICY signup_settings_admin_read ON public.ksc_signup_programs FOR SELECT TO authenticated USING(public.ksc_is_admin());
CREATE POLICY student_program_own_read ON public.ksc_student_program_preferences FOR SELECT TO authenticated USING(user_id=auth.uid() AND NOT EXISTS(SELECT 1 FROM public.ksc_staff_access s WHERE s.user_id=auth.uid()));
REVOKE ALL ON public.ksc_signup_programs,public.ksc_student_program_preferences FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON public.ksc_signup_programs,public.ksc_student_program_preferences TO authenticated;

CREATE FUNCTION public.ksc_signup_catalogue() RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER
 SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT jsonb_build_object('programs',coalesce(jsonb_agg(jsonb_build_object(
 'id',e.id,'slug',e.slug,'name',e.name,'category_id',c.id,'category',coalesce(c.name,'Other programs'),
 'tracks',(SELECT jsonb_agg(jsonb_build_object('id',l.id,'name',CASE WHEN l.name='Default' THEN 'General preparation' ELSE l.name END) ORDER BY l.display_order,l.name,l.id)
 FROM public.exam_levels l WHERE l.exam_id=e.id AND l.is_active)) ORDER BY coalesce(c.display_order,999),e.name,e.id),'[]'))
 FROM public.exams e JOIN public.ksc_signup_programs s ON s.exam_id=e.id AND s.enabled
 LEFT JOIN public.program_categories c ON c.id=e.category_id
 WHERE e.is_active AND (c.id IS NULL OR c.is_active)
 AND EXISTS(SELECT 1 FROM public.exam_levels l WHERE l.exam_id=e.id AND l.is_active);
$$;

CREATE FUNCTION ksc_private.require_student_program_user() RETURNS uuid LANGUAGE plpgsql STABLE SECURITY DEFINER
 SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE uid uuid:=auth.uid(); BEGIN
 IF uid IS NULL OR NOT EXISTS(SELECT 1 FROM public.student_profiles WHERE id=uid)
 OR EXISTS(SELECT 1 FROM public.ksc_staff_access WHERE user_id=uid)
 OR EXISTS(SELECT 1 FROM public.teacher_profiles WHERE id=uid)
 THEN RAISE EXCEPTION 'Student account required'; END IF;
 RETURN uid;
END $$;

CREATE FUNCTION public.ksc_student_program_state() RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
 SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE uid uuid:=ksc_private.require_student_program_user(); selected jsonb; enrolled jsonb; suggested uuid; hint text;
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
 RETURN jsonb_build_object('selection',selected,'enrolled',enrolled,'suggested_level_id',suggested);
END $$;

CREATE FUNCTION public.ksc_set_student_program(p_level uuid,p_version bigint,p_user uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
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
 AND previous.level_id IS DISTINCT FROM p_level AND NOT EXISTS(
 SELECT 1 FROM public.ksc_enrollments n JOIN public.ksc_batches b ON b.id=n.batch_id JOIN public.ksc_course_tracks ct ON ct.course_id=b.course_id
 WHERE n.student_id=uid AND ct.level_id=p_level) THEN RAISE EXCEPTION 'This program is not open for signup'; END IF;
 IF previous.user_id IS NULL THEN INSERT INTO public.ksc_student_program_preferences(user_id,level_id) VALUES(uid,p_level);
 ELSIF previous.level_id IS DISTINCT FROM p_level THEN UPDATE public.ksc_student_program_preferences SET level_id=p_level,version=version+1,updated_at=now() WHERE user_id=uid;
 END IF;
 RETURN public.ksc_student_program_state();
END $$;

CREATE FUNCTION public.ksc_signup_program_settings() RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
 SET search_path=pg_catalog,public,pg_temp AS $$ BEGIN
 IF NOT public.ksc_is_admin() THEN RAISE EXCEPTION 'Administrator required'; END IF;
 RETURN (SELECT coalesce(jsonb_agg(jsonb_build_object('id',e.id,'name',e.name,'enabled',coalesce(s.enabled,false),'active',e.is_active AND coalesce(c.is_active,true),
 'tracks',(SELECT count(*) FROM public.exam_levels l WHERE l.exam_id=e.id AND l.is_active)) ORDER BY e.name,e.id),'[]') FROM public.exams e LEFT JOIN public.ksc_signup_programs s ON s.exam_id=e.id LEFT JOIN public.program_categories c ON c.id=e.category_id);
END $$;
CREATE FUNCTION public.ksc_set_signup_program(p_exam uuid,p_enabled boolean) RETURNS void LANGUAGE plpgsql SECURITY DEFINER
 SET search_path=pg_catalog,public,pg_temp AS $$ BEGIN
 IF NOT public.ksc_is_admin() THEN RAISE EXCEPTION 'Administrator required'; END IF;
 IF p_enabled IS NULL OR NOT EXISTS(SELECT 1 FROM public.exams WHERE id=p_exam) THEN RAISE EXCEPTION 'Valid program required'; END IF;
 IF p_enabled AND NOT EXISTS(SELECT 1 FROM public.exams e LEFT JOIN public.program_categories c ON c.id=e.category_id WHERE e.id=p_exam AND e.is_active AND coalesce(c.is_active,true)
 AND EXISTS(SELECT 1 FROM public.exam_levels l WHERE l.exam_id=e.id AND l.is_active)) THEN RAISE EXCEPTION 'An active program and track are required'; END IF;
 INSERT INTO public.ksc_signup_programs(exam_id,enabled) VALUES(p_exam,p_enabled) ON CONFLICT(exam_id) DO UPDATE SET enabled=excluded.enabled;
END $$;
REVOKE ALL ON FUNCTION ksc_private.require_student_program_user() FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.ksc_signup_catalogue(),public.ksc_student_program_state(),public.ksc_set_student_program(uuid,bigint,uuid),public.ksc_signup_program_settings(),public.ksc_set_signup_program(uuid,boolean) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.ksc_signup_catalogue() TO anon,authenticated;
GRANT EXECUTE ON FUNCTION public.ksc_student_program_state(),public.ksc_set_student_program(uuid,bigint,uuid),public.ksc_signup_program_settings(),public.ksc_set_signup_program(uuid,boolean) TO authenticated;
COMMIT;
