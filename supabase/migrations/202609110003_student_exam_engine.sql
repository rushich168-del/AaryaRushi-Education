-- Student Exam Engine Migration

-- Modify test_attempts
ALTER TABLE public.test_attempts ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;
ALTER TABLE public.test_attempts ADD COLUMN IF NOT EXISTS submitted_at TIMESTAMPTZ;
ALTER TABLE public.test_attempts ADD COLUMN IF NOT EXISTS max_score NUMERIC;
ALTER TABLE public.test_attempts ADD COLUMN IF NOT EXISTS correct_count INTEGER;
ALTER TABLE public.test_attempts ADD COLUMN IF NOT EXISTS incorrect_count INTEGER;
ALTER TABLE public.test_attempts ADD COLUMN IF NOT EXISTS unanswered_count INTEGER;
ALTER TABLE public.test_attempts ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();

-- Alter score column type if possible, or just leave it as INTEGER if it was INTEGER. Let's alter to numeric.
ALTER TABLE public.test_attempts ALTER COLUMN score TYPE NUMERIC;

-- Create index
CREATE UNIQUE INDEX IF NOT EXISTS idx_test_attempts_student_test ON public.test_attempts(student_id, test_id);

-- Modify attempt_answers
ALTER TABLE public.attempt_answers ADD COLUMN IF NOT EXISTS is_marked_for_review BOOLEAN DEFAULT false;
ALTER TABLE public.attempt_answers ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();

-- Drop constraints if they interfere (e.g. ON DELETE CASCADE from questions, we want attempt_answers to survive even if question is deleted, because we have snapshots now)
ALTER TABLE public.attempt_answers DROP CONSTRAINT IF EXISTS attempt_answers_question_id_fkey;
ALTER TABLE public.attempt_answers DROP CONSTRAINT IF EXISTS attempt_answers_selected_option_id_fkey;

CREATE UNIQUE INDEX IF NOT EXISTS idx_attempt_answers_attempt_question ON public.attempt_answers(attempt_id, question_id);

-- Ensure RLS on test_attempts and attempt_answers
ALTER TABLE public.test_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.attempt_answers ENABLE ROW LEVEL SECURITY;

-- Drop ANY old insecure policies from foundation
DROP POLICY IF EXISTS "Students can read own attempts" ON public.test_attempts;
DROP POLICY IF EXISTS "Students can insert own attempts" ON public.test_attempts;
DROP POLICY IF EXISTS "Students can update own attempts" ON public.test_attempts;
DROP POLICY IF EXISTS "Teachers can view all attempts" ON public.test_attempts;

DROP POLICY IF EXISTS "Students can manage own answers" ON public.attempt_answers;
DROP POLICY IF EXISTS "Teachers can view all answers" ON public.attempt_answers;

DROP POLICY IF EXISTS "Students read own attempts" ON public.test_attempts;
CREATE POLICY "Students read own attempts" ON public.test_attempts FOR SELECT USING (auth.uid() = student_id);

DROP POLICY IF EXISTS "Teachers read all attempts" ON public.test_attempts;
CREATE POLICY "Teachers read all attempts" ON public.test_attempts FOR SELECT USING (public.is_teacher());

DROP POLICY IF EXISTS "Students read own answers" ON public.attempt_answers;
CREATE POLICY "Students read own answers" ON public.attempt_answers FOR SELECT USING (
    EXISTS (SELECT 1 FROM public.test_attempts WHERE id = attempt_id AND student_id = auth.uid())
);

DROP POLICY IF EXISTS "Teachers read all answers" ON public.attempt_answers;
CREATE POLICY "Teachers read all answers" ON public.attempt_answers FOR SELECT USING (public.is_teacher());

-- Functions

CREATE OR REPLACE FUNCTION public.start_test_attempt(p_test_id UUID) 
RETURNS UUID AS $$
DECLARE
    v_student_id UUID := auth.uid();
    v_test RECORD;
    v_attempt_id UUID;
    v_expires_at TIMESTAMPTZ;
BEGIN
    -- Only students
    IF NOT EXISTS (SELECT 1 FROM public.student_profiles WHERE id = v_student_id) THEN
        RAISE EXCEPTION 'Only registered students can start tests.';
    END IF;

    -- Validate Test
    SELECT * INTO v_test FROM public.tests WHERE id = p_test_id AND is_published = TRUE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Test is not published or does not exist.';
    END IF;

    -- Resume existing attempt if present
    SELECT id INTO v_attempt_id FROM public.test_attempts WHERE test_id = p_test_id AND student_id = v_student_id;
    IF FOUND THEN
        RETURN v_attempt_id;
    END IF;

    -- Calculate exact authoritative expiry
    IF v_test.duration_minutes IS NOT NULL THEN
        v_expires_at := NOW() + (v_test.duration_minutes || ' minutes')::interval;
    END IF;

    -- Atomically insert
    INSERT INTO public.test_attempts (test_id, student_id, expires_at)
    VALUES (p_test_id, v_student_id, v_expires_at)
    RETURNING id INTO v_attempt_id;

    RETURN v_attempt_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;


CREATE OR REPLACE FUNCTION public.save_attempt_answer(
    p_attempt_id UUID, p_question_id UUID, p_option_id UUID, p_is_marked BOOLEAN, p_clear BOOLEAN
) 
RETURNS BOOLEAN AS $$
DECLARE
    v_student_id UUID := auth.uid();
    v_attempt RECORD;
BEGIN
    -- Secure lock attempt row
    SELECT * INTO v_attempt FROM public.test_attempts WHERE id = p_attempt_id FOR UPDATE;
    
    IF NOT FOUND OR v_attempt.student_id != v_student_id THEN
        RAISE EXCEPTION 'Attempt not found or unauthorized.';
    END IF;

    IF v_attempt.status != 'IN_PROGRESS' THEN
        RAISE EXCEPTION 'Attempt is finalized. Cannot save answers.';
    END IF;

    IF v_attempt.expires_at IS NOT NULL AND NOW() > v_attempt.expires_at THEN
        RAISE EXCEPTION 'Attempt has expired.';
    END IF;

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
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;


CREATE OR REPLACE FUNCTION public.submit_test_attempt(p_attempt_id UUID) 
RETURNS BOOLEAN AS $$
DECLARE
    v_student_id UUID := auth.uid();
    v_attempt RECORD;
    v_q RECORD;
    v_correct_count INT := 0;
    v_incorrect_count INT := 0;
    v_unanswered_count INT := 0;
    v_score NUMERIC := 0;
    v_max_score NUMERIC := 0;
BEGIN
    -- Secure lock attempt row
    SELECT * INTO v_attempt FROM public.test_attempts WHERE id = p_attempt_id FOR UPDATE;
    
    IF NOT FOUND OR v_attempt.student_id != v_student_id THEN
        RAISE EXCEPTION 'Attempt not found or unauthorized.';
    END IF;

    IF v_attempt.status != 'IN_PROGRESS' THEN
        RETURN TRUE; -- Idempotent return
    END IF;

    -- Evaluate securely using snapshot data only
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

    -- Finalize status and result
    UPDATE public.test_attempts 
    SET status = 'SUBMITTED',
        submitted_at = NOW(),
        completed_at = NOW(), -- for backward compatibility if used
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
