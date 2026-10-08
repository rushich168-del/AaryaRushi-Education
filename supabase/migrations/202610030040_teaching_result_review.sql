BEGIN;
-- Keep course/batch authorization; never infer teaching access from program selection.
CREATE FUNCTION ksc_private.can_review_student_result(p_attempt uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT auth.uid() IS NOT NULL AND (public.ksc_is_admin() OR (
 EXISTS(SELECT 1 FROM public.ksc_staff_access WHERE user_id=auth.uid() AND role='teacher'
 AND state='active' AND NOT password_change_required)
 AND EXISTS(SELECT 1 FROM public.test_attempts a JOIN public.ksc_staff_tests x ON x.test_id=a.test_id
 WHERE a.id=p_attempt AND public.ksc_manages_course(x.course_id)
 AND public.ksc_teaches_student(a.student_id,x.course_id))));
$$;
REVOKE ALL ON FUNCTION ksc_private.can_review_student_result(uuid) FROM PUBLIC,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION public.ksc_teaching_results() RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER
SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT coalesce(jsonb_agg(jsonb_build_object('id',a.id,'student',s.full_name,'test',t.name,
 'student_id',a.student_id,'course_id',(SELECT x.course_id FROM public.ksc_staff_tests x WHERE x.test_id=t.id),'test_id',t.id,'exam_id',t.exam_id,'level_id',t.level_id,'program',t.exam_name,
 'score',a.score,'total_marks',a.max_score,'submitted_at',a.submitted_at)
 ORDER BY a.submitted_at DESC,a.id),'[]')
 FROM public.test_attempts a JOIN public.tests t ON t.id=a.test_id
 JOIN public.student_profiles s ON s.id=a.student_id
 WHERE a.status IN('SUBMITTED','EXPIRED') AND ksc_private.can_review_student_result(a.id);
$$;

CREATE FUNCTION public.ksc_teaching_result_review(p_attempt uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE a public.test_attempts; t public.tests; learner text; questions jsonb;
BEGIN
 IF NOT ksc_private.can_review_student_result(p_attempt) THEN RAISE EXCEPTION 'Assigned student result access required'; END IF;
 SELECT * INTO a FROM public.test_attempts WHERE id=p_attempt;
 IF NOT FOUND OR a.status NOT IN('SUBMITTED','EXPIRED') THEN RAISE EXCEPTION 'Completed result required'; END IF;
 SELECT * INTO t FROM public.tests WHERE id=a.test_id;
 IF t.snapshot_contract_version IS DISTINCT FROM 1 THEN RAISE EXCEPTION 'Historical result needs snapshot reconciliation before answer review'; END IF;
 SELECT full_name INTO learner FROM public.student_profiles WHERE id=a.student_id;
 SELECT coalesce(jsonb_agg(jsonb_build_object('question_id',q.question_id,'section',q.section_name,
 'content',q.content,'selected_option_id',ans.selected_option_id,'correct_option_id',key.correct_option_id,
 'marks',q.marks,'negative_marks',q.negative_marks,
 'marks_awarded',CASE WHEN key.correct_option_id IS NULL THEN NULL WHEN ans.selected_option_id IS NULL THEN 0
 WHEN ans.selected_option_id=key.correct_option_id THEN q.marks ELSE -q.negative_marks END,
 'explanation',(SELECT e.explanation FROM public.test_explanation_snapshots e WHERE e.test_id=q.test_id AND e.question_id=q.question_id),
 'options',(SELECT coalesce(jsonb_agg(jsonb_build_object('id',o.id,'content',o.content) ORDER BY o.sort_order,o.id),'[]')
 FROM public.test_option_snapshots o WHERE o.test_id=q.test_id AND o.question_id=q.question_id))
 ORDER BY q.section_order,q.sort_order,q.question_id),'[]') INTO questions
 FROM public.test_question_snapshots q LEFT JOIN public.attempt_answers ans ON ans.attempt_id=a.id AND ans.question_id=q.question_id
 LEFT JOIN public.test_answer_key_snapshots key ON key.test_id=q.test_id AND key.question_id=q.question_id
 WHERE q.test_id=t.id;
 RETURN jsonb_build_object('id',a.id,'student',learner,'test',t.name,'program',t.exam_name,
 'score',a.score,'total_marks',a.max_score,'submitted_at',a.submitted_at,'questions',questions);
END $$;
REVOKE ALL ON FUNCTION public.ksc_teaching_result_review(uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.ksc_teaching_result_review(uuid) TO authenticated;
COMMENT ON FUNCTION public.ksc_teaching_result_review(uuid) IS 'Read-only finalized snapshot review for administrators or assigned teachers; no scoring/approval mutation.';
NOTIFY pgrst,'reload schema';
COMMIT;
