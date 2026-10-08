-- KSC Exam Contract Repair (Forward Migration)

-- 1. Fix questions.topic_id duplicate and mappings
ALTER TABLE public.questions RENAME COLUMN topic_id TO legacy_topic_id;
ALTER TABLE public.questions ADD COLUMN topic_id UUID REFERENCES public.topics(id) ON DELETE SET NULL;

-- 2. Freeze grading inputs by extending snapshots
ALTER TABLE public.test_question_snapshots ADD COLUMN negative_marks NUMERIC DEFAULT 0; ALTER TABLE public.test_question_snapshots ADD COLUMN subject_id UUID;
ALTER TABLE public.tests ADD COLUMN updated_at TIMESTAMPTZ DEFAULT NOW();

-- 3. Correct publish_test RPC to include missing snapshot data, freeze grading, atomicity, locking, and teacher-only auth
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

    -- Freeze Questions and Hierarchy labels
    FOR v_q IN 
        SELECT 
            tq.question_id, tq.section_id, 
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
        IF v_q.status != 'APPROVED' THEN
            RAISE EXCEPTION 'Cannot publish test. Question % is not approved.', v_q.question_id;
        END IF;
        
        -- Enforce complete options
        IF (SELECT COUNT(*) FROM public.question_options WHERE question_id = v_q.question_id) < 2 THEN
            RAISE EXCEPTION 'Cannot publish test. Question % must have at least 2 options.', v_q.question_id;
        END IF;

        -- Enforce answer key
        IF NOT EXISTS (SELECT 1 FROM public.question_answer_keys WHERE question_id = v_q.question_id) THEN
            RAISE EXCEPTION 'Cannot publish test. Question % has no answer key.', v_q.question_id;
        END IF;

        INSERT INTO public.test_question_snapshots (
            test_id, question_id, section_id, content, subject_id,
            marks, negative_marks,
            level_name, syllabus_name, chapter_name, topic_name
        ) VALUES (
            p_test_id, v_q.question_id, v_q.section_id, v_q.content, v_q.subject_id,
            v_q.marks, v_q.negative_marks,
            (SELECT name FROM public.exam_levels WHERE id = v_q.level_id),
            (SELECT name FROM public.syllabi WHERE id = v_q.syllabus_id),
            (SELECT name FROM public.chapters WHERE id = v_q.chapter_id),
            (SELECT name FROM public.topics WHERE id = v_q.topic_id)
        );

        -- Freeze Options
        FOR v_opt IN 
            SELECT id, content FROM public.question_options WHERE question_id = v_q.question_id
        LOOP
            INSERT INTO public.test_option_snapshots (test_id, question_id, original_option_id, content)
            VALUES (p_test_id, v_q.question_id, v_opt.id, v_opt.content);
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

    UPDATE public.tests SET is_published = true, status = 'PUBLISHED', updated_at = NOW() WHERE id = p_test_id;

    RETURN true;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- 4. Secure evaluate_and_finalize_attempt
-- Restrict to internal use by removing public execution rights
REVOKE ALL ON FUNCTION public.evaluate_and_finalize_attempt(UUID) FROM PUBLIC, authenticated, anon;

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
    IF v_attempt.status != 'IN_PROGRESS' THEN RETURN TRUE; END IF;

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
    SET status = 'SUBMITTED',
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
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
-- Ensure we re-revoke if CREATE OR REPLACE resets it, though it usually retains permissions. But to be safe:
REVOKE ALL ON FUNCTION public.evaluate_and_finalize_attempt(UUID) FROM PUBLIC, authenticated, anon;
GRANT EXECUTE ON FUNCTION public.evaluate_and_finalize_attempt(UUID) TO service_role;

-- 5. Secure submit_test_attempt (explicit authenticated-caller, NULL-safe ownership)
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
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- 6. Secure get_attempt_section_performance (prevent leaking before review gate, use frozen marks)
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

    IF NOT v_is_teacher AND v_test.review_policy != 'AFTER_SUBMISSION' THEN
        RAISE EXCEPTION 'Review is not allowed for this test. Policy is: %', v_test.review_policy;
    END IF;

    RETURN QUERY
    SELECT 
        eps.id as section_id,
        eps.section_name,
        es.name as subject_name,
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
    LEFT JOIN public.exam_pattern_sections eps ON eps.id = tqs.section_id
    LEFT JOIN public.exam_subjects es ON es.id = eps.subject_id
    LEFT JOIN public.attempt_answers ans ON ans.attempt_id = p_attempt_id AND ans.question_id = tqs.question_id
    LEFT JOIN public.test_answer_key_snapshots key ON key.test_id = v_attempt.test_id AND key.question_id = tqs.question_id
    WHERE tqs.test_id = v_attempt.test_id
    GROUP BY eps.id, eps.section_name, es.name;

END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- 7. Secure get_attempt_review (use frozen marks)
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
    marks_awarded NUMERIC
) AS $$
DECLARE
    v_attempt RECORD;
    v_test RECORD;
    v_is_teacher BOOLEAN := public.is_teacher();
