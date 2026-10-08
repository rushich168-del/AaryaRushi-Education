-- Forward-only closure for the reconciled 0001-0008 baseline. See DATABASE-BASELINE.md.
-- Existing snapshots are retained, but missing historical facts are never inferred from live rows.
ALTER TABLE public.tests ADD COLUMN snapshot_contract_version integer NOT NULL DEFAULT 0,
 ADD COLUMN exam_name text, ADD COLUMN pattern_name text;
ALTER TABLE public.test_question_snapshots
 ADD COLUMN section_name text, ADD COLUMN subject_name text,
 ADD COLUMN section_order integer, ADD COLUMN level_id uuid, ADD COLUMN syllabus_id uuid,
 ADD COLUMN chapter_id uuid, ADD COLUMN topic_id uuid, ADD COLUMN legacy_topic_id uuid,
 ADD COLUMN question_type text, ADD COLUMN source_reference text, ADD COLUMN generated_by_ai boolean;

CREATE TABLE public.test_explanation_snapshots (
 test_id uuid NOT NULL REFERENCES public.tests(id), question_id uuid NOT NULL,
 explanation text, PRIMARY KEY(test_id, question_id)
);
INSERT INTO public.test_explanation_snapshots SELECT test_id, question_id, explanation
FROM public.test_question_snapshots;
ALTER TABLE public.test_question_snapshots DROP COLUMN explanation;
ALTER TABLE public.test_explanation_snapshots ENABLE ROW LEVEL SECURITY;
-- Remove the live-bank explanation escape route. Students consume safe frozen snapshots.
DROP POLICY "Students can view test questions" ON public.questions;

