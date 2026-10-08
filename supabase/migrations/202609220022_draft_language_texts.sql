-- KSC P0-B3 — teacher-driven bilingual Draft support (NEW guarded forward migration)
--
-- ONE logical question, ONE set of logical options, ONE answer. English/Telugu are language
-- VERSIONS of that logical content, stored as child rows. A Telugu option is never another
-- draft_options row, so the number of logical choices can never grow.
--
-- This PDF's Telugu is legacy glyph-encoded (private-use U+F0xx and ANSI/symbol mappings,
-- zero Telugu Unicode), so extraction must never write it as semantic Telugu. Teacher-entered
-- Telugu is TEACHER_ENTERED; unusable extraction stays UNRELIABLE next to its source region.
--
-- SAFETY: additive only. Migrations 0001-0021 are not edited; the 0021 uniqueness constraint
-- stays active. No Question Bank, publish, snapshot, attempt, evaluation, grading, result,
-- student-engine, legacy candidate or storage object is touched. Answer state is never changed.
BEGIN;

DO $$ BEGIN
 IF to_regclass('public.organizations') IS NOT NULL OR to_regprocedure('ksc_private.provision_student()') IS NULL
 THEN RAISE EXCEPTION 'Expected isolated KSC baseline'; END IF;
 IF to_regprocedure('public.is_teacher()') IS NULL THEN RAISE EXCEPTION 'Missing is_teacher function'; END IF;
 IF to_regclass('public.draft_media') IS NULL OR to_regprocedure('public.ksc_draft_has_teacher_work(uuid)') IS NULL THEN
  RAISE EXCEPTION 'Missing P0-B2 objects. Ensure 0019 is applied.';
 END IF;
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'draft_options_one_row_per_position') THEN
  RAISE EXCEPTION 'Missing option uniqueness. Ensure 0021 is applied.';
 END IF;
END $$;

-- =========================================================================
-- 1. Language versions of a draft question and of a draft option.
--    language is a BCP-47-style code so more languages can be added later; V1 uses en/te.
--    content may be NULL: SCRIPT_NEUTRAL (same in every language, e.g. "15") and MISSING
--    both carry no text of their own.
-- =========================================================================
CREATE TABLE IF NOT EXISTS public.draft_question_texts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    draft_question_id UUID NOT NULL REFERENCES public.draft_questions(id) ON DELETE CASCADE,
    language TEXT NOT NULL CHECK (language ~ '^[a-z]{2}(-[A-Z]{2})?$'),
    content TEXT,
    text_quality TEXT NOT NULL DEFAULT 'MISSING'
        CHECK (text_quality IN ('VALID_UNICODE','UNRELIABLE','TEACHER_ENTERED','SCRIPT_NEUTRAL','MISSING')),
    source TEXT NOT NULL DEFAULT 'TEACHER' CHECK (source IN ('EXTRACTED','TEACHER')),
    source_media_id UUID REFERENCES public.draft_media(id) ON DELETE SET NULL,
    created_by UUID NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT DEFAULT auth.uid(),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    CONSTRAINT draft_question_texts_one_per_language UNIQUE (draft_question_id, language)
);

CREATE TABLE IF NOT EXISTS public.draft_option_texts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    draft_option_id UUID NOT NULL REFERENCES public.draft_options(id) ON DELETE CASCADE,
    language TEXT NOT NULL CHECK (language ~ '^[a-z]{2}(-[A-Z]{2})?$'),
    content TEXT,
    text_quality TEXT NOT NULL DEFAULT 'MISSING'
        CHECK (text_quality IN ('VALID_UNICODE','UNRELIABLE','TEACHER_ENTERED','SCRIPT_NEUTRAL','MISSING')),
    source TEXT NOT NULL DEFAULT 'TEACHER' CHECK (source IN ('EXTRACTED','TEACHER')),
    source_media_id UUID REFERENCES public.draft_media(id) ON DELETE SET NULL,
    created_by UUID NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT DEFAULT auth.uid(),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    CONSTRAINT draft_option_texts_one_per_language UNIQUE (draft_option_id, language)
);
CREATE INDEX IF NOT EXISTS idx_draft_question_texts_question ON public.draft_question_texts(draft_question_id);
CREATE INDEX IF NOT EXISTS idx_draft_option_texts_option ON public.draft_option_texts(draft_option_id);

-- =========================================================================
-- 2. A linked source region must be a TEXT_REGION in the SAME question context.
--    One question-level Telugu crop may back the stem AND its options, so an option text
--    may point at a TEXT_REGION owned by the option itself or by its parent question.
--    Cross-paper or unrelated media is refused regardless of RLS.
-- =========================================================================
CREATE OR REPLACE FUNCTION public.ksc_guard_draft_text_source_media() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
    v_kind TEXT;
    v_media_question UUID;
    v_media_option UUID;
    v_owner_question UUID;
BEGIN
    IF NEW.source_media_id IS NULL THEN RETURN NEW; END IF;

    SELECT media_kind, draft_question_id, draft_option_id
      INTO v_kind, v_media_question, v_media_option
    FROM public.draft_media WHERE id = NEW.source_media_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Source media not found';
    END IF;
    IF v_kind IS DISTINCT FROM 'TEXT_REGION' THEN
        RAISE EXCEPTION 'KSC_TEXT_SOURCE_NOT_TEXT_REGION';
    END IF;

    IF TG_TABLE_NAME = 'draft_question_texts' THEN
        v_owner_question := NEW.draft_question_id;
    ELSE
        SELECT draft_question_id INTO v_owner_question FROM public.draft_options WHERE id = NEW.draft_option_id;
    END IF;

    -- The crop must belong to this question, or to one of this question's options.
    IF v_media_question IS DISTINCT FROM v_owner_question
       AND (v_media_option IS NULL
            OR NOT EXISTS (SELECT 1 FROM public.draft_options o
                           WHERE o.id = v_media_option AND o.draft_question_id = v_owner_question)) THEN
        RAISE EXCEPTION 'KSC_TEXT_SOURCE_WRONG_CONTEXT';
    END IF;
    RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.ksc_guard_draft_text_source_media() FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS guard_question_text_source_media ON public.draft_question_texts;
