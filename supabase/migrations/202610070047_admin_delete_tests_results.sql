-- Admin clean-up for published tests and student results (2026-10-07).
-- 1. "Delete published test" withdraws it: students can no longer see or start it, it leaves the
--    Published tests lists, submitted results and answers are kept, and the paper can be published again.
--    The test row itself stays (published tests are immutable and results point at it).
-- 2. "Delete student result" removes one finished attempt and its answers (logged in
--    ksc_private.deleted_results); the student may take the test again while it is published.
-- Both are administrator-only. Idempotent: repeating a call is safe.
BEGIN;
DO $$ BEGIN
 IF to_regclass('ksc_private.program_deliveries') IS NULL OR to_regprocedure('public.ksc_publish_program_paper(uuid,uuid,text,uuid)') IS NULL
 THEN RAISE EXCEPTION 'Expected KSC program publishing 0046 baseline'; END IF;
END $$;

ALTER TABLE ksc_private.program_deliveries ADD COLUMN withdrawn_at timestamptz, ADD COLUMN withdrawn_by uuid REFERENCES auth.users(id);
ALTER TABLE ksc_private.library_deliveries ADD COLUMN withdrawn_at timestamptz, ADD COLUMN withdrawn_by uuid REFERENCES auth.users(id);
-- A withdrawn publication no longer blocks publishing the same version to the same program again.
ALTER TABLE ksc_private.program_deliveries DROP CONSTRAINT program_deliveries_version_id_exam_id_key;
CREATE UNIQUE INDEX program_deliveries_live_version_exam ON ksc_private.program_deliveries(version_id,exam_id) WHERE withdrawn_at IS NULL;

