-- Phase K: Results & Performance Foundation

-- 1. Review Policy on Tests
ALTER TABLE public.tests ADD COLUMN IF NOT EXISTS review_policy TEXT DEFAULT 'SUMMARY_ONLY';

-- 2. Expired offline attempts auto-finalization
-- Safe RPC to sweep and finalize any expired attempts
CREATE OR REPLACE FUNCTION public.finalize_expired_attempts() 
RETURNS INT AS $$
DECLARE
    v_attempt RECORD;
    v_count INT := 0;
BEGIN
    FOR v_attempt IN 
        SELECT id FROM public.test_attempts 
        WHERE status = 'IN_PROGRESS' AND expires_at IS NOT NULL AND expires_at <= NOW()
    LOOP
        -- Re-use the trusted submission logic.
        -- We temporarily bypass the auth.uid() check inside submit_test_attempt if we call it from a privileged context,
        -- BUT submit_test_attempt enforces v_attempt.student_id != v_student_id.
        -- Wait, submit_test_attempt relies on auth.uid() = student_id!
        -- To fix this securely, we will refactor the core evaluation into a private helper function.
        -- However, PostgreSQL doesn't easily let us bypass auth.uid() in SECURITY DEFINER without changing the role.
        -- Let's do it right here inline for sweeping, using the exact same logic.
        PERFORM public.evaluate_and_finalize_attempt(v_attempt.id);
        v_count := v_count + 1;
    END LOOP;
    
    RETURN v_count;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;


-- Refactor submission evaluation into a reusable internal function
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
            eps.marks_per_question as marks, 
            eps.negative_marks,
            ans.selected_option_id,
            key.correct_option_id
        FROM public.test_question_snapshots tqs
        JOIN public.exam_pattern_sections eps ON eps.id = tqs.section_id
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

-- Update original submit_test_attempt to use the refactored function
CREATE OR REPLACE FUNCTION public.submit_test_attempt(p_attempt_id UUID) 
RETURNS BOOLEAN AS $$
DECLARE
    v_student_id UUID := auth.uid();
    v_attempt RECORD;
BEGIN
    SELECT * INTO v_attempt FROM public.test_attempts WHERE id = p_attempt_id;
    IF NOT FOUND OR v_attempt.student_id != v_student_id THEN
        RAISE EXCEPTION 'Attempt not found or unauthorized.';
    END IF;

    RETURN public.evaluate_and_finalize_attempt(p_attempt_id);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;


-- 3. Section/Subject Performance RPC
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
    v_is_teacher BOOLEAN := public.is_teacher();
BEGIN
    SELECT * INTO v_attempt FROM public.test_attempts WHERE id = p_attempt_id;
    
    IF NOT FOUND THEN RAISE EXCEPTION 'Attempt not found'; END IF;
    
    IF v_attempt.student_id != auth.uid() AND NOT v_is_teacher THEN
        RAISE EXCEPTION 'Unauthorized to view this attempt performance';
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
            WHEN ans.selected_option_id = key.correct_option_id THEN eps.marks_per_question 
            WHEN ans.selected_option_id IS NOT NULL AND ans.selected_option_id != key.correct_option_id THEN -eps.negative_marks 
            ELSE 0 
        END), 0) as score,
        COALESCE(SUM(eps.marks_per_question), 0) as max_score
    FROM public.test_question_snapshots tqs
    JOIN public.exam_pattern_sections eps ON eps.id = tqs.section_id
    LEFT JOIN public.exam_subjects es ON es.id = eps.subject_id
    LEFT JOIN public.attempt_answers ans ON ans.attempt_id = p_attempt_id AND ans.question_id = tqs.question_id
    LEFT JOIN public.test_answer_key_snapshots key ON key.test_id = v_attempt.test_id AND key.question_id = tqs.question_id
    WHERE tqs.test_id = v_attempt.test_id
    GROUP BY eps.id, eps.section_name, es.name;

END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;


-- 4. Attempt Review RPC
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

    -- Security checks
    IF v_attempt.student_id != auth.uid() AND NOT v_is_teacher THEN
        RAISE EXCEPTION 'Unauthorized to view this review';
    END IF;

    IF v_attempt.status != 'SUBMITTED' AND v_attempt.status != 'EXPIRED' THEN
        RAISE EXCEPTION 'Attempt is not finalized yet';
    END IF;

    -- Review policy enforcement for students
    IF NOT v_is_teacher AND v_test.review_policy != 'AFTER_SUBMISSION' THEN
        RAISE EXCEPTION 'Review is not allowed for this test. Policy is: %', v_test.review_policy;
    END IF;

    RETURN QUERY
    SELECT 
        tqs.question_id,
        eps.section_name,
        tqs.content,
        eps.marks_per_question as marks,
        eps.negative_marks,
        ans.selected_option_id,
        key.correct_option_id,
        (ans.selected_option_id = key.correct_option_id) as is_correct,
        (ans.selected_option_id IS NULL) as is_unanswered,
        CASE 
            WHEN ans.selected_option_id IS NULL THEN 0::NUMERIC
            WHEN ans.selected_option_id = key.correct_option_id THEN eps.marks_per_question
            ELSE -eps.negative_marks
        END as marks_awarded
    FROM public.test_question_snapshots tqs
    JOIN public.exam_pattern_sections eps ON eps.id = tqs.section_id
    LEFT JOIN public.attempt_answers ans ON ans.attempt_id = p_attempt_id AND ans.question_id = tqs.question_id
    LEFT JOIN public.test_answer_key_snapshots key ON key.test_id = v_attempt.test_id AND key.question_id = tqs.question_id
    WHERE tqs.test_id = v_attempt.test_id
    ORDER BY tqs.sort_order ASC;

END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