CREATE OR REPLACE FUNCTION public.can_review_test(p_test_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
 SELECT auth.uid() IS NOT NULL AND (public.is_teacher() OR EXISTS (
 SELECT 1 FROM public.test_attempts a JOIN public.tests t ON t.id=a.test_id
 WHERE a.test_id=p_test_id AND a.student_id=auth.uid()
 AND a.status IN ('SUBMITTED','EXPIRED') AND t.review_policy='AFTER_SUBMISSION'));
$$;
CREATE POLICY "Released explanations only" ON public.test_explanation_snapshots
 FOR SELECT TO authenticated USING(public.can_review_test(test_id));
REVOKE ALL ON public.test_explanation_snapshots FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.test_explanation_snapshots TO authenticated;

-- Published data stays immutable even for staff and during FK cascades.
CREATE FUNCTION public.guard_frozen_exam_rows() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE target uuid; published boolean;
BEGIN
 IF TG_OP='UPDATE' AND NEW.test_id IS DISTINCT FROM OLD.test_id THEN
   RAISE EXCEPTION 'Cannot reparent exam rows';
 END IF;
 IF TG_OP='DELETE' THEN target:=OLD.test_id; ELSE target:=NEW.test_id; END IF;
 SELECT is_published INTO published FROM public.tests WHERE id=target FOR UPDATE;
 IF published IS TRUE THEN RAISE EXCEPTION 'Published snapshot/test questions are immutable'; END IF;
 -- Parent lock serializes membership edits with publication.
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER frozen_questions BEFORE INSERT OR UPDATE OR DELETE ON public.test_question_snapshots
 FOR EACH ROW EXECUTE FUNCTION public.guard_frozen_exam_rows();
CREATE TRIGGER frozen_options BEFORE INSERT OR UPDATE OR DELETE ON public.test_option_snapshots
 FOR EACH ROW EXECUTE FUNCTION public.guard_frozen_exam_rows();
CREATE TRIGGER frozen_keys BEFORE INSERT OR UPDATE OR DELETE ON public.test_answer_key_snapshots
 FOR EACH ROW EXECUTE FUNCTION public.guard_frozen_exam_rows();
CREATE TRIGGER frozen_explanations BEFORE INSERT OR UPDATE OR DELETE ON public.test_explanation_snapshots
 FOR EACH ROW EXECUTE FUNCTION public.guard_frozen_exam_rows();
CREATE TRIGGER frozen_membership BEFORE INSERT OR UPDATE OR DELETE ON public.test_questions
 FOR EACH ROW EXECUTE FUNCTION public.guard_frozen_exam_rows();

CREATE OR REPLACE FUNCTION public.prevent_published_test_edits() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
 IF OLD.is_published IS TRUE AND NEW IS DISTINCT FROM OLD THEN
   RAISE EXCEPTION 'Published test is immutable';
 END IF;
 IF (NEW.is_published IS TRUE OR NEW.snapshot_contract_version IS DISTINCT FROM OLD.snapshot_contract_version)
 AND current_user <> pg_get_userbyid((SELECT relowner FROM pg_catalog.pg_class WHERE oid='public.tests'::regclass)) THEN
   RAISE EXCEPTION 'Use publish_test to publish';
 END IF;
 RETURN NEW;
END $$;
CREATE FUNCTION public.guard_test_insert() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.is_published IS TRUE OR NEW.snapshot_contract_version<>0 THEN
 RAISE EXCEPTION 'Create a draft then use publish_test'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER draft_test_insert BEFORE INSERT ON public.tests
 FOR EACH ROW EXECUTE FUNCTION public.guard_test_insert();

-- Repair known missing timed deadlines without touching finalized results.
UPDATE public.test_attempts a SET expires_at=a.started_at + make_interval(mins=>t.duration_minutes)
FROM public.tests t WHERE a.test_id=t.id AND a.status='IN_PROGRESS'
AND a.expires_at IS NULL AND t.duration_minutes IS NOT NULL;

CREATE OR REPLACE FUNCTION public.publish_test(p_test_id UUID)
RETURNS BOOLEAN AS $$
DECLARE
    v_test RECORD;
    v_q RECORD;
    v_opt RECORD;
BEGIN
    -- Explicit authenticated-caller check
    IF auth.uid() IS NULL THEN
        RAISE EXCEPTION 'Authenticated user required.';
    END IF;

    -- Staff authorization
    IF NOT public.is_teacher() THEN
        RAISE EXCEPTION 'Unauthorized. Only teachers can publish tests.';
    END IF;

    -- Atomicity and locking
    SELECT * INTO v_test FROM public.tests WHERE id = p_test_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Test not found.';
    END IF;

    IF v_test.is_published THEN
        RAISE EXCEPTION 'Test is already published.';
    END IF;

    IF v_test.exam_id IS NULL OR v_test.pattern_id IS NULL OR NOT EXISTS (
      SELECT 1 FROM public.exam_patterns WHERE id=v_test.pattern_id AND exam_id=v_test.exam_id
    ) THEN RAISE EXCEPTION 'Invalid test pattern/exam'; END IF;
    IF v_test.duration_minutes IS NOT NULL AND v_test.duration_minutes<=0 THEN
      RAISE EXCEPTION 'Invalid duration'; END IF;
    IF v_test.review_policy IS NULL OR v_test.review_policy NOT IN ('SUMMARY_ONLY','AFTER_SUBMISSION') THEN
      RAISE EXCEPTION 'Invalid review policy'; END IF;
    LOCK TABLE public.exams, public.questions, public.question_options, public.question_answer_keys,
      public.exam_pattern_sections, public.exam_patterns, public.exam_subjects,
      public.exam_levels, public.syllabi, public.chapters, public.topics, public.syllabus_topics IN SHARE MODE;
    IF NOT EXISTS (SELECT 1 FROM public.test_questions WHERE test_id=p_test_id) THEN
      RAISE EXCEPTION 'Cannot publish empty test'; END IF;
    IF EXISTS (SELECT 1 FROM public.test_questions tq
      LEFT JOIN public.questions q ON q.id=tq.question_id
      LEFT JOIN public.exam_pattern_sections sec ON sec.id=tq.section_id
      WHERE tq.test_id=p_test_id AND (q.exam_id IS DISTINCT FROM v_test.exam_id
       OR sec.pattern_id IS DISTINCT FROM v_test.pattern_id
       OR (sec.subject_id IS NOT NULL AND sec.subject_id IS DISTINCT FROM q.subject_id)
       OR sec.marks_per_question IS NULL OR sec.marks_per_question<=0
       OR sec.negative_marks IS NULL OR sec.negative_marks<0
       OR q.question_type IS DISTINCT FROM 'MCQ'
       OR q.subject_id IS NULL OR NOT EXISTS(SELECT 1 FROM public.exam_subjects es WHERE es.id=q.subject_id AND es.exam_id=q.exam_id)
       OR (q.level_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.exam_levels el WHERE el.id=q.level_id AND el.exam_id=q.exam_id))
       OR (q.syllabus_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.syllabi sy WHERE sy.id=q.syllabus_id AND sy.exam_id=q.exam_id AND sy.subject_id=q.subject_id AND sy.level_id=q.level_id))
       OR (q.chapter_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.chapters ch WHERE ch.id=q.chapter_id AND ch.syllabus_id=q.syllabus_id))
       OR (q.topic_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.topics tp WHERE tp.id=q.topic_id AND tp.chapter_id=q.chapter_id))
       OR (q.legacy_topic_id IS NOT NULL AND q.topic_id IS NULL))) THEN
      RAISE EXCEPTION 'Invalid section/question contract or unmapped legacy topic'; END IF;
    -- Freeze Questions and Hierarchy labels
    FOR v_q IN
        SELECT
            tq.question_id, tq.section_id, tq.sort_order, q.explanation, q.difficulty, q.legacy_topic_id, q.question_type, q.source_reference, q.generated_by_ai,
            eps.section_name, eps.display_order as section_order,
            q.content, q.subject_id, q.status,
            q.level_id, q.syllabus_id, q.chapter_id, q.topic_id,
            COALESCE(eps.marks_per_question, q.marks) as marks,
            COALESCE(eps.negative_marks, 0) as negative_marks
        FROM public.test_questions tq
        JOIN public.questions q ON q.id = tq.question_id
        LEFT JOIN public.exam_pattern_sections eps ON eps.id = tq.section_id
        WHERE tq.test_id = p_test_id
    LOOP
        -- Enforce approved requirement
        IF v_q.status IS DISTINCT FROM 'APPROVED' THEN
            RAISE EXCEPTION 'Cannot publish test. Question % is not approved.', v_q.question_id;
        END IF;

        -- Enforce complete options
        IF (SELECT COUNT(*) FROM public.question_options WHERE question_id = v_q.question_id) < 2 THEN
            RAISE EXCEPTION 'Cannot publish test. Question % must have at least 2 options.', v_q.question_id;
        END IF;

        -- Enforce answer key
        IF NOT EXISTS (SELECT 1 FROM public.question_answer_keys k JOIN public.question_options o ON o.id=k.correct_option_id AND o.question_id=k.question_id WHERE k.question_id = v_q.question_id) THEN
            RAISE EXCEPTION 'Cannot publish test. Question % has no answer key.', v_q.question_id;
        END IF;

        INSERT INTO public.test_question_snapshots (
            test_id, question_id, section_id, content, subject_id,
            marks, negative_marks,
            level_name, syllabus_name, chapter_name, topic_name,
            sort_order, difficulty, section_name, subject_name, section_order, level_id, syllabus_id, chapter_id, topic_id, legacy_topic_id, question_type, source_reference, generated_by_ai
        ) VALUES (
            p_test_id, v_q.question_id, v_q.section_id, v_q.content, v_q.subject_id,
            v_q.marks, v_q.negative_marks,
            (SELECT name FROM public.exam_levels WHERE id = v_q.level_id),
            (SELECT name FROM public.syllabi WHERE id = v_q.syllabus_id),
            (SELECT name FROM public.chapters WHERE id = v_q.chapter_id),
            (SELECT name FROM public.topics WHERE id = v_q.topic_id),
            v_q.sort_order, v_q.difficulty, v_q.section_name,
            (SELECT name FROM public.exam_subjects WHERE id=v_q.subject_id), v_q.section_order,
            v_q.level_id, v_q.syllabus_id, v_q.chapter_id, v_q.topic_id, v_q.legacy_topic_id, v_q.question_type, v_q.source_reference, v_q.generated_by_ai
        );

        INSERT INTO public.test_explanation_snapshots VALUES(p_test_id,v_q.question_id,v_q.explanation);
        -- Freeze Options
        FOR v_opt IN
            SELECT id, content, sort_order FROM public.question_options WHERE question_id = v_q.question_id
        LOOP
            INSERT INTO public.test_option_snapshots (test_id, question_id, original_option_id, content, sort_order)
            VALUES (p_test_id, v_q.question_id, v_opt.id, v_opt.content, v_opt.sort_order);
        END LOOP;

        -- Freeze Answer Key
        INSERT INTO public.test_answer_key_snapshots (test_id, question_id, correct_option_id)
        SELECT p_test_id, v_q.question_id, ts.id
        FROM public.question_answer_keys qak
        JOIN public.test_option_snapshots ts
          ON ts.test_id = p_test_id
          AND ts.question_id = v_q.question_id
          AND ts.original_option_id = qak.correct_option_id
        WHERE qak.question_id = v_q.question_id;
    END LOOP;

    UPDATE public.tests SET exam_name=(SELECT name FROM public.exams WHERE id=v_test.exam_id), pattern_name=(SELECT name FROM public.exam_patterns WHERE id=v_test.pattern_id), total_marks=(SELECT sum(marks) FROM public.test_question_snapshots WHERE test_id=p_test_id), snapshot_contract_version=1, is_published = true, status = 'PUBLISHED', updated_at = NOW() WHERE id = p_test_id;

    RETURN true;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp;

