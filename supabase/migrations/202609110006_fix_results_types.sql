-- Fix returned types for Result RPCs

DROP FUNCTION IF EXISTS public.get_attempt_section_performance(UUID);

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
        END), 0::NUMERIC)::NUMERIC as score,
        COALESCE(SUM(eps.marks_per_question), 0::NUMERIC)::NUMERIC as max_score
    FROM public.test_question_snapshots tqs
    JOIN public.exam_pattern_sections eps ON eps.id = tqs.section_id
    LEFT JOIN public.exam_subjects es ON es.id = eps.subject_id
    LEFT JOIN public.attempt_answers ans ON ans.attempt_id = p_attempt_id AND ans.question_id = tqs.question_id
    LEFT JOIN public.test_answer_key_snapshots key ON key.test_id = v_attempt.test_id AND key.question_id = tqs.question_id
    WHERE tqs.test_id = v_attempt.test_id
    GROUP BY eps.id, eps.section_name, es.name;

END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;


DROP FUNCTION IF EXISTS public.get_attempt_review(UUID);

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

    IF v_attempt.student_id != auth.uid() AND NOT v_is_teacher THEN
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
        eps.marks_per_question::NUMERIC as marks,
        eps.negative_marks::NUMERIC,
        ans.selected_option_id,
        key.correct_option_id,
        (ans.selected_option_id = key.correct_option_id) as is_correct,
        (ans.selected_option_id IS NULL) as is_unanswered,
        CASE 
            WHEN ans.selected_option_id IS NULL THEN 0::NUMERIC
            WHEN ans.selected_option_id = key.correct_option_id THEN eps.marks_per_question::NUMERIC
            ELSE -eps.negative_marks::NUMERIC
        END as marks_awarded
    FROM public.test_question_snapshots tqs
    JOIN public.exam_pattern_sections eps ON eps.id = tqs.section_id
    LEFT JOIN public.attempt_answers ans ON ans.attempt_id = p_attempt_id AND ans.question_id = tqs.question_id
    LEFT JOIN public.test_answer_key_snapshots key ON key.test_id = v_attempt.test_id AND key.question_id = tqs.question_id
    WHERE tqs.test_id = v_attempt.test_id
    ORDER BY tqs.sort_order ASC;

END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
