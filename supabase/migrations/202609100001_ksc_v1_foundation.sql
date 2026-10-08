-- KSC V1 Foundation Architecture - With RLS

-- Roles and Profiles
CREATE TABLE public.student_profiles (
    id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    full_name TEXT NOT NULL,
    class_standard TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE public.teacher_profiles (
    id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    full_name TEXT NOT NULL,
    role TEXT DEFAULT 'teacher', -- admin or teacher
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Exams Architecture
CREATE TABLE public.exams (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    slug TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    description TEXT,
    eligibility TEXT,
    target_class TEXT,
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE public.exam_subjects (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    exam_id UUID REFERENCES public.exams(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    description TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE public.syllabus_topics (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    subject_id UUID REFERENCES public.exam_subjects(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    description TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Question Bank
CREATE TABLE public.questions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    exam_id UUID REFERENCES public.exams(id) ON DELETE SET NULL,
    subject_id UUID REFERENCES public.exam_subjects(id) ON DELETE SET NULL,
    topic_id UUID REFERENCES public.syllabus_topics(id) ON DELETE SET NULL,
    
    question_type TEXT NOT NULL DEFAULT 'MCQ',
    difficulty TEXT NOT NULL DEFAULT 'MEDIUM',
    marks INTEGER DEFAULT 1,
    
    content TEXT NOT NULL,
    explanation TEXT,
    source_reference TEXT,
    
    status TEXT NOT NULL DEFAULT 'DRAFT', -- DRAFT, AI_GENERATED, UNDER_REVIEW, APPROVED, REJECTED, ARCHIVED
    generated_by_ai BOOLEAN DEFAULT FALSE,
    created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Answer key separated to ensure students can NEVER fetch it accidentally via normal queries
CREATE TABLE public.question_options (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    question_id UUID REFERENCES public.questions(id) ON DELETE CASCADE,
    content TEXT NOT NULL,
    sort_order INTEGER DEFAULT 0
);

CREATE TABLE public.question_answer_keys (
    question_id UUID PRIMARY KEY REFERENCES public.questions(id) ON DELETE CASCADE,
    correct_option_id UUID REFERENCES public.question_options(id) ON DELETE CASCADE
);

-- Tests and Exams
CREATE TABLE public.tests (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    exam_id UUID REFERENCES public.exams(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    description TEXT,
    duration_minutes INTEGER,
    total_marks INTEGER,
    is_published BOOLEAN DEFAULT FALSE,
    created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE public.test_questions (
    test_id UUID REFERENCES public.tests(id) ON DELETE CASCADE,
    question_id UUID REFERENCES public.questions(id) ON DELETE CASCADE,
    sort_order INTEGER DEFAULT 0,
    PRIMARY KEY (test_id, question_id)
);

-- Student Attempts
CREATE TABLE public.test_attempts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    test_id UUID REFERENCES public.tests(id) ON DELETE CASCADE,
    student_id UUID REFERENCES public.student_profiles(id) ON DELETE CASCADE,
    started_at TIMESTAMPTZ DEFAULT NOW(),
    completed_at TIMESTAMPTZ,
    score INTEGER DEFAULT 0,
    status TEXT DEFAULT 'IN_PROGRESS' -- IN_PROGRESS, COMPLETED
);

CREATE TABLE public.attempt_answers (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    attempt_id UUID REFERENCES public.test_attempts(id) ON DELETE CASCADE,
    question_id UUID REFERENCES public.questions(id) ON DELETE CASCADE,
    selected_option_id UUID REFERENCES public.question_options(id) ON DELETE SET NULL,
    time_taken_seconds INTEGER,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- RLS POLICIES

ALTER TABLE public.student_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.teacher_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.exams ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.exam_subjects ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.syllabus_topics ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.questions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.question_options ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.question_answer_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.test_questions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.test_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.attempt_answers ENABLE ROW LEVEL SECURITY;

-- Helper Function for Teacher Role
CREATE OR REPLACE FUNCTION public.is_teacher()
RETURNS BOOLEAN AS $$
BEGIN
  RETURN EXISTS (
    SELECT 1 FROM public.teacher_profiles WHERE id = auth.uid()
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- Profiles
CREATE POLICY "Students can read own profile" ON public.student_profiles FOR SELECT USING (auth.uid() = id);
CREATE POLICY "Teachers can read all student profiles" ON public.student_profiles FOR SELECT USING (public.is_teacher());

CREATE POLICY "Teachers can read own profile" ON public.teacher_profiles FOR SELECT USING (auth.uid() = id);
CREATE POLICY "Teachers can read all teacher profiles" ON public.teacher_profiles FOR SELECT USING (public.is_teacher());

-- Catalog (Public Read + Teacher Manage)
CREATE POLICY "Anyone can read active exams" ON public.exams FOR SELECT USING (is_active = TRUE OR public.is_teacher());
CREATE POLICY "Teachers can manage exams" ON public.exams FOR ALL USING (public.is_teacher());

CREATE POLICY "Anyone can read subjects" ON public.exam_subjects FOR SELECT USING (TRUE);
CREATE POLICY "Teachers can manage subjects" ON public.exam_subjects FOR ALL USING (public.is_teacher());

CREATE POLICY "Anyone can read syllabus" ON public.syllabus_topics FOR SELECT USING (TRUE);
CREATE POLICY "Teachers can manage syllabus" ON public.syllabus_topics FOR ALL USING (public.is_teacher());

-- Question Bank (Strict RLS)
-- Students can only see APPROVED questions that are part of PUBLISHED tests
CREATE POLICY "Students can view test questions" ON public.questions FOR SELECT USING (
    status = 'APPROVED' AND
    EXISTS (
        SELECT 1 FROM public.test_questions tq
        JOIN public.tests t ON t.id = tq.test_id
        WHERE tq.question_id = questions.id AND t.is_published = TRUE
    )
);
CREATE POLICY "Teachers can view all questions" ON public.questions FOR SELECT USING (public.is_teacher());
CREATE POLICY "Teachers can manage questions" ON public.questions FOR ALL USING (public.is_teacher());

-- Options
CREATE POLICY "Anyone can read options for readable questions" ON public.question_options FOR SELECT USING (
    EXISTS (SELECT 1 FROM public.questions q WHERE q.id = question_id)
);
CREATE POLICY "Teachers can manage options" ON public.question_options FOR ALL USING (public.is_teacher());

-- Answer Keys (EXTREMELY STRICT)
-- Only teachers can read the answer keys!
CREATE POLICY "Teachers can read answer keys" ON public.question_answer_keys FOR SELECT USING (public.is_teacher());
CREATE POLICY "Teachers can manage answer keys" ON public.question_answer_keys FOR ALL USING (public.is_teacher());

-- Tests
CREATE POLICY "Students can see published tests" ON public.tests FOR SELECT USING (is_published = TRUE);
CREATE POLICY "Teachers can view all tests" ON public.tests FOR SELECT USING (public.is_teacher());
CREATE POLICY "Teachers can manage tests" ON public.tests FOR ALL USING (public.is_teacher());

CREATE POLICY "Students can see questions for published tests" ON public.test_questions FOR SELECT USING (
    EXISTS (SELECT 1 FROM public.tests t WHERE t.id = test_id AND t.is_published = TRUE)
);
CREATE POLICY "Teachers can manage test questions" ON public.test_questions FOR ALL USING (public.is_teacher());

-- Student Attempts
CREATE POLICY "Students can read own attempts" ON public.test_attempts FOR SELECT USING (auth.uid() = student_id);
CREATE POLICY "Students can insert own attempts" ON public.test_attempts FOR INSERT WITH CHECK (auth.uid() = student_id);
CREATE POLICY "Students can update own attempts" ON public.test_attempts FOR UPDATE USING (auth.uid() = student_id);
CREATE POLICY "Teachers can view all attempts" ON public.test_attempts FOR SELECT USING (public.is_teacher());

CREATE POLICY "Students can manage own answers" ON public.attempt_answers FOR ALL USING (
    EXISTS (SELECT 1 FROM public.test_attempts ta WHERE ta.id = attempt_id AND ta.student_id = auth.uid())
);
CREATE POLICY "Teachers can view all answers" ON public.attempt_answers FOR SELECT USING (public.is_teacher());