CREATE OR REPLACE FUNCTION public.start_test_attempt(p_test_id UUID)
RETURNS UUID AS $$
DECLARE
    v_student_id UUID := auth.uid();
    v_test RECORD;
    v_attempt_id UUID;
BEGIN
    IF v_student_id IS NULL THEN
        RAISE EXCEPTION 'Authenticated user required.';
    END IF;

    IF NOT EXISTS (SELECT 1 FROM public.student_profiles WHERE id=v_student_id) THEN
      RAISE EXCEPTION 'Registered student required'; END IF;
    SELECT * INTO v_test FROM public.tests WHERE id = p_test_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Test not found.';
    END IF;

    IF NOT v_test.is_published THEN
        RAISE EXCEPTION 'Test is not published.';
    END IF;

    IF v_test.snapshot_contract_version<>1 THEN RAISE EXCEPTION 'Legacy snapshot requires reconciliation'; END IF;
    SELECT id INTO v_attempt_id FROM public.test_attempts WHERE test_id=p_test_id AND student_id=v_student_id;
    IF FOUND THEN RETURN v_attempt_id; END IF;
    IF v_test.snapshot_contract_version<>1 THEN RAISE EXCEPTION 'Legacy snapshot requires reconciliation'; END IF;
    INSERT INTO public.test_attempts (test_id, student_id, status, started_at, expires_at)
    VALUES (p_test_id, v_student_id, 'IN_PROGRESS', clock_timestamp(),
      CASE WHEN v_test.duration_minutes IS NOT NULL THEN clock_timestamp()+make_interval(mins=>v_test.duration_minutes) END)
    RETURNING id INTO v_attempt_id;

    RETURN v_attempt_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp;

