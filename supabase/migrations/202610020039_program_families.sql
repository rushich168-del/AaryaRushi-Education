-- User-confirmed programme expansion. Preserve old IDs, tests, enrollments and results.
BEGIN;
DO $$ BEGIN IF to_regclass('public.organizations') IS NOT NULL OR to_regclass('public.ksc_student_program_preferences') IS NULL THEN RAISE EXCEPTION 'Verified KSC baseline38 required'; END IF; END $$;
ALTER TABLE public.exam_levels ADD COLUMN is_signup_enabled boolean NOT NULL DEFAULT true;
INSERT INTO public.program_categories(name,slug,display_order) VALUES
 ('School Foundation','school-foundation',2),('IIT / NEET','iit-neet',3),('Competitive Exam Preparation','competitive-preparation',4)
 ON CONFLICT(slug) DO NOTHING;
DO $$ DECLARE r record; eid uuid; subjects text[]; label text; sid uuid; lid uuid; BEGIN
 FOR r IN SELECT * FROM (VALUES
 ('school-foundation','cbse-school-foundation','CBSE School Foundation',ARRAY['Class VI','Class VII','Class VIII','Class IX','Class X'],ARRAY['Mathematics','Science','English']),
 ('school-foundation','icse-school-foundation','ICSE School Foundation',ARRAY['Class VI','Class VII','Class VIII','Class IX','Class X'],ARRAY['Mathematics','Science','English']),
 ('school-foundation','state-board-school-foundation','State Board School Foundation',ARRAY['Class VI','Class VII','Class VIII','Class IX','Class X'],ARRAY['Mathematics','Science','English']),
 ('iit-neet','iit-neet-foundation','IIT / NEET Foundation',ARRAY['Class VI','Class VII','Class VIII','Class IX','Class X'],ARRAY['Mathematics','Physics','Chemistry','Biology']),
 ('iit-neet','jee-main','JEE Main',ARRAY['Class XI','Class XII'],ARRAY['Mathematics','Physics','Chemistry']),
 ('iit-neet','neet','NEET',ARRAY['Class XI','Class XII'],ARRAY['Physics','Chemistry','Biology'])
 ) AS seed(category,slug,name,tracks,subjects) LOOP
 SELECT id INTO eid FROM public.exams WHERE slug=r.slug;
 IF eid IS NULL THEN INSERT INTO public.exams(name,slug,category_id) VALUES(r.name,r.slug,(SELECT id FROM public.program_categories WHERE slug=r.category)) RETURNING id INTO eid;
 ELSE UPDATE public.exams SET category_id=(SELECT id FROM public.program_categories WHERE slug=r.category) WHERE id=eid; END IF;
 INSERT INTO public.exam_levels(exam_id,name,display_order) SELECT eid,t.name,t.ord::integer FROM unnest(r.tracks) WITH ORDINALITY t(name,ord) ON CONFLICT(exam_id,name) DO NOTHING;
 FOREACH label IN ARRAY r.subjects LOOP
 SELECT id INTO sid FROM public.exam_subjects WHERE exam_id=eid AND lower(name)=lower(label) ORDER BY created_at,id LIMIT 1;
 IF sid IS NULL THEN INSERT INTO public.exam_subjects(exam_id,name) VALUES(eid,label) RETURNING id INTO sid; END IF;
 FOR lid IN SELECT id FROM public.exam_levels WHERE exam_id=eid AND name=ANY(r.tracks) LOOP
 IF NOT EXISTS(SELECT 1 FROM public.syllabi WHERE level_id=lid AND subject_id=sid) THEN
 INSERT INTO public.syllabi(exam_id,level_id,subject_id,name,description,status) VALUES(eid,lid,sid,label||' preparation','KSC curriculum workspace; chapters and resources require institute review.','DRAFT'); END IF;
 END LOOP;
 END LOOP;
 END LOOP;
END $$;
-- Historical UG/Default tracks stay active for enrolled students and saved history.
UPDATE public.exam_levels l SET is_signup_enabled=false FROM public.exams e WHERE l.exam_id=e.id AND e.slug IN ('jee-main','neet') AND l.name IN ('Default','UG');
UPDATE public.exams SET category_id=(SELECT id FROM public.program_categories WHERE slug='competitive-preparation') WHERE slug IN ('dsc','group-ii','si-constable');
INSERT INTO public.ksc_signup_programs(exam_id,enabled) SELECT id,true FROM public.exams WHERE slug IN ('cbse-school-foundation','icse-school-foundation','state-board-school-foundation','iit-neet-foundation','jee-main','neet','dsc','group-ii','si-constable') AND is_active ON CONFLICT(exam_id) DO UPDATE SET enabled=excluded.enabled;
CREATE OR REPLACE FUNCTION public.ksc_signup_catalogue() RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER
 SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT jsonb_build_object('programs',coalesce(jsonb_agg(jsonb_build_object(
 'id',e.id,'slug',e.slug,'name',e.name,'category_id',c.id,'category',coalesce(c.name,'Other programs'),
 'tracks',(SELECT jsonb_agg(jsonb_build_object('id',l.id,'name',CASE WHEN l.name='Default' THEN 'General preparation' ELSE l.name END) ORDER BY l.display_order,l.name,l.id)
 FROM public.exam_levels l WHERE l.exam_id=e.id AND l.is_active AND l.is_signup_enabled)) ORDER BY coalesce(c.display_order,999),e.name,e.id),'[]'))
 FROM public.exams e JOIN public.ksc_signup_programs s ON s.exam_id=e.id AND s.enabled
 LEFT JOIN public.program_categories c ON c.id=e.category_id
 WHERE e.is_active AND (c.id IS NULL OR c.is_active)
 AND EXISTS(SELECT 1 FROM public.exam_levels l WHERE l.exam_id=e.id AND l.is_active AND l.is_signup_enabled);