CREATE TABLE ksc_private.deleted_results(
 attempt_id uuid PRIMARY KEY, test_id uuid NOT NULL, student_id uuid NOT NULL, status text NOT NULL,
 score numeric, max_score numeric, submitted_at timestamptz, deleted_by uuid NOT NULL REFERENCES auth.users(id),
 deleted_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE ksc_private.result_deletion_context(transaction_id bigint NOT NULL, user_id uuid NOT NULL, PRIMARY KEY(transaction_id,user_id));
ALTER TABLE ksc_private.deleted_results ENABLE ROW LEVEL SECURITY;
ALTER TABLE ksc_private.result_deletion_context ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON ksc_private.deleted_results,ksc_private.result_deletion_context FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION ksc_private.test_withdrawn(p_test uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM ksc_private.program_deliveries WHERE test_id=p_test AND withdrawn_at IS NOT NULL)
 OR EXISTS(SELECT 1 FROM ksc_private.library_deliveries WHERE test_id=p_test AND withdrawn_at IS NOT NULL)
$$;
-- Students keep seeing a withdrawn test only through their own finished attempt (history and review).
CREATE FUNCTION public.ksc_test_not_withdrawn_for_me(p_test uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT NOT ksc_private.test_withdrawn(p_test)
 OR EXISTS(SELECT 1 FROM public.ksc_staff_access WHERE user_id=auth.uid() AND state='active')
 OR EXISTS(SELECT 1 FROM public.test_attempts WHERE test_id=p_test AND student_id=auth.uid() AND status<>'IN_PROGRESS')
$$;
CREATE POLICY withdrawn_test_hidden ON public.tests AS RESTRICTIVE FOR SELECT USING(public.ksc_test_not_withdrawn_for_me(id));
CREATE POLICY withdrawn_question_hidden ON public.test_question_snapshots AS RESTRICTIVE FOR SELECT USING(public.ksc_test_not_withdrawn_for_me(test_id));
CREATE POLICY withdrawn_option_hidden ON public.test_option_snapshots AS RESTRICTIVE FOR SELECT USING(public.ksc_test_not_withdrawn_for_me(test_id));

CREATE OR REPLACE FUNCTION public.ksc_publish_program_paper(p_version uuid,p_exam uuid,p_title text,p_request uuid) RETURNS jsonb
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
 SELECT * INTO d FROM ksc_private.program_deliveries WHERE version_id=p_version AND exam_id=p_exam AND withdrawn_at IS NULL;
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
 OR ksc_private.test_withdrawn(p_test_id)
 THEN RAISE EXCEPTION 'Test is not available for your program or access window'; END IF;
 RETURN ksc_private.ksc_start_test_attempt_legacy(p_test_id);
END $$;

CREATE OR REPLACE FUNCTION public.ksc_program_library_deliveries() RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER
SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT coalesce(jsonb_agg(jsonb_build_object('id',d.id,'version_id',d.version_id,'test_id',d.test_id,'title',d.settings->>'title',
 'exam_id',d.exam_id,'program',e.name,'opens_at',d.created_at,'question_count',(v.summary->>'question_count')::integer) ORDER BY d.created_at DESC),'[]')
 FROM ksc_private.program_deliveries d JOIN ksc_private.library_versions v ON v.id=d.version_id JOIN public.exams e ON e.id=d.exam_id
 WHERE d.withdrawn_at IS NULL AND EXISTS(SELECT 1 FROM public.ksc_staff_access WHERE user_id=auth.uid() AND role IN('teacher','admin') AND state='active' AND NOT password_change_required)
$$;

CREATE OR REPLACE FUNCTION public.ksc_library_deliveries() RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER
SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT coalesce(jsonb_agg(jsonb_build_object('id',d.id,'test_id',d.test_id,'title',d.settings->>'title','course',c.name,
 'batches',(SELECT jsonb_agg(b.name ORDER BY b.name) FROM public.ksc_batches b WHERE b.id=ANY(d.batches)),
 'opens_at',d.opens_at,'closes_at',d.closes_at,'created_at',d.created_at,'question_count',jsonb_array_length(v.paper->'questions')) ORDER BY d.created_at DESC),'[]')
 FROM ksc_private.library_deliveries d JOIN public.ksc_courses c ON c.id=d.course_id JOIN ksc_private.library_versions v ON v.id=d.version_id
 WHERE d.withdrawn_at IS NULL AND (public.ksc_is_admin() OR (public.ksc_manages_course(d.course_id) AND NOT EXISTS(SELECT 1 FROM unnest(d.batches) b WHERE NOT public.ksc_manages_batch(b))))
$$;

CREATE FUNCTION public.ksc_withdraw_published_test(p_test uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE found_rows integer:=0; n integer;
BEGIN
 IF NOT public.ksc_is_admin() THEN RAISE EXCEPTION 'Administrator access required'; END IF;
 IF p_test IS NULL THEN RAISE EXCEPTION 'Choose a published test'; END IF;
 UPDATE ksc_private.program_deliveries SET withdrawn_at=coalesce(withdrawn_at,now()),withdrawn_by=coalesce(withdrawn_by,auth.uid()) WHERE test_id=p_test;
 GET DIAGNOSTICS n=ROW_COUNT; found_rows:=found_rows+n;
 UPDATE ksc_private.library_deliveries SET withdrawn_at=coalesce(withdrawn_at,now()),withdrawn_by=coalesce(withdrawn_by,auth.uid()) WHERE test_id=p_test;
 GET DIAGNOSTICS n=ROW_COUNT; found_rows:=found_rows+n;
 IF found_rows=0 THEN RAISE EXCEPTION 'This published test is no longer available'; END IF;
 RETURN jsonb_build_object('test_id',p_test,'withdrawn',true,
  'results_kept',(SELECT count(*) FROM public.test_attempts WHERE test_id=p_test AND status IN('SUBMITTED','EXPIRED')));
END $$;

-- Finished attempts stay immutable except inside ksc_delete_student_result.
CREATE FUNCTION ksc_private.result_deletion_allowed() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM ksc_private.result_deletion_context WHERE transaction_id=txid_current())
$$;
REVOKE ALL ON FUNCTION ksc_private.result_deletion_allowed() FROM PUBLIC,anon,authenticated,service_role;
CREATE OR REPLACE FUNCTION public.prevent_finalized_attempt_edits() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN
  IF OLD.status<>'IN_PROGRESS' THEN
   IF NOT ksc_private.result_deletion_allowed() THEN RAISE EXCEPTION 'Cannot delete a finalized test attempt.'; END IF;
  END IF;
  RETURN OLD;
 END IF;
 IF TG_OP='UPDATE' AND OLD.status<>'IN_PROGRESS' THEN RAISE EXCEPTION 'Cannot modify a finalized test attempt.'; END IF;
 RETURN NEW;
END $$;

CREATE FUNCTION public.ksc_delete_student_result(p_attempt uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE a public.test_attempts;
BEGIN
 IF NOT public.ksc_is_admin() THEN RAISE EXCEPTION 'Administrator access required'; END IF;
 SELECT * INTO a FROM public.test_attempts WHERE id=p_attempt FOR UPDATE;
 IF NOT FOUND THEN
  IF EXISTS(SELECT 1 FROM ksc_private.deleted_results WHERE attempt_id=p_attempt) THEN RETURN jsonb_build_object('attempt_id',p_attempt,'deleted',true,'already_deleted',true); END IF;
  RAISE EXCEPTION 'This result is no longer available';
 END IF;
 IF a.status NOT IN('SUBMITTED','EXPIRED') THEN RAISE EXCEPTION 'Only finished results can be deleted'; END IF;
 INSERT INTO ksc_private.deleted_results(attempt_id,test_id,student_id,status,score,max_score,submitted_at,deleted_by)
 VALUES(a.id,a.test_id,a.student_id,a.status,a.score,a.max_score,a.submitted_at,auth.uid());
 INSERT INTO ksc_private.result_deletion_context VALUES(txid_current(),auth.uid()) ON CONFLICT DO NOTHING;
 DELETE FROM public.test_attempts WHERE id=a.id;
 DELETE FROM ksc_private.result_deletion_context WHERE transaction_id=txid_current();
 RETURN jsonb_build_object('attempt_id',a.id,'deleted',true,'already_deleted',false);
END $$;

REVOKE ALL ON FUNCTION ksc_private.test_withdrawn(uuid) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.ksc_test_not_withdrawn_for_me(uuid),public.ksc_withdraw_published_test(uuid),public.ksc_delete_student_result(uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.ksc_test_not_withdrawn_for_me(uuid) TO anon,authenticated;
GRANT EXECUTE ON FUNCTION public.ksc_withdraw_published_test(uuid),public.ksc_delete_student_result(uuid) TO authenticated;
NOTIFY pgrst,'reload schema';
COMMIT;