CREATE OR REPLACE FUNCTION public.save_attempt_answer(
    p_attempt_id UUID, p_question_id UUID, p_option_id UUID, p_is_marked BOOLEAN, p_clear BOOLEAN
)
RETURNS BOOLEAN AS $$
DECLARE
    v_student_id UUID := auth.uid();
    v_attempt RECORD;
BEGIN
    IF v_student_id IS NULL THEN RAISE EXCEPTION 'Authenticated user required'; END IF;
    -- Secure lock attempt row
    SELECT * INTO v_attempt FROM public.test_attempts WHERE id = p_attempt_id FOR UPDATE;

    IF NOT FOUND OR v_attempt.student_id IS DISTINCT FROM v_student_id THEN
        RAISE EXCEPTION 'Attempt not found or unauthorized.';
    END IF;

    IF v_attempt.status IS DISTINCT FROM 'IN_PROGRESS' THEN
        RAISE EXCEPTION 'Attempt is finalized. Cannot save answers.';
    END IF;

    IF v_attempt.expires_at IS NOT NULL AND clock_timestamp() >= v_attempt.expires_at THEN
        RAISE EXCEPTION 'Attempt has expired.';
    END IF;

    IF NOT EXISTS (SELECT 1 FROM public.tests WHERE id=v_attempt.test_id AND snapshot_contract_version=1) THEN
      RAISE EXCEPTION 'Legacy snapshot requires reconciliation'; END IF;
    -- Validate question belongs to this test snapshot
    IF NOT EXISTS (SELECT 1 FROM public.test_question_snapshots WHERE test_id = v_attempt.test_id AND question_id = p_question_id) THEN
        RAISE EXCEPTION 'Question does not belong to this test.';
    END IF;

    IF p_clear THEN
        INSERT INTO public.attempt_answers (attempt_id, question_id, selected_option_id, is_marked_for_review, updated_at)
        VALUES (p_attempt_id, p_question_id, NULL, p_is_marked, NOW())
        ON CONFLICT (attempt_id, question_id)
        DO UPDATE SET selected_option_id = NULL, is_marked_for_review = EXCLUDED.is_marked_for_review, updated_at = NOW();
    ELSE
        -- Validate option belongs to this question snapshot
        IF NOT EXISTS (SELECT 1 FROM public.test_option_snapshots WHERE test_id = v_attempt.test_id AND question_id = p_question_id AND id = p_option_id) THEN
            RAISE EXCEPTION 'Option does not belong to this question.';
        END IF;

        INSERT INTO public.attempt_answers (attempt_id, question_id, selected_option_id, is_marked_for_review, updated_at)
        VALUES (p_attempt_id, p_question_id, p_option_id, p_is_marked, NOW())
        ON CONFLICT (attempt_id, question_id)
        DO UPDATE SET selected_option_id = EXCLUDED.selected_option_id, is_marked_for_review = EXCLUDED.is_marked_for_review, updated_at = NOW();
    END IF;

    RETURN TRUE;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp;