$$;
CREATE OR REPLACE FUNCTION public.ksc_student_program_state() RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
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
   WHERE l.id=hint::uuid AND s.enabled AND e.is_active AND l.is_active AND l.is_signup_enabled AND coalesce(c.is_active,true);
  END IF;
  IF suggested IS NULL AND jsonb_array_length(enrolled)=1 THEN suggested:=(enrolled->0->>'level_id')::uuid; END IF;
 END IF;
 RETURN jsonb_build_object('selection',selected,'enrolled',enrolled,'suggested_level_id',suggested);
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
 IF NOT EXISTS(SELECT 1 FROM public.ksc_signup_programs WHERE exam_id=exam AND enabled AND EXISTS(SELECT 1 FROM public.exam_levels WHERE id=p_level AND is_signup_enabled))
 AND previous.level_id IS DISTINCT FROM p_level AND NOT EXISTS(
 SELECT 1 FROM public.ksc_enrollments n JOIN public.ksc_batches b ON b.id=n.batch_id JOIN public.ksc_course_tracks ct ON ct.course_id=b.course_id
 WHERE n.student_id=uid AND ct.level_id=p_level) THEN RAISE EXCEPTION 'This program is not open for signup'; END IF;
 IF previous.user_id IS NULL THEN INSERT INTO public.ksc_student_program_preferences(user_id,level_id) VALUES(uid,p_level);
 ELSIF previous.level_id IS DISTINCT FROM p_level THEN UPDATE public.ksc_student_program_preferences SET level_id=p_level,version=version+1,updated_at=now() WHERE user_id=uid;
 END IF;
 RETURN public.ksc_student_program_state();
END $$;
CREATE OR REPLACE FUNCTION public.ksc_signup_program_settings() RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
 SET search_path=pg_catalog,public,pg_temp AS $$ BEGIN
 IF NOT public.ksc_is_admin() THEN RAISE EXCEPTION 'Administrator required'; END IF;
 RETURN (SELECT coalesce(jsonb_agg(jsonb_build_object('id',e.id,'name',e.name,'enabled',coalesce(s.enabled,false),'active',e.is_active AND coalesce(c.is_active,true),
 'tracks',(SELECT count(*) FROM public.exam_levels l WHERE l.exam_id=e.id AND l.is_active AND l.is_signup_enabled)) ORDER BY e.name,e.id),'[]') FROM public.exams e LEFT JOIN public.ksc_signup_programs s ON s.exam_id=e.id LEFT JOIN public.program_categories c ON c.id=e.category_id);
END $$;
CREATE OR REPLACE FUNCTION public.ksc_set_signup_program(p_exam uuid,p_enabled boolean) RETURNS void LANGUAGE plpgsql SECURITY DEFINER
 SET search_path=pg_catalog,public,pg_temp AS $$ BEGIN
 IF NOT public.ksc_is_admin() THEN RAISE EXCEPTION 'Administrator required'; END IF;
 IF p_enabled IS NULL OR NOT EXISTS(SELECT 1 FROM public.exams WHERE id=p_exam) THEN RAISE EXCEPTION 'Valid program required'; END IF;
 IF p_enabled AND NOT EXISTS(SELECT 1 FROM public.exams e LEFT JOIN public.program_categories c ON c.id=e.category_id WHERE e.id=p_exam AND e.is_active AND coalesce(c.is_active,true)
 AND EXISTS(SELECT 1 FROM public.exam_levels l WHERE l.exam_id=e.id AND l.is_active AND l.is_signup_enabled)) THEN RAISE EXCEPTION 'An active program and track are required'; END IF;
 INSERT INTO public.ksc_signup_programs(exam_id,enabled) VALUES(p_exam,p_enabled) ON CONFLICT(exam_id) DO UPDATE SET enabled=excluded.enabled;
END $$;
NOTIFY pgrst,'reload schema';
COMMIT;