BEGIN
    SELECT * INTO v_attempt FROM public.test_attempts WHERE id = p_attempt_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'Attempt not found'; END IF;
    
    SELECT * INTO v_test FROM public.tests WHERE id = v_attempt.test_id;

    IF v_attempt.student_id IS DISTINCT FROM auth.uid() AND NOT v_is_teacher THEN
        RAISE EXCEPTION 'Unauthorized to view this review';
    END IF;

    IF v_attempt.status != 'SUBMITTED' AND v_attempt.status != 'EXPIRED' THEN
        RAISE EXCEPTION 'Attempt is not finalized yet';
    END IF;

    IF NOT v_is_teacher AND v_test.review_policy != 'AFTER_SUBMISSION' THEN
        RAISE EXCEPTION 'Review is not allowed for this test. Policy is: %', v_test.review_policy;
    END IF;

    RETURN QUERY
    SELECT 
        tqs.question_id,
        eps.section_name,
        tqs.content,
        tqs.marks::NUMERIC as marks,
        tqs.negative_marks,
        ans.selected_option_id,
        key.correct_option_id,
        (ans.selected_option_id = key.correct_option_id) as is_correct,
        (ans.selected_option_id IS NULL) as is_unanswered,
        CASE 
            WHEN ans.selected_option_id IS NULL THEN 0::NUMERIC
            WHEN ans.selected_option_id = key.correct_option_id THEN tqs.marks::NUMERIC
            ELSE -tqs.negative_marks
        END as marks_awarded
    FROM public.test_question_snapshots tqs
    LEFT JOIN public.exam_pattern_sections eps ON eps.id = tqs.section_id
    LEFT JOIN public.attempt_answers ans ON ans.attempt_id = p_attempt_id AND ans.question_id = tqs.question_id
    LEFT JOIN public.test_answer_key_snapshots key ON key.test_id = v_attempt.test_id AND key.question_id = tqs.question_id
    WHERE tqs.test_id = v_attempt.test_id
    ORDER BY tqs.sort_order ASC;

END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- 8. Fix start_test_attempt NULL safety
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

    SELECT * INTO v_test FROM public.tests WHERE id = p_test_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Test not found.';
    END IF;
    
    IF NOT v_test.is_published THEN
        RAISE EXCEPTION 'Test is not published.';
    END IF;

    IF EXISTS (SELECT 1 FROM public.test_attempts WHERE test_id = p_test_id AND student_id = v_student_id) THEN
        RAISE EXCEPTION 'Attempt already exists for this student and test.';
    END IF;

    INSERT INTO public.test_attempts (test_id, student_id, status)
    VALUES (p_test_id, v_student_id, 'IN_PROGRESS')
    RETURNING id INTO v_attempt_id;

    RETURN v_attempt_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;


-- 9. Prevent deletion of published tests and tests with attempts
CREATE OR REPLACE FUNCTION public.prevent_published_test_deletion()
RETURNS TRIGGER AS $$
BEGIN
    IF OLD.is_published THEN
        RAISE EXCEPTION 'Cannot delete a published test.';
    END IF;
    IF EXISTS (SELECT 1 FROM public.test_attempts WHERE test_id = OLD.id) THEN
        RAISE EXCEPTION 'Cannot delete a test that has attempts.';
    END IF;
    RETURN OLD;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_prevent_published_test_deletion
BEFORE DELETE ON public.tests
FOR EACH ROW
EXECUTE FUNCTION public.prevent_published_test_deletion();

-- 10. Prevent editing frozen test properties (duration, pattern) if published
CREATE OR REPLACE FUNCTION public.prevent_published_test_edits()
RETURNS TRIGGER AS $$
BEGIN
    IF OLD.is_published THEN
        IF NEW.pattern_id IS DISTINCT FROM OLD.pattern_id 
        OR NEW.duration_minutes IS DISTINCT FROM OLD.duration_minutes
        OR NEW.total_marks IS DISTINCT FROM OLD.total_marks THEN
            RAISE EXCEPTION 'Cannot modify pattern or duration of a published test.';
        END IF;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_prevent_published_test_edits
BEFORE UPDATE ON public.tests
FOR EACH ROW
EXECUTE FUNCTION public.prevent_published_test_edits();

-- 11. Prevent modification/deletion of finalized test attempts
CREATE OR REPLACE FUNCTION public.prevent_finalized_attempt_edits()
RETURNS TRIGGER AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        IF OLD.status != 'IN_PROGRESS' THEN
            RAISE EXCEPTION 'Cannot delete a finalized test attempt.';
        END IF;
        RETURN OLD;
    END IF;

    IF TG_OP = 'UPDATE' THEN
        -- Only internal evaluator can change finalized state, but since it's an update trigger,
        -- we just prevent manual edits to the frozen score/stats by standard users unless it's the internal evaluator.
        -- Actually, the evaluator changes status FROM IN_PROGRESS TO SUBMITTED.
        -- So if OLD.status != 'IN_PROGRESS', it's already finalized, no further updates allowed.
        IF OLD.status != 'IN_PROGRESS' THEN
            RAISE EXCEPTION 'Cannot modify a finalized test attempt.';
        END IF;
    END IF;
    
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_prevent_finalized_attempt_edits
BEFORE UPDATE OR DELETE ON public.test_attempts
FOR EACH ROW
EXECUTE FUNCTION public.prevent_finalized_attempt_edits();