CREATE OR REPLACE FUNCTION public.evaluate_and_finalize_attempt(p_attempt_id UUID)
RETURNS BOOLEAN AS $$
DECLARE
    v_attempt RECORD;
    v_q RECORD;
    v_correct_count INT := 0;
    v_incorrect_count INT := 0;
    v_unanswered_count INT := 0;
    v_score NUMERIC := 0;
    v_max_score NUMERIC := 0;
BEGIN
    SELECT * INTO v_attempt FROM public.test_attempts WHERE id = p_attempt_id FOR UPDATE;

    IF NOT FOUND THEN RETURN FALSE; END IF;
    IF v_attempt.status IS DISTINCT FROM 'IN_PROGRESS' THEN RETURN TRUE; END IF;

    IF NOT EXISTS (SELECT 1 FROM public.tests WHERE id=v_attempt.test_id AND snapshot_contract_version=1) THEN
      RAISE EXCEPTION 'Legacy snapshot requires reconciliation'; END IF;
    FOR v_q IN
        SELECT
            tqs.question_id,
            tqs.marks,
            tqs.negative_marks,
            ans.selected_option_id,
            key.correct_option_id
        FROM public.test_question_snapshots tqs
        LEFT JOIN public.attempt_answers ans ON ans.attempt_id = p_attempt_id AND ans.question_id = tqs.question_id
        LEFT JOIN public.test_answer_key_snapshots key ON key.test_id = v_attempt.test_id AND key.question_id = tqs.question_id
        WHERE tqs.test_id = v_attempt.test_id
    LOOP
        v_max_score := v_max_score + v_q.marks;

        IF v_q.selected_option_id IS NULL THEN
            v_unanswered_count := v_unanswered_count + 1;
        ELSIF v_q.selected_option_id = v_q.correct_option_id THEN
            v_correct_count := v_correct_count + 1;
            v_score := v_score + v_q.marks;
        ELSE
            v_incorrect_count := v_incorrect_count + 1;
            v_score := v_score - v_q.negative_marks;
        END IF;
    END LOOP;

    UPDATE public.test_attempts
    SET status = CASE WHEN expires_at<=clock_timestamp() THEN 'EXPIRED' ELSE 'SUBMITTED' END,
        completed_at = clock_timestamp(),
        submitted_at = NOW(),
        score = v_score,
        max_score = v_max_score,
        correct_count = v_correct_count,
        incorrect_count = v_incorrect_count,
        unanswered_count = v_unanswered_count,
        updated_at = NOW()
    WHERE id = p_attempt_id;

    RETURN TRUE;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp;
