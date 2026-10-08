-- Test Builder and Exam Pattern Engine

CREATE TABLE public.exam_patterns (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    exam_id UUID REFERENCES public.exams(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    description TEXT,
    status TEXT DEFAULT 'DRAFT', -- DRAFT, ACTIVE, ARCHIVED
    total_duration_minutes INTEGER,
    total_marks INTEGER,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE public.exam_pattern_sections (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    pattern_id UUID REFERENCES public.exam_patterns(id) ON DELETE CASCADE,
    subject_id UUID REFERENCES public.exam_subjects(id) ON DELETE CASCADE,
    section_name TEXT NOT NULL,
    display_order INTEGER DEFAULT 0,
    question_count INTEGER NOT NULL,
    marks_per_question INTEGER NOT NULL,
    negative_marks NUMERIC DEFAULT 0
);

-- Modify existing tests and test_questions
ALTER TABLE public.tests ADD COLUMN pattern_id UUID REFERENCES public.exam_patterns(id) ON DELETE SET NULL;
ALTER TABLE public.tests ADD COLUMN status TEXT DEFAULT 'DRAFT'; -- DRAFT, PUBLISHED, ARCHIVED
ALTER TABLE public.test_questions ADD COLUMN section_id UUID REFERENCES public.exam_pattern_sections(id) ON DELETE CASCADE;

-- Snapshots for historical stability
CREATE TABLE public.test_question_snapshots (
    test_id UUID REFERENCES public.tests(id) ON DELETE CASCADE,
    question_id UUID REFERENCES public.questions(id) ON DELETE SET NULL,
    section_id UUID REFERENCES public.exam_pattern_sections(id) ON DELETE SET NULL,
    content TEXT NOT NULL,
    explanation TEXT,
    difficulty TEXT,
    marks INTEGER,
    sort_order INTEGER DEFAULT 0,
    PRIMARY KEY (test_id, question_id)
);

CREATE TABLE public.test_option_snapshots (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    test_id UUID REFERENCES public.tests(id) ON DELETE CASCADE,
    question_id UUID REFERENCES public.questions(id) ON DELETE SET NULL,
    original_option_id UUID,
    content TEXT NOT NULL,
    sort_order INTEGER DEFAULT 0
);

CREATE TABLE public.test_answer_key_snapshots (
    test_id UUID REFERENCES public.tests(id) ON DELETE CASCADE,
    question_id UUID REFERENCES public.questions(id) ON DELETE SET NULL,
    correct_option_id UUID REFERENCES public.test_option_snapshots(id) ON DELETE CASCADE,
    PRIMARY KEY (test_id, question_id)
);

-- RLS
ALTER TABLE public.exam_patterns ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.exam_pattern_sections ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.test_question_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.test_option_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.test_answer_key_snapshots ENABLE ROW LEVEL SECURITY;

-- Patterns
CREATE POLICY "Anyone can read active patterns" ON public.exam_patterns FOR SELECT USING (status = 'ACTIVE' OR public.is_teacher());
CREATE POLICY "Teachers can manage patterns" ON public.exam_patterns FOR ALL USING (public.is_teacher());

CREATE POLICY "Anyone can read pattern sections" ON public.exam_pattern_sections FOR SELECT USING (TRUE);
CREATE POLICY "Teachers can manage pattern sections" ON public.exam_pattern_sections FOR ALL USING (public.is_teacher());

-- Snapshots: Students read published ONLY
CREATE POLICY "Students can read published question snapshots" ON public.test_question_snapshots FOR SELECT USING (
    EXISTS (SELECT 1 FROM public.tests WHERE id = test_id AND is_published = TRUE) OR public.is_teacher()
);
CREATE POLICY "Students can read published option snapshots" ON public.test_option_snapshots FOR SELECT USING (
    EXISTS (SELECT 1 FROM public.tests WHERE id = test_id AND is_published = TRUE) OR public.is_teacher()
);

-- Answer key snapshots: Teachers only!
CREATE POLICY "Teachers can read answer key snapshots" ON public.test_answer_key_snapshots FOR SELECT USING (public.is_teacher());
CREATE POLICY "Teachers can manage answer key snapshots" ON public.test_answer_key_snapshots FOR ALL USING (public.is_teacher());

-- Teachers manage all snapshots
CREATE POLICY "Teachers can manage question snapshots" ON public.test_question_snapshots FOR ALL USING (public.is_teacher());
CREATE POLICY "Teachers can manage option snapshots" ON public.test_option_snapshots FOR ALL USING (public.is_teacher());

-- RPC for atomic publishing
CREATE OR REPLACE FUNCTION public.publish_test(p_test_id UUID)
RETURNS BOOLEAN AS $$
DECLARE
    v_test RECORD;
    v_q RECORD;
    v_opt RECORD;
    v_correct_opt_id UUID;
    v_new_opt_id UUID;
BEGIN
    -- 1. Check if test exists and is not already published
    SELECT * INTO v_test FROM public.tests WHERE id = p_test_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Test not found.';
    END IF;

    IF v_test.is_published THEN
        RETURN TRUE; -- Already published
    END IF;

    -- 2. Create Snapshots
    INSERT INTO public.test_question_snapshots (test_id, question_id, section_id, content, explanation, difficulty, marks, sort_order)
    SELECT tq.test_id, tq.question_id, tq.section_id, q.content, q.explanation, q.difficulty, q.marks, tq.sort_order
    FROM public.test_questions tq
    JOIN public.questions q ON q.id = tq.question_id
    WHERE tq.test_id = p_test_id;

    FOR v_q IN SELECT question_id FROM public.test_questions WHERE test_id = p_test_id LOOP
        SELECT correct_option_id INTO v_correct_opt_id FROM public.question_answer_keys WHERE question_id = v_q.question_id;

        FOR v_opt IN SELECT id, content, sort_order FROM public.question_options WHERE question_id = v_q.question_id LOOP
            INSERT INTO public.test_option_snapshots (test_id, question_id, original_option_id, content, sort_order)
            VALUES (p_test_id, v_q.question_id, v_opt.id, v_opt.content, v_opt.sort_order)
            RETURNING id INTO v_new_opt_id;

            IF v_opt.id = v_correct_opt_id THEN
                INSERT INTO public.test_answer_key_snapshots (test_id, question_id, correct_option_id)
                VALUES (p_test_id, v_q.question_id, v_new_opt_id);
            END IF;
        END LOOP;
    END LOOP;

    -- 3. Update test state
    UPDATE public.tests 
    SET is_published = TRUE, status = 'PUBLISHED' 
    WHERE id = p_test_id;

    RETURN TRUE;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
