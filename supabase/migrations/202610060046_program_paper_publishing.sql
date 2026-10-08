-- Program + ready paper publication; no course/batch enrollment is created.
BEGIN;
DO $$ BEGIN
 IF to_regclass('public.organizations') IS NOT NULL OR to_regclass('ksc_private.library_archives') IS NULL
 OR to_regclass('public.ksc_student_program_memberships') IS NULL OR to_regprocedure('public.ksc_library_bring_back(uuid)') IS NULL
 THEN RAISE EXCEPTION 'Expected isolated KSC library045 and student-program041 baseline'; END IF;
END $$;
ALTER TABLE public.tests ADD COLUMN program_wide boolean NOT NULL DEFAULT false;
CREATE TABLE ksc_private.program_deliveries(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), version_id uuid NOT NULL REFERENCES ksc_private.library_versions(id),
 exam_id uuid NOT NULL REFERENCES public.exams(id), actor uuid NOT NULL REFERENCES auth.users(id), request_id uuid NOT NULL,
 test_id uuid UNIQUE REFERENCES public.tests(id), settings jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(actor,request_id), UNIQUE(version_id,exam_id)
);
ALTER TABLE ksc_private.program_deliveries ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON ksc_private.program_deliveries FROM PUBLIC,anon,authenticated,service_role;
CREATE FUNCTION public.ksc_publish_program_paper(p_version uuid,p_exam uuid,p_title text,p_request uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp SET statement_timeout TO '120s' AS $$
DECLARE v ksc_private.library_versions; d ksc_private.program_deliveries; q jsonb; settings jsonb;
 pat uuid; sec uuid; subject uuid; bank jsonb; t jsonb; pos integer:=0; group_pos integer:=0; previous_subject text; current_subject text;
BEGIN
 PERFORM 1 FROM public.ksc_staff_access WHERE user_id=auth.uid() AND role IN('teacher','admin') AND state='active' AND NOT password_change_required FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Active teacher or administrator access required'; END IF;
 IF p_request IS NULL OR coalesce(btrim(p_title),'')='' OR length(p_title)>200 THEN RAISE EXCEPTION 'Choose a test name'; END IF;
 settings:=jsonb_build_object('title',btrim(p_title),'review_policy','AFTER_SUBMISSION');
 PERFORM pg_advisory_xact_lock(hashtextextended(auth.uid()::text||p_request::text,46001));
 SELECT * INTO d FROM ksc_private.program_deliveries WHERE actor=auth.uid() AND request_id=p_request;
 IF FOUND THEN
  IF d.version_id IS DISTINCT FROM p_version OR d.exam_id IS DISTINCT FROM p_exam OR d.settings IS DISTINCT FROM settings
  THEN RAISE EXCEPTION 'Publication request changed. Start a new publication'; END IF;
  RETURN jsonb_build_object('id',d.id,'test_id',d.test_id,'title',d.settings->>'title','exam_id',d.exam_id,'opens_at',d.created_at,'already_published',false);
 END IF;
 SELECT * INTO v FROM ksc_private.library_versions WHERE id=p_version FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Ready version unavailable'; END IF;
 IF v.exam_id IS DISTINCT FROM p_exam THEN RAISE EXCEPTION 'Paper does not belong to the selected program'; END IF;
 PERFORM 1 FROM public.exams WHERE id=p_exam AND is_active FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Program is unavailable'; END IF;
 -- One publication per immutable version/program, even when two staff publish at once.
 PERFORM pg_advisory_xact_lock(hashtextextended(p_version::text||p_exam::text,46002));
 SELECT * INTO d FROM ksc_private.program_deliveries WHERE version_id=p_version AND exam_id=p_exam;
 IF FOUND THEN RETURN jsonb_build_object('id',d.id,'test_id',d.test_id,'title',d.settings->>'title','exam_id',d.exam_id,'opens_at',d.created_at,'already_published',true); END IF;
 IF EXISTS(SELECT 1 FROM ksc_private.library_archives WHERE version_id=p_version) THEN RAISE EXCEPTION 'Ready version unavailable'; END IF;
 INSERT INTO ksc_private.program_deliveries(version_id,exam_id,actor,request_id,settings)
 VALUES(p_version,p_exam,auth.uid(),p_request,settings) RETURNING * INTO d;
 INSERT INTO ksc_private.staff_authoring_context VALUES(txid_current(),auth.uid());
 INSERT INTO public.exam_patterns(exam_id,level_id,name,total_duration_minutes,total_marks,status)
 VALUES(v.exam_id,NULL::uuid,settings->>'title',(v.paper->>'duration')::integer,jsonb_array_length(v.paper->'questions')*(v.paper->>'marks')::numeric,'ACTIVE') RETURNING id INTO pat;
 t:=public.ksc_create_test(jsonb_build_object('exam_id',v.exam_id,'pattern_id',pat,'name',settings->>'title','test_kind','MODEL','review_policy',settings->>'review_policy'));
 FOR q IN SELECT value FROM jsonb_array_elements(v.paper->'questions') LOOP
  current_subject:=coalesce(nullif(btrim(q->>'subject'),''),'General / mixed subjects');
  IF previous_subject IS DISTINCT FROM current_subject THEN
   SELECT id INTO subject FROM public.exam_subjects WHERE exam_id=v.exam_id AND name=current_subject ORDER BY id LIMIT 1;
   IF subject IS NULL THEN INSERT INTO public.exam_subjects(exam_id,name) VALUES(v.exam_id,current_subject) RETURNING id INTO subject; END IF;
   INSERT INTO public.exam_pattern_sections(pattern_id,subject_id,section_name,display_order,question_count,marks_per_question,negative_marks)
   VALUES(pat,subject,current_subject,group_pos,1,(v.paper->>'marks')::numeric,(v.paper->>'negative')::numeric) RETURNING id INTO sec;
   group_pos:=group_pos+1;
  ELSE UPDATE public.exam_pattern_sections SET question_count=question_count+1 WHERE id=sec; END IF;
  bank:=public.ksc_save_question(NULL,jsonb_build_object('exam_id',v.exam_id,'subject_id',subject,'level_id',NULL::uuid,'content',q->>'content'),q->'options',(q->>'correct')::integer);
  UPDATE public.questions SET status='APPROVED',source_reference='Library version '||v.id||', question '||(q->>'number') WHERE id=(bank->>'id')::uuid;
  INSERT INTO public.test_questions(test_id,question_id,section_id,sort_order) VALUES((t->>'id')::uuid,(bank->>'id')::uuid,sec,pos);
  pos:=pos+1;previous_subject:=current_subject;
 END LOOP;
 UPDATE public.tests SET program_wide=true WHERE id=(t->>'id')::uuid;
 PERFORM public.publish_test((t->>'id')::uuid);
 UPDATE ksc_private.program_deliveries SET test_id=(t->>'id')::uuid WHERE id=d.id;
 DELETE FROM ksc_private.staff_authoring_context WHERE transaction_id=txid_current() AND user_id=auth.uid();
 RETURN jsonb_build_object('id',d.id,'test_id',t->>'id','title',btrim(p_title),'exam_id',p_exam,'opens_at',d.created_at,'already_published',false);
END $$;

CREATE FUNCTION public.ksc_program_can_open(p_test uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT NOT EXISTS(SELECT 1 FROM ksc_private.program_deliveries WHERE test_id=p_test)
 OR public.ksc_is_admin()
 OR EXISTS(SELECT 1 FROM public.test_attempts WHERE test_id=p_test AND student_id=auth.uid())
 OR EXISTS(SELECT 1 FROM ksc_private.program_deliveries d WHERE d.test_id=p_test AND (
  EXISTS(SELECT 1 FROM public.ksc_staff_access s WHERE s.user_id=auth.uid() AND s.role='teacher' AND s.state='active' AND NOT s.password_change_required)
  OR (auth.uid() IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.ksc_staff_access WHERE user_id=auth.uid())
   AND NOT EXISTS(SELECT 1 FROM public.teacher_profiles WHERE id=auth.uid())
   AND EXISTS(SELECT 1 FROM public.student_profiles WHERE id=auth.uid()) AND (
    EXISTS(SELECT 1 FROM public.ksc_student_program_memberships m JOIN public.exam_levels l ON l.id=m.level_id WHERE m.user_id=auth.uid() AND l.exam_id=d.exam_id)
    OR EXISTS(SELECT 1 FROM public.ksc_student_program_preferences m JOIN public.exam_levels l ON l.id=m.level_id WHERE m.user_id=auth.uid() AND l.exam_id=d.exam_id)
    OR EXISTS(SELECT 1 FROM public.ksc_enrollments en JOIN public.ksc_batches b ON b.id=en.batch_id JOIN public.ksc_course_tracks ct ON ct.course_id=b.course_id
      JOIN public.exam_levels l ON l.id=ct.level_id WHERE en.student_id=auth.uid() AND l.exam_id=d.exam_id)))))
$$;
CREATE POLICY program_test_audience ON public.tests AS RESTRICTIVE FOR SELECT USING(public.ksc_program_can_open(id));
CREATE POLICY program_question_audience ON public.test_question_snapshots AS RESTRICTIVE FOR SELECT USING(public.ksc_program_can_open(test_id));
CREATE POLICY program_option_audience ON public.test_option_snapshots AS RESTRICTIVE FOR SELECT USING(public.ksc_program_can_open(test_id));
CREATE POLICY program_explanation_audience ON public.test_explanation_snapshots AS RESTRICTIVE FOR SELECT USING(public.ksc_program_can_open(test_id));
CREATE OR REPLACE FUNCTION public.start_test_attempt(p_test_id uuid) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public,pg_temp AS $$ BEGIN
 PERFORM 1 FROM ksc_private.library_deliveries WHERE test_id=p_test_id FOR SHARE;
 PERFORM 1 FROM ksc_private.program_deliveries WHERE test_id=p_test_id FOR SHARE;
 PERFORM 1 FROM public.ksc_enrollments e JOIN ksc_private.library_deliveries d ON e.batch_id=ANY(d.batches)
 WHERE d.test_id=p_test_id AND e.student_id=auth.uid() FOR SHARE OF e;
 PERFORM 1 FROM public.ksc_student_program_memberships WHERE user_id=auth.uid() FOR SHARE;
 PERFORM 1 FROM public.ksc_student_program_preferences WHERE user_id=auth.uid() FOR SHARE;
 IF auth.uid() IS NULL OR NOT public.ksc_library_can_open(p_test_id) OR NOT public.ksc_program_can_open(p_test_id)
 OR EXISTS(SELECT 1 FROM public.ksc_staff_access WHERE user_id=auth.uid()) OR EXISTS(SELECT 1 FROM public.teacher_profiles WHERE id=auth.uid())
 THEN RAISE EXCEPTION 'Test is not available for your program or access window'; END IF;
 RETURN ksc_private.ksc_start_test_attempt_legacy(p_test_id);
END $$;

CREATE FUNCTION public.ksc_program_library_deliveries() RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER
SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT coalesce(jsonb_agg(jsonb_build_object('id',d.id,'version_id',d.version_id,'test_id',d.test_id,'title',d.settings->>'title',
 'exam_id',d.exam_id,'program',e.name,'opens_at',d.created_at,'question_count',(v.summary->>'question_count')::integer) ORDER BY d.created_at DESC),'[]')
 FROM ksc_private.program_deliveries d JOIN ksc_private.library_versions v ON v.id=d.version_id JOIN public.exams e ON e.id=d.exam_id
 WHERE EXISTS(SELECT 1 FROM public.ksc_staff_access WHERE user_id=auth.uid() AND role IN('teacher','admin') AND state='active' AND NOT password_change_required)
$$;
-- A teacher may review results for the program test they published; other teachers keep their existing scope.
CREATE OR REPLACE FUNCTION ksc_private.can_review_student_result(p_attempt uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT auth.uid() IS NOT NULL AND (public.ksc_is_admin() OR (
 EXISTS(SELECT 1 FROM public.ksc_staff_access WHERE user_id=auth.uid() AND role='teacher' AND state='active' AND NOT password_change_required)
 AND (EXISTS(SELECT 1 FROM public.test_attempts a JOIN public.ksc_staff_tests x ON x.test_id=a.test_id
  WHERE a.id=p_attempt AND public.ksc_manages_course(x.course_id) AND public.ksc_teaches_student(a.student_id,x.course_id))
 OR EXISTS(SELECT 1 FROM public.test_attempts a JOIN ksc_private.program_deliveries d ON d.test_id=a.test_id WHERE a.id=p_attempt AND d.actor=auth.uid()))));
$$;
REVOKE ALL ON FUNCTION public.ksc_publish_program_paper(uuid,uuid,text,uuid),public.ksc_program_library_deliveries(),public.ksc_program_can_open(uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.ksc_publish_program_paper(uuid,uuid,text,uuid),public.ksc_program_library_deliveries(),public.ksc_program_can_open(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.ksc_program_can_open(uuid) TO anon;
NOTIFY pgrst,'reload schema';
NOTIFY pgrst,'reload config';
COMMIT;