CREATE OR REPLACE FUNCTION public.submit_test_attempt(p_attempt_id UUID)
RETURNS BOOLEAN AS $$
DECLARE
    v_student_id UUID := auth.uid();
    v_attempt RECORD;
BEGIN
    IF v_student_id IS NULL THEN
        RAISE EXCEPTION 'Authenticated user required.';
    END IF;

    SELECT * INTO v_attempt FROM public.test_attempts WHERE id = p_attempt_id;
    IF NOT FOUND OR v_attempt.student_id IS DISTINCT FROM v_student_id THEN
        RAISE EXCEPTION 'Attempt not found or unauthorized.';
    END IF;

    -- Call internal evaluator (since this function is SECURITY DEFINER, it has rights)
    RETURN public.evaluate_and_finalize_attempt(p_attempt_id);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp;

CREATE OR REPLACE FUNCTION public.finalize_expired_attempts() RETURNS int
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE a record; n int:=0;
BEGIN
 IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Authenticated user required'; END IF;
 FOR a IN SELECT ta.id FROM public.test_attempts ta JOIN public.tests t ON t.id=ta.test_id
 WHERE ta.student_id=auth.uid() AND ta.status='IN_PROGRESS'
 AND ta.expires_at<=clock_timestamp() AND t.snapshot_contract_version=1
 ORDER BY ta.id FOR UPDATE OF ta SKIP LOCKED LOOP
  PERFORM public.evaluate_and_finalize_attempt(a.id); n:=n+1;
 END LOOP;
 RETURN n;
END $$;

DROP FUNCTION public.get_attempt_review(uuid);

CREATE OR REPLACE FUNCTION public.get_attempt_review(p_attempt_id UUID)
RETURNS TABLE (
    question_id UUID,
    section_name TEXT,
    content TEXT,
    marks NUMERIC,
    negative_marks NUMERIC,
    selected_option_id UUID,
    correct_option_id UUID,
    is_correct BOOLEAN,
    is_unanswered BOOLEAN,
    marks_awarded NUMERIC,
    explanation TEXT
) AS $$
DECLARE
    v_attempt RECORD;
    v_test RECORD;
    v_is_teacher BOOLEAN := public.is_teacher();
BEGIN
    IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Authenticated user required'; END IF;
    SELECT * INTO v_attempt FROM public.test_attempts WHERE id = p_attempt_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'Attempt not found'; END IF;

    SELECT * INTO v_test FROM public.tests WHERE id = v_attempt.test_id;

    IF v_attempt.student_id IS DISTINCT FROM auth.uid() AND NOT v_is_teacher THEN
        RAISE EXCEPTION 'Unauthorized to view this review';
    END IF;

    IF v_attempt.status != 'SUBMITTED' AND v_attempt.status != 'EXPIRED' THEN
        RAISE EXCEPTION 'Attempt is not finalized yet';
    END IF;

    IF NOT v_is_teacher AND v_test.review_policy IS DISTINCT FROM 'AFTER_SUBMISSION' THEN
        RAISE EXCEPTION 'Review is not allowed for this test. Policy is: %', v_test.review_policy;
    END IF;

    RETURN QUERY
    SELECT
        tqs.question_id,
        tqs.section_name,
        tqs.content,
        CASE WHEN v_test.snapshot_contract_version=1 THEN tqs.marks::NUMERIC END as marks,
        CASE WHEN v_test.snapshot_contract_version=1 THEN tqs.negative_marks END,
        ans.selected_option_id,
        key.correct_option_id,
        (ans.selected_option_id = key.correct_option_id) as is_correct,
        (ans.selected_option_id IS NULL) as is_unanswered,
        CASE
            WHEN v_test.snapshot_contract_version<>1 THEN NULL::NUMERIC
            WHEN ans.selected_option_id IS NULL THEN 0::NUMERIC
            WHEN ans.selected_option_id = key.correct_option_id THEN tqs.marks::NUMERIC
            ELSE -tqs.negative_marks
        END as marks_awarded,
        (SELECT x.explanation FROM public.test_explanation_snapshots x WHERE x.test_id=tqs.test_id AND x.question_id=tqs.question_id)
    FROM public.test_question_snapshots tqs
    LEFT JOIN public.attempt_answers ans ON ans.attempt_id = p_attempt_id AND ans.question_id = tqs.question_id
    LEFT JOIN public.test_answer_key_snapshots key ON key.test_id = v_attempt.test_id AND key.question_id = tqs.question_id
    WHERE tqs.test_id = v_attempt.test_id
    ORDER BY tqs.section_order, tqs.sort_order, tqs.question_id;