CREATE TRIGGER guard_question_text_source_media BEFORE INSERT OR UPDATE ON public.draft_question_texts
FOR EACH ROW EXECUTE FUNCTION public.ksc_guard_draft_text_source_media();

DROP TRIGGER IF EXISTS guard_option_text_source_media ON public.draft_option_texts;
CREATE TRIGGER guard_option_text_source_media BEFORE INSERT OR UPDATE ON public.draft_option_texts
FOR EACH ROW EXECUTE FUNCTION public.ksc_guard_draft_text_source_media();

DROP TRIGGER IF EXISTS set_draft_question_texts_updated_at ON public.draft_question_texts;
CREATE TRIGGER set_draft_question_texts_updated_at BEFORE UPDATE ON public.draft_question_texts
FOR EACH ROW EXECUTE FUNCTION public.ksc_touch_test_import_updated_at();

DROP TRIGGER IF EXISTS set_draft_option_texts_updated_at ON public.draft_option_texts;
CREATE TRIGGER set_draft_option_texts_updated_at BEFORE UPDATE ON public.draft_option_texts
FOR EACH ROW EXECUTE FUNCTION public.ksc_touch_test_import_updated_at();

-- =========================================================================
-- 3. RLS — teacher + paper owner, same model as 0017/0019. No student/anon access.
-- =========================================================================
ALTER TABLE public.draft_question_texts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.draft_option_texts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Teachers manage own draft question texts" ON public.draft_question_texts;
CREATE POLICY "Teachers manage own draft question texts" ON public.draft_question_texts FOR ALL
TO authenticated
USING (public.is_teacher() AND EXISTS (
  SELECT 1 FROM public.draft_questions q JOIN public.draft_papers p ON p.id = q.draft_paper_id
  WHERE q.id = draft_question_texts.draft_question_id AND p.created_by = auth.uid()))
WITH CHECK (public.is_teacher() AND EXISTS (
  SELECT 1 FROM public.draft_questions q JOIN public.draft_papers p ON p.id = q.draft_paper_id
  WHERE q.id = draft_question_texts.draft_question_id AND p.created_by = auth.uid()));

DROP POLICY IF EXISTS "Teachers manage own draft option texts" ON public.draft_option_texts;
CREATE POLICY "Teachers manage own draft option texts" ON public.draft_option_texts FOR ALL
TO authenticated
USING (public.is_teacher() AND EXISTS (
  SELECT 1 FROM public.draft_options o JOIN public.draft_questions q ON q.id = o.draft_question_id
  JOIN public.draft_papers p ON p.id = q.draft_paper_id
  WHERE o.id = draft_option_texts.draft_option_id AND p.created_by = auth.uid()))
WITH CHECK (public.is_teacher() AND EXISTS (
  SELECT 1 FROM public.draft_options o JOIN public.draft_questions q ON q.id = o.draft_question_id
  JOIN public.draft_papers p ON p.id = q.draft_paper_id
  WHERE o.id = draft_option_texts.draft_option_id AND p.created_by = auth.uid()));

REVOKE ALL ON public.draft_question_texts FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON public.draft_option_texts FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.draft_question_texts TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.draft_option_texts TO authenticated;

-- =========================================================================
-- 4. Retry safety: teacher language work is teacher work. Otherwise identical to 0019/0021.
-- =========================================================================
CREATE OR REPLACE FUNCTION public.ksc_draft_has_teacher_work(p_draft_paper_id UUID)
RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY INVOKER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.draft_questions q
    WHERE q.draft_paper_id = p_draft_paper_id
      AND (q.origin = 'TEACHER'
           OR q.teacher_review_status <> 'UNREVIEWED'
           OR q.confirmed_by IS NOT NULL
           OR q.confirmed_at IS NOT NULL)
  ) OR EXISTS (
    SELECT 1 FROM public.draft_options o
    JOIN public.draft_questions q ON q.id = o.draft_question_id
    WHERE q.draft_paper_id = p_draft_paper_id
      AND (o.origin = 'TEACHER'
           OR o.is_confirmed_correct
           OR o.updated_at > o.created_at)
  ) OR EXISTS (
    SELECT 1 FROM public.draft_media m
    WHERE m.draft_paper_id = p_draft_paper_id
  ) OR EXISTS (
    SELECT 1 FROM public.draft_question_texts t
    JOIN public.draft_questions q ON q.id = t.draft_question_id
    WHERE q.draft_paper_id = p_draft_paper_id
      AND (t.source = 'TEACHER' OR t.text_quality IN ('TEACHER_ENTERED','SCRIPT_NEUTRAL'))
  ) OR EXISTS (
    SELECT 1 FROM public.draft_option_texts t
    JOIN public.draft_options o ON o.id = t.draft_option_id
    JOIN public.draft_questions q ON q.id = o.draft_question_id
    WHERE q.draft_paper_id = p_draft_paper_id
      AND (t.source = 'TEACHER' OR t.text_quality IN ('TEACHER_ENTERED','SCRIPT_NEUTRAL'))
  );
$$;
REVOKE ALL ON FUNCTION public.ksc_draft_has_teacher_work(UUID) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.ksc_draft_has_teacher_work(UUID) TO authenticated;

COMMIT;
