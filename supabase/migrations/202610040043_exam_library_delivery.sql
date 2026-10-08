-- Additive library publication. Apply only to verified KSC after local acceptance.
BEGIN;
DO $$ BEGIN
 IF to_regclass('public.organizations') IS NOT NULL OR to_regclass('public.ksc_creator_exams') IS NULL
 THEN RAISE EXCEPTION 'Expected isolated KSC creator and staff baseline'; END IF;
END $$;
-- Preserve fractional DSC marking end to end; existing integer values stay exact.
ALTER TABLE public.exam_pattern_sections ALTER COLUMN marks_per_question TYPE numeric;
ALTER TABLE public.exam_patterns ALTER COLUMN total_marks TYPE numeric;
ALTER TABLE public.tests ALTER COLUMN total_marks TYPE numeric;
ALTER TABLE public.test_question_snapshots ALTER COLUMN marks TYPE numeric;

CREATE TABLE ksc_private.library_versions(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), actor uuid NOT NULL REFERENCES auth.users(id),
 request_id uuid NOT NULL, exam_id uuid NOT NULL REFERENCES public.exams(id), level_id uuid REFERENCES public.exam_levels(id),
 paper jsonb NOT NULL, fingerprint text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(actor,request_id)
);
CREATE TABLE ksc_private.library_deliveries(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), version_id uuid NOT NULL REFERENCES ksc_private.library_versions(id),
 actor uuid NOT NULL REFERENCES auth.users(id), request_id uuid NOT NULL, course_id uuid NOT NULL REFERENCES public.ksc_courses(id),
 batches uuid[] NOT NULL, test_id uuid UNIQUE REFERENCES public.tests(id), settings jsonb NOT NULL,
 opens_at timestamptz NOT NULL, closes_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(actor,request_id)
);
REVOKE ALL ON ksc_private.library_versions,ksc_private.library_deliveries FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION ksc_private.library_exam_access(p_exam uuid,p_level uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT public.ksc_is_admin() OR EXISTS(
 SELECT 1 FROM public.ksc_staff_access s WHERE s.user_id=auth.uid() AND s.state='active' AND NOT s.password_change_required
 AND ((s.role='creator' AND EXISTS(SELECT 1 FROM public.ksc_creator_exams a WHERE a.user_id=s.user_id AND a.exam_id=p_exam))
 OR (s.role='teacher' AND EXISTS(SELECT 1 FROM public.ksc_course_tracks ct JOIN public.exam_levels l ON l.id=ct.level_id
 WHERE l.exam_id=p_exam AND (p_level IS NULL OR l.id=p_level) AND public.ksc_manages_course(ct.course_id)))))
$$;

CREATE FUNCTION public.ksc_library_add_ready(p_request uuid,p_exam uuid,p_level uuid,p_paper jsonb) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE q jsonb; b jsonb; body jsonb; n integer:=0; existing ksc_private.library_versions;
BEGIN
 PERFORM 1 FROM public.ksc_staff_access WHERE user_id=auth.uid() AND role IN('creator','admin') AND state='active' AND NOT password_change_required FOR SHARE;
 IF NOT FOUND OR NOT ksc_private.library_exam_access(p_exam,p_level) THEN RAISE EXCEPTION 'Assigned creator exam or administrator access required'; END IF;
 IF NOT public.ksc_is_admin() THEN PERFORM 1 FROM public.ksc_creator_exams WHERE user_id=auth.uid() AND exam_id=p_exam FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Exam assignment changed'; END IF; END IF;
 IF p_request IS NULL OR NOT EXISTS(SELECT 1 FROM public.exams WHERE id=p_exam)
 OR (p_level IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.exam_levels WHERE id=p_level AND exam_id=p_exam)) THEN RAISE EXCEPTION 'Choose a valid program and track'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(auth.uid()::text||p_request::text,43001));
 SELECT * INTO existing FROM ksc_private.library_versions WHERE actor=auth.uid() AND request_id=p_request;
 IF FOUND THEN
  IF existing.exam_id IS DISTINCT FROM p_exam OR existing.level_id IS DISTINCT FROM p_level OR existing.fingerprint<>md5(p_paper::text)
  THEN RAISE EXCEPTION 'Ready version changed. Use a new version'; END IF;
  RETURN existing.id;
 END IF;
 IF p_paper->>'state' IS DISTINCT FROM 'ready' OR p_paper->>'confirmed' IS DISTINCT FROM 'true'
 OR coalesce(btrim(p_paper->>'title'),'')='' OR length(p_paper->>'title')>200
 OR jsonb_typeof(p_paper->'questions') IS DISTINCT FROM 'array' OR jsonb_array_length(p_paper->'questions') NOT BETWEEN 1 AND 500
 OR coalesce((p_paper->>'duration')::integer,0) NOT BETWEEN 1 AND 600
 OR coalesce((p_paper->>'marks')::numeric,0) NOT BETWEEN 0.01 AND 100
 OR (p_paper->>'negative')::numeric IS NULL OR (p_paper->>'negative')::numeric<0 OR (p_paper->>'negative')::numeric>(p_paper->>'marks')::numeric
 OR octet_length(p_paper::text)>100000000
 THEN RAISE EXCEPTION 'Complete paper checks, answers and valid test settings before adding ready'; END IF;
 IF p_paper->>'expectedCount' IS NOT NULL AND (p_paper->>'expectedCount')::integer<>jsonb_array_length(p_paper->'questions') THEN RAISE EXCEPTION 'Question count does not match source'; END IF;
 IF p_paper->>'exam'='DSC-SGT' AND (p_paper->>'syllabusReference' IS DISTINCT FROM 'ap' OR p_paper->>'testFormat' NOT IN('subject','dt','wt','grand') OR p_paper->>'testFormat' IS NULL OR
 (p_paper->>'testFormat' IN('dt','wt') AND (jsonb_array_length(p_paper->'questions')<>100 OR (p_paper->>'marks')::numeric<>1)) OR
 (p_paper->>'testFormat'='grand' AND (jsonb_array_length(p_paper->'questions')<>160 OR (p_paper->>'marks')::numeric<>0.5))) THEN RAISE EXCEPTION 'Check AP DSC format counts and marks'; END IF;
 FOR q IN SELECT value FROM jsonb_array_elements(p_paper->'questions') LOOP
  n:=n+1;
  IF octet_length(q::text)>4000000 OR length(coalesce(q->>'subject',''))>120 OR (q->>'number')::integer IS DISTINCT FROM n OR jsonb_typeof(q->'options') IS DISTINCT FROM 'array' OR jsonb_array_length(q->'options')<>4
  OR EXISTS(SELECT 1 FROM jsonb_array_elements(q->'options') o WHERE jsonb_typeof(o)<>'string' OR btrim(o#>>'{}')='')
  OR (q->>'correct')::integer IS NULL OR (q->>'correct')::integer NOT BETWEEN 0 AND 3 OR (q->>'correct')::numeric<>(q->>'correct')::integer OR coalesce(btrim(q->>'content'),'')=''
  OR q->>'markedForReview'='true' OR ((q->>'edited'='true' OR q->>'answerChanged'='true' OR EXISTS(
    SELECT 1 FROM jsonb_array_elements_text(coalesce(q->'warnings','[]')) w WHERE w !~ 'NO_TELUGU_REGION|ENGLISH_STEM_MISSING|DUPLICATE_OPTION_TEXT|EMPTY_OPTION_TEXT|NOTATION|NO_ANSWER_KEY_ENTRY')) AND q->>'reviewConfirmed' IS DISTINCT FROM 'true')
  THEN RAISE EXCEPTION 'Question % needs correction, answer or creator check',n; END IF;
  IF left(q->>'content',15)='KSC_PRINTED_V1:' THEN
   body:=substring(q->>'content' FROM 16)::jsonb;
   IF jsonb_typeof(body->'blocks') IS DISTINCT FROM 'array' OR jsonb_array_length(body->'blocks') NOT BETWEEN 1 AND 300 THEN RAISE EXCEPTION 'Invalid printed content'; END IF;
   FOR b IN SELECT value FROM jsonb_array_elements(body->'blocks') LOOP
    IF b->>'type'='image' THEN
     IF coalesce(b->>'src','') !~ '^data:image/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$' THEN RAISE EXCEPTION 'Invalid image'; END IF;
    ELSIF b->>'type'='text' THEN
     IF jsonb_typeof(b->'text') IS DISTINCT FROM 'string' THEN RAISE EXCEPTION 'Invalid text'; END IF;
    ELSE RAISE EXCEPTION 'Unsupported printed content'; END IF;
   END LOOP;
  END IF;
 END LOOP;
 INSERT INTO ksc_private.library_versions(actor,request_id,exam_id,level_id,paper,fingerprint)
 VALUES(auth.uid(),p_request,p_exam,p_level,p_paper,md5(p_paper::text)) RETURNING id INTO p_request;
 RETURN p_request;
END $$;

CREATE FUNCTION public.ksc_exam_library_list() RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER
SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT coalesce(jsonb_agg(jsonb_build_object('id',v.id,'exam_id',v.exam_id,'exam_name',e.name,'level_id',v.level_id,
 'title',v.paper->>'title','version',coalesce(v.paper->>'version','1'),'question_count',jsonb_array_length(v.paper->'questions'),
 'duration',(v.paper->>'duration')::integer,'marks',(v.paper->>'marks')::numeric,'negative',(v.paper->>'negative')::numeric,
 'subjects',(SELECT jsonb_agg(x.subject ORDER BY x.first) FROM (SELECT coalesce(q->>'subject','General / mixed subjects') subject,min(pos) first
 FROM jsonb_array_elements(v.paper->'questions') WITH ORDINALITY a(q,pos) GROUP BY coalesce(q->>'subject','General / mixed subjects')) x),
 'created_at',v.created_at) ORDER BY v.created_at DESC),'[]')
 FROM ksc_private.library_versions v JOIN public.exams e ON e.id=v.exam_id WHERE ksc_private.library_exam_access(v.exam_id,v.level_id)
$$;

CREATE FUNCTION public.ksc_library_audiences(p_version uuid) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER
SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT coalesce(jsonb_agg(jsonb_build_object('id',c.id,'name',c.name,'tracks',(
 SELECT jsonb_agg(jsonb_build_object('id',l.id,'name',l.name) ORDER BY l.name) FROM public.ksc_course_tracks ct JOIN public.exam_levels l ON l.id=ct.level_id
 WHERE ct.course_id=c.id AND l.exam_id=v.exam_id AND (v.level_id IS NULL OR l.id=v.level_id)), 'batches',(
 SELECT coalesce(jsonb_agg(jsonb_build_object('id',b.id,'name',b.name,'students',(SELECT count(*) FROM public.ksc_enrollments en WHERE en.batch_id=b.id)) ORDER BY b.name),'[]')
 FROM public.ksc_batches b WHERE b.course_id=c.id AND public.ksc_manages_batch(b.id))) ORDER BY c.name),'[]')
 FROM public.ksc_courses c JOIN ksc_private.library_versions v ON v.id=p_version
 WHERE public.ksc_manages_course(c.id) AND EXISTS(SELECT 1 FROM public.ksc_course_tracks ct JOIN public.exam_levels l ON l.id=ct.level_id
 WHERE ct.course_id=c.id AND l.exam_id=v.exam_id AND (v.level_id IS NULL OR l.id=v.level_id))
$$;

CREATE FUNCTION public.ksc_teacher_publish_library(p_version uuid,p_course uuid,p_batches uuid[],p_settings jsonb,p_request uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE v ksc_private.library_versions; d ksc_private.library_deliveries; sorted uuid[]; batch uuid; q jsonb;
 pat uuid; sec uuid; subject uuid; bank jsonb; t jsonb; pos integer:=0; group_pos integer:=0; previous_subject text; current_subject text;
 opening timestamptz; closing timestamptz; delivery_level uuid;
BEGIN
 SELECT * INTO v FROM ksc_private.library_versions WHERE id=p_version FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Ready version unavailable'; END IF;
 delivery_level:=coalesce((p_settings->>'level_id')::uuid,v.level_id);
 IF delivery_level IS NULL OR (v.level_id IS NOT NULL AND delivery_level<>v.level_id) THEN RAISE EXCEPTION 'Choose a course track matching the ready version'; END IF;
 PERFORM ksc_private.require_author_course(p_course,jsonb_build_object('exam_id',v.exam_id,'level_id',delivery_level));
 SELECT array_agg(x ORDER BY x) INTO sorted FROM (SELECT DISTINCT unnest(p_batches) x) a;
 IF p_request IS NULL OR sorted IS NULL OR cardinality(sorted)>200 OR array_position(sorted,NULL) IS NOT NULL THEN RAISE EXCEPTION 'Select at least one assigned batch'; END IF;
 FOR batch IN SELECT unnest(sorted) LOOP
  PERFORM 1 FROM public.ksc_batches WHERE id=batch AND course_id=p_course FOR SHARE;
  IF NOT FOUND OR NOT public.ksc_manages_batch(batch) THEN RAISE EXCEPTION 'Assigned batch access required'; END IF;
  IF NOT public.ksc_is_admin() THEN PERFORM 1 FROM public.ksc_teacher_batches WHERE user_id=auth.uid() AND batch_id=batch FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Batch assignment changed'; END IF; END IF;
 END LOOP;
 PERFORM pg_advisory_xact_lock(hashtextextended(auth.uid()::text||p_request::text,43002));
 SELECT * INTO d FROM ksc_private.library_deliveries WHERE actor=auth.uid() AND request_id=p_request;
 IF FOUND THEN
  IF d.version_id<>p_version OR d.course_id<>p_course OR d.batches<>sorted OR d.settings IS DISTINCT FROM p_settings THEN RAISE EXCEPTION 'Publication request changed. Start a new publication'; END IF;
  RETURN jsonb_build_object('id',d.id,'test_id',d.test_id,'title',d.settings->>'title','opens_at',d.opens_at,'closes_at',d.closes_at);
 END IF;
 IF p_settings->>'review_policy' NOT IN('SUMMARY_ONLY','AFTER_SUBMISSION') OR p_settings->>'review_policy' IS NULL
 OR coalesce(btrim(p_settings->>'title'),'')='' OR length(p_settings->>'title')>200 THEN RAISE EXCEPTION 'Choose a test title and result release policy'; END IF;
 opening:=coalesce((p_settings->>'opens_at')::timestamptz,now());closing:=(p_settings->>'closes_at')::timestamptz;
 IF closing IS NOT NULL AND (closing<=opening OR closing<=now()) THEN RAISE EXCEPTION 'Closing time must follow opening time and be in the future'; END IF;
 INSERT INTO ksc_private.library_deliveries(version_id,actor,request_id,course_id,batches,settings,opens_at,closes_at)
 VALUES(v.id,auth.uid(),p_request,p_course,sorted,p_settings,opening,closing) RETURNING * INTO d;
 INSERT INTO ksc_private.staff_authoring_context VALUES(txid_current(),auth.uid());
 INSERT INTO public.exam_patterns(exam_id,level_id,name,total_duration_minutes,total_marks,status)
 VALUES(v.exam_id,delivery_level,p_settings->>'title',(v.paper->>'duration')::integer,jsonb_array_length(v.paper->'questions')*(v.paper->>'marks')::numeric,'ACTIVE') RETURNING id INTO pat;
 t:=public.ksc_create_test(jsonb_build_object('exam_id',v.exam_id,'pattern_id',pat,'name',p_settings->>'title','test_kind','MODEL','review_policy',p_settings->>'review_policy'));
 FOR q IN SELECT value FROM jsonb_array_elements(v.paper->'questions') LOOP
  current_subject:=coalesce(nullif(btrim(q->>'subject'),''),'General / mixed subjects');
  IF previous_subject IS DISTINCT FROM current_subject THEN
   SELECT id INTO subject FROM public.exam_subjects WHERE exam_id=v.exam_id AND name=current_subject ORDER BY id LIMIT 1;
   IF subject IS NULL THEN INSERT INTO public.exam_subjects(exam_id,name) VALUES(v.exam_id,current_subject) RETURNING id INTO subject; END IF;
   INSERT INTO public.exam_pattern_sections(pattern_id,subject_id,section_name,display_order,question_count,marks_per_question,negative_marks)
   VALUES(pat,subject,current_subject,group_pos,1,(v.paper->>'marks')::numeric,(v.paper->>'negative')::numeric) RETURNING id INTO sec;
   group_pos:=group_pos+1;
  ELSE UPDATE public.exam_pattern_sections SET question_count=question_count+1 WHERE id=sec; END IF;
  bank:=public.ksc_save_question(NULL,jsonb_build_object('exam_id',v.exam_id,'subject_id',subject,'level_id',delivery_level,'content',q->>'content'),q->'options',(q->>'correct')::integer);
  UPDATE public.questions SET status='APPROVED',source_reference='Library version '||v.id||', question '||(q->>'number') WHERE id=(bank->>'id')::uuid;
  INSERT INTO public.test_questions(test_id,question_id,section_id,sort_order) VALUES((t->>'id')::uuid,(bank->>'id')::uuid,sec,pos);
  pos:=pos+1;previous_subject:=current_subject;
 END LOOP;
 PERFORM public.publish_test((t->>'id')::uuid);
 INSERT INTO public.ksc_staff_tests(test_id,course_id) VALUES((t->>'id')::uuid,p_course);
 UPDATE ksc_private.library_deliveries SET test_id=(t->>'id')::uuid WHERE id=d.id;
 DELETE FROM ksc_private.staff_authoring_context WHERE transaction_id=txid_current() AND user_id=auth.uid();
 RETURN jsonb_build_object('id',d.id,'test_id',t->>'id','title',p_settings->>'title','opens_at',opening,'closes_at',closing);
END $$;

CREATE FUNCTION public.ksc_library_deliveries() RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER
SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT coalesce(jsonb_agg(jsonb_build_object('id',d.id,'test_id',d.test_id,'title',d.settings->>'title','course',c.name,
 'batches',(SELECT jsonb_agg(b.name ORDER BY b.name) FROM public.ksc_batches b WHERE b.id=ANY(d.batches)),
 'opens_at',d.opens_at,'closes_at',d.closes_at,'created_at',d.created_at,'question_count',jsonb_array_length(v.paper->'questions')) ORDER BY d.created_at DESC),'[]')
 FROM ksc_private.library_deliveries d JOIN public.ksc_courses c ON c.id=d.course_id JOIN ksc_private.library_versions v ON v.id=d.version_id
 WHERE public.ksc_is_admin() OR (public.ksc_manages_course(d.course_id) AND NOT EXISTS(SELECT 1 FROM unnest(d.batches) b WHERE NOT public.ksc_manages_batch(b)))
$$;

-- Legacy tests keep existing visibility. Bound tests require enrollment + window
-- for new starts. Existing attempts retain read/resume/submit/history after expiry
-- or enrollment removal; final marks stay frozen and answers stay private.
CREATE FUNCTION public.ksc_library_can_open(p_test uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT NOT EXISTS(SELECT 1 FROM ksc_private.library_deliveries WHERE test_id=p_test)
 OR public.ksc_is_admin() OR EXISTS(SELECT 1 FROM public.test_attempts WHERE test_id=p_test AND student_id=auth.uid())
 OR EXISTS(SELECT 1 FROM ksc_private.library_deliveries d WHERE d.test_id=p_test AND
 ((public.ksc_manages_course(d.course_id) AND NOT EXISTS(SELECT 1 FROM unnest(d.batches) b WHERE NOT public.ksc_manages_batch(b)))
 OR (auth.uid() IS NOT NULL AND now()>=d.opens_at AND (d.closes_at IS NULL OR now()<d.closes_at)
 AND EXISTS(SELECT 1 FROM public.ksc_enrollments e WHERE e.student_id=auth.uid() AND e.batch_id=ANY(d.batches)))))
$$;
CREATE POLICY library_test_audience ON public.tests AS RESTRICTIVE FOR SELECT USING(public.ksc_library_can_open(id));
CREATE POLICY library_question_audience ON public.test_question_snapshots AS RESTRICTIVE FOR SELECT USING(public.ksc_library_can_open(test_id));
CREATE POLICY library_option_audience ON public.test_option_snapshots AS RESTRICTIVE FOR SELECT USING(public.ksc_library_can_open(test_id));
CREATE POLICY library_explanation_audience ON public.test_explanation_snapshots AS RESTRICTIVE FOR SELECT USING(public.ksc_library_can_open(test_id));
-- Guard the security-definer start RPC too; RLS alone does not protect it.
ALTER FUNCTION public.start_test_attempt(uuid) RENAME TO ksc_start_test_attempt_legacy;
ALTER FUNCTION public.ksc_start_test_attempt_legacy(uuid) SET SCHEMA ksc_private;
REVOKE ALL ON FUNCTION ksc_private.ksc_start_test_attempt_legacy(uuid) FROM PUBLIC,anon,authenticated,service_role;
CREATE FUNCTION public.start_test_attempt(p_test_id uuid) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public,pg_temp AS $$ BEGIN
 PERFORM 1 FROM ksc_private.library_deliveries WHERE test_id=p_test_id FOR SHARE;
 PERFORM 1 FROM public.ksc_enrollments e JOIN ksc_private.library_deliveries d ON e.batch_id=ANY(d.batches)
 WHERE d.test_id=p_test_id AND e.student_id=auth.uid() FOR SHARE OF e;
 IF auth.uid() IS NULL OR NOT public.ksc_library_can_open(p_test_id) OR EXISTS(SELECT 1 FROM public.ksc_staff_access WHERE user_id=auth.uid())
 THEN RAISE EXCEPTION 'Test is not available for your enrolled batch or access window'; END IF;
 RETURN ksc_private.ksc_start_test_attempt_legacy(p_test_id);
END $$;
REVOKE ALL ON FUNCTION ksc_private.library_exam_access(uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;
DO $$ DECLARE f regprocedure; n text; BEGIN
 FOR f,n IN SELECT p.oid::regprocedure,p.proname FROM pg_proc p JOIN pg_namespace ns ON ns.oid=p.pronamespace
 WHERE ns.nspname='public' AND p.proname IN('ksc_library_add_ready','ksc_exam_library_list','ksc_library_audiences','ksc_teacher_publish_library','ksc_library_deliveries','ksc_library_can_open','start_test_attempt') LOOP
 EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,anon,authenticated,service_role',f);
 EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated',f);
 IF n='ksc_library_can_open' THEN EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO anon',f); END IF;
 END LOOP;
END $$;
COMMIT;