END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp;

CREATE OR REPLACE FUNCTION public.get_attempt_section_performance(p_attempt_id UUID)
RETURNS TABLE (
    section_id UUID,
    section_name TEXT,
    subject_name TEXT,
    correct_count INT,
    incorrect_count INT,
    unanswered_count INT,
    score NUMERIC,
    max_score NUMERIC
) AS $$
DECLARE
    v_attempt RECORD;
    v_test RECORD;
    v_is_teacher BOOLEAN := public.is_teacher();
BEGIN
    IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Authenticated user required'; END IF;
    SELECT * INTO v_attempt FROM public.test_attempts WHERE id = p_attempt_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'Attempt not found'; END IF;

    SELECT * INTO v_test FROM public.tests WHERE id = v_attempt.test_id;

    IF v_attempt.student_id IS DISTINCT FROM auth.uid() AND NOT v_is_teacher THEN
        RAISE EXCEPTION 'Unauthorized to view this attempt performance';
    END IF;

    -- Prevent leaking correctness before completion/review gate
    IF v_attempt.status != 'SUBMITTED' AND v_attempt.status != 'EXPIRED' THEN
        RAISE EXCEPTION 'Attempt is not finalized yet';
    END IF;

    IF NOT v_is_teacher AND v_test.review_policy IS DISTINCT FROM 'AFTER_SUBMISSION' THEN
        RAISE EXCEPTION 'Review is not allowed for this test. Policy is: %', v_test.review_policy;
    END IF;

    IF v_test.snapshot_contract_version<>1 THEN RAISE EXCEPTION 'Legacy snapshot requires reconciliation'; END IF;
    RETURN QUERY
    SELECT
        tqs.section_id,
        tqs.section_name,
        tqs.subject_name,
        COUNT(CASE WHEN ans.selected_option_id = key.correct_option_id THEN 1 END)::INT as correct_count,
        COUNT(CASE WHEN ans.selected_option_id IS NOT NULL AND ans.selected_option_id != key.correct_option_id THEN 1 END)::INT as incorrect_count,
        COUNT(CASE WHEN ans.selected_option_id IS NULL THEN 1 END)::INT as unanswered_count,
        COALESCE(SUM(CASE
            WHEN ans.selected_option_id = key.correct_option_id THEN tqs.marks::NUMERIC
            WHEN ans.selected_option_id IS NOT NULL AND ans.selected_option_id != key.correct_option_id THEN -tqs.negative_marks
            ELSE 0
        END), 0) as score,
        COALESCE(SUM(tqs.marks::NUMERIC), 0) as max_score
    FROM public.test_question_snapshots tqs
    LEFT JOIN public.attempt_answers ans ON ans.attempt_id = p_attempt_id AND ans.question_id = tqs.question_id
    LEFT JOIN public.test_answer_key_snapshots key ON key.test_id = v_attempt.test_id AND key.question_id = tqs.question_id
    WHERE tqs.test_id = v_attempt.test_id
    GROUP BY tqs.section_id, tqs.section_name, tqs.subject_name;

END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp;

-- Explicit allowlist: revoke historical/default role ACLs on EVERY exam definer.
DO $$ DECLARE f record; BEGIN
 FOR f IN SELECT p.oid::regprocedure signature FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
 WHERE n.nspname='public' AND p.prosecdef LOOP
  -- This baseline has only exam definers. Refuse unknown additions, do not change Atlas functions.
  IF f.signature::text !~ '^(is_teacher|publish_test|start_test_attempt|save_attempt_answer|submit_test_attempt|evaluate_and_finalize_attempt|finalize_expired_attempts|get_attempt_review|get_attempt_section_performance|can_review_test)\(' THEN
    RAISE EXCEPTION 'Unrecognized definer: %, reconcile target before upgrade', f.signature;
  END IF;
  EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated, service_role',f.signature);
 END LOOP;
