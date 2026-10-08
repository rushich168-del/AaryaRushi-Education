-- Phase L: Content / Syllabus Hierarchy + Topic Metadata Foundation

-- 1. Levels (exam_levels)
CREATE TABLE public.exam_levels (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    exam_id UUID NOT NULL REFERENCES public.exams(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    code TEXT,
    display_order INTEGER DEFAULT 0,
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(exam_id, name)
);

ALTER TABLE public.exam_levels ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Public can read active exam levels" ON public.exam_levels FOR SELECT USING (is_active = true);
CREATE POLICY "Teachers manage exam levels" ON public.exam_levels FOR ALL USING (public.is_teacher());

-- 2. Syllabi
CREATE TABLE public.syllabi (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    exam_id UUID NOT NULL REFERENCES public.exams(id) ON DELETE CASCADE,
    level_id UUID NOT NULL REFERENCES public.exam_levels(id) ON DELETE CASCADE,
    subject_id UUID NOT NULL REFERENCES public.exam_subjects(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    description TEXT,
    status TEXT DEFAULT 'DRAFT' CHECK (status IN ('DRAFT', 'ACTIVE', 'ARCHIVED')),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE public.syllabi ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Public can read active syllabi" ON public.syllabi FOR SELECT USING (status = 'ACTIVE');
CREATE POLICY "Teachers manage syllabi" ON public.syllabi FOR ALL USING (public.is_teacher());

-- 3. Chapters
CREATE TABLE public.chapters (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    syllabus_id UUID NOT NULL REFERENCES public.syllabi(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    description TEXT,
    display_order INTEGER DEFAULT 0,
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(id, syllabus_id) -- Enable composite FK from topics
);

ALTER TABLE public.chapters ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Public can read active chapters" ON public.chapters FOR SELECT USING (is_active = true);
CREATE POLICY "Teachers manage chapters" ON public.chapters FOR ALL USING (public.is_teacher());

-- 4. Topics
CREATE TABLE public.topics (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    chapter_id UUID NOT NULL REFERENCES public.chapters(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    description TEXT,
    display_order INTEGER DEFAULT 0,
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(id, chapter_id) -- Enable composite FK from questions
);

ALTER TABLE public.topics ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Public can read active topics" ON public.topics FOR SELECT USING (is_active = true);
CREATE POLICY "Teachers manage topics" ON public.topics FOR ALL USING (public.is_teacher());


-- 5. Extend Questions Table with Hierarchy
-- Adding nullable references so legacy questions aren't broken.
-- We can't strictly enforce composite FKs (topic->chapter->syllabus->subject->level->exam) across 5 layers easily
-- without massive schema bloat on `questions`. We will add the foreign keys individually, 
-- and rely on application logic to ensure combinations are valid.
-- Wait, the prompt says: "Database integrity must remain authoritative. ... Database must reject invalid combinations."
-- Let's create a trigger to validate the hierarchy.

ALTER TABLE public.questions ADD COLUMN level_id UUID REFERENCES public.exam_levels(id) ON DELETE SET NULL;
ALTER TABLE public.questions ADD COLUMN syllabus_id UUID REFERENCES public.syllabi(id) ON DELETE SET NULL;
ALTER TABLE public.questions ADD COLUMN chapter_id UUID REFERENCES public.chapters(id) ON DELETE SET NULL;
-- [RECONCILED BASELINE] Commented out to allow replay. Fixed in 0008: ALTER TABLE public.questions ADD COLUMN topic_id UUID REFERENCES public.topics(id) ON DELETE SET NULL;

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
        IF v_topic.chapter_id != NEW.chapter_id THEN
            RAISE EXCEPTION 'Topic does not belong to the selected chapter.';
        END IF;
    END IF;

    IF NEW.chapter_id IS NOT NULL THEN
        IF NEW.syllabus_id IS NULL THEN
            RAISE EXCEPTION 'If chapter_id is provided, syllabus_id must also be provided.';
        END IF;
        
        SELECT * INTO v_chapter FROM public.chapters WHERE id = NEW.chapter_id;
        IF v_chapter.syllabus_id != NEW.syllabus_id THEN
            RAISE EXCEPTION 'Chapter does not belong to the selected syllabus.';
        END IF;
    END IF;

    IF NEW.syllabus_id IS NOT NULL THEN
        IF NEW.level_id IS NULL THEN
            RAISE EXCEPTION 'If syllabus_id is provided, level_id must also be provided.';
        END IF;
        
        SELECT * INTO v_syllabus FROM public.syllabi WHERE id = NEW.syllabus_id;
        IF v_syllabus.level_id != NEW.level_id OR v_syllabus.subject_id != NEW.subject_id OR v_syllabus.exam_id != NEW.exam_id THEN
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

CREATE TRIGGER trigger_validate_question_hierarchy
BEFORE INSERT OR UPDATE ON public.questions
FOR EACH ROW
EXECUTE FUNCTION public.validate_question_hierarchy();

-- 6. Extend Exam Patterns
ALTER TABLE public.exam_patterns ADD COLUMN level_id UUID REFERENCES public.exam_levels(id) ON DELETE SET NULL;
-- Enforce that pattern's level belongs to the exam
CREATE OR REPLACE FUNCTION public.validate_pattern_hierarchy()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.level_id IS NOT NULL THEN
        IF NOT EXISTS (SELECT 1 FROM public.exam_levels WHERE id = NEW.level_id AND exam_id = NEW.exam_id) THEN
            RAISE EXCEPTION 'Level does not belong to the selected exam.';
        END IF;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_validate_pattern_hierarchy
BEFORE INSERT OR UPDATE ON public.exam_patterns
FOR EACH ROW
EXECUTE FUNCTION public.validate_pattern_hierarchy();


-- 7. Extend Published Test Question Snapshots
ALTER TABLE public.test_question_snapshots ADD COLUMN level_name TEXT;
ALTER TABLE public.test_question_snapshots ADD COLUMN syllabus_name TEXT;
ALTER TABLE public.test_question_snapshots ADD COLUMN chapter_name TEXT;
ALTER TABLE public.test_question_snapshots ADD COLUMN topic_name TEXT;

-- 8. Enhance publish_test RPC to include hierarchy names in snapshots
-- We need to drop or replace the publish_test RPC from Phase I to capture the new metadata.
-- Luckily we can use CREATE OR REPLACE FUNCTION.
CREATE OR REPLACE FUNCTION public.publish_test(p_test_id UUID) 
RETURNS BOOLEAN AS $$
DECLARE
    v_test RECORD;
    v_q RECORD;
    v_opt RECORD;
BEGIN
    SELECT * INTO v_test FROM public.tests WHERE id = p_test_id;
    IF v_test.is_published THEN
        RAISE EXCEPTION 'Test is already published.';
    END IF;

    -- Freeze Questions and Hierarchy labels
    FOR v_q IN 
        SELECT 
            tq.question_id, tq.section_id, 
            q.content, q.subject_id, 
            q.level_id, q.syllabus_id, q.chapter_id, q.topic_id
        FROM public.test_questions tq
        JOIN public.questions q ON q.id = tq.question_id
        WHERE tq.test_id = p_test_id
    LOOP
        INSERT INTO public.test_question_snapshots (
            test_id, question_id, section_id, content, subject_id,
            level_name, syllabus_name, chapter_name, topic_name
        ) VALUES (
            p_test_id, v_q.question_id, v_q.section_id, v_q.content, v_q.subject_id,
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

-- Indexes for performance
CREATE INDEX idx_exam_levels_exam ON public.exam_levels(exam_id);
CREATE INDEX idx_syllabi_exam_level_subject ON public.syllabi(exam_id, level_id, subject_id);
CREATE INDEX idx_chapters_syllabus ON public.chapters(syllabus_id);
CREATE INDEX idx_topics_chapter ON public.topics(chapter_id);
CREATE INDEX idx_questions_hierarchy ON public.questions(exam_id, subject_id, level_id, syllabus_id, chapter_id, topic_id);