END $$;
GRANT EXECUTE ON FUNCTION public.is_teacher() TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.can_review_test(uuid), public.publish_test(uuid),
 public.start_test_attempt(uuid), public.save_attempt_answer(uuid,uuid,uuid,boolean,boolean),
 public.submit_test_attempt(uuid), public.finalize_expired_attempts(),
 public.get_attempt_review(uuid), public.get_attempt_section_performance(uuid) TO authenticated;
-- Evaluator has no API/service grant; only owner-owned checked RPCs call it.

-- RLS does not protect TRUNCATE. API roles have no bulk/designer privileges.
DO $$ DECLARE t record; BEGIN
 FOR t IN SELECT c.oid::regclass name FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
 WHERE n.nspname='public' AND c.relkind='r' LOOP
  EXECUTE format('REVOKE TRUNCATE, REFERENCES, TRIGGER ON TABLE %s FROM PUBLIC, anon, authenticated, service_role',t.name);
 END LOOP;
END $$;
REVOKE INSERT, UPDATE, DELETE ON public.test_question_snapshots, public.test_option_snapshots,
 public.test_answer_key_snapshots FROM PUBLIC,anon,authenticated,service_role;

-- Keep old syllabus topic identities until an explicit reviewed mapping is supplied.
ALTER TABLE public.questions DROP CONSTRAINT questions_topic_id_fkey;
ALTER TABLE public.questions ADD CONSTRAINT questions_legacy_topic_id_fkey
 FOREIGN KEY(legacy_topic_id) REFERENCES public.syllabus_topics(id) ON DELETE RESTRICT;

-- NULL-safe validation of explicitly supplied hierarchy; legacy_topic_id remains separate.
CREATE OR REPLACE FUNCTION public.validate_question_hierarchy()
RETURNS TRIGGER AS $$
DECLARE
    v_topic RECORD;
    v_chapter RECORD;
    v_syllabus RECORD;
BEGIN
    IF NEW.topic_id IS NOT NULL THEN
        IF NEW.chapter_id IS NULL THEN
            RAISE EXCEPTION 'If topic_id is provided, chapter_id must also be provided.';
        END IF;

        SELECT * INTO v_topic FROM public.topics WHERE id = NEW.topic_id;
        IF v_topic.chapter_id IS DISTINCT FROM NEW.chapter_id THEN
            RAISE EXCEPTION 'Topic does not belong to the selected chapter.';
        END IF;
    END IF;

    IF NEW.chapter_id IS NOT NULL THEN
        IF NEW.syllabus_id IS NULL THEN
            RAISE EXCEPTION 'If chapter_id is provided, syllabus_id must also be provided.';
        END IF;

        SELECT * INTO v_chapter FROM public.chapters WHERE id = NEW.chapter_id;
        IF v_chapter.syllabus_id IS DISTINCT FROM NEW.syllabus_id THEN
            RAISE EXCEPTION 'Chapter does not belong to the selected syllabus.';
        END IF;
    END IF;

    IF NEW.syllabus_id IS NOT NULL THEN
        IF NEW.level_id IS NULL THEN
            RAISE EXCEPTION 'If syllabus_id is provided, level_id must also be provided.';
        END IF;

        SELECT * INTO v_syllabus FROM public.syllabi WHERE id = NEW.syllabus_id;
        IF v_syllabus.level_id IS DISTINCT FROM NEW.level_id OR v_syllabus.subject_id IS DISTINCT FROM NEW.subject_id OR v_syllabus.exam_id IS DISTINCT FROM NEW.exam_id THEN
            RAISE EXCEPTION 'Syllabus does not match the question''s level, subject, or exam.';
        END IF;
    END IF;

    IF NEW.level_id IS NOT NULL THEN
        IF NOT EXISTS (SELECT 1 FROM public.exam_levels WHERE id = NEW.level_id AND exam_id = NEW.exam_id) THEN
            RAISE EXCEPTION 'Level does not belong to the selected exam.';
        END IF;
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;
