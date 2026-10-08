-- KSC P0-A — Durable Draft Paper Foundation (NEW guarded forward migration)
-- Establishes a normalized, durable Draft Paper boundary that is SEPARATE from the
-- legacy candidate staging (test_import_candidates) and from test_imports.status.
--
-- SAFETY: This migration is additive only. It does NOT modify 0014/0015/0016, does NOT
-- touch test_imports / test_import_materials / test_import_candidates, and does NOT
-- redefine ksc_replace_test_import_analysis. No exam-engine object is altered.
BEGIN;

-- Isolated-KSC baseline guard (mirrors 0014/0015 headers). Never runs on Atlas.
DO $$ BEGIN
 IF to_regclass('public.organizations') IS NOT NULL OR to_regprocedure('ksc_private.provision_student()') IS NULL
 THEN RAISE EXCEPTION 'Expected isolated KSC baseline'; END IF;
 IF to_regprocedure('public.is_teacher()') IS NULL THEN
  RAISE EXCEPTION 'Missing is_teacher function';
 END IF;
 IF to_regclass('public.test_imports') IS NULL THEN
  RAISE EXCEPTION 'Missing test_imports table. Ensure 0014 is applied.';
 END IF;
 IF to_regprocedure('public.ksc_touch_test_import_updated_at()') IS NULL THEN
  RAISE EXCEPTION 'Missing updated_at helper from 0014.';
 END IF;
END $$;

-- =========================================================================
-- 1. draft_papers — one durable Draft Paper per source import.
--    Lifecycle is INDEPENDENT of test_imports.status.
-- =========================================================================
CREATE TABLE IF NOT EXISTS public.draft_papers (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    source_import_id UUID NOT NULL REFERENCES public.test_imports(id) ON DELETE CASCADE,
    exam_id UUID REFERENCES public.exams(id) ON DELETE RESTRICT,
    level_id UUID REFERENCES public.exam_levels(id) ON DELETE RESTRICT,
    subject_id UUID REFERENCES public.exam_subjects(id) ON DELETE RESTRICT,
    title TEXT,
    source_type TEXT NOT NULL DEFAULT 'PDF' CHECK (source_type IN ('PDF','DOCX','EXCEL','PASTE')),
    source_filename TEXT,
    source_page_count INTEGER CHECK (source_page_count IS NULL OR source_page_count >= 0),
    detected_language TEXT,
    status TEXT NOT NULL DEFAULT 'EXTRACTING'
        CHECK (status IN ('EXTRACTING','PREPARATION','READY_FOR_PROMOTION','PROMOTED','FAILED')),
    created_by UUID NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT DEFAULT auth.uid(),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (source_import_id)
);

-- =========================================================================
-- 2. draft_materials — reusable/shared source material for the Golden Slice.
--    Modeled on test_import_materials (0015) but keyed to the draft paper.
-- =========================================================================
CREATE TABLE IF NOT EXISTS public.draft_materials (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    draft_paper_id UUID NOT NULL REFERENCES public.draft_papers(id) ON DELETE CASCADE,
    material_type TEXT NOT NULL DEFAULT 'OTHER'
        CHECK (material_type IN ('PASSAGE','IMAGE','DIAGRAM','TABLE','CHART','INSTRUCTIONS','OTHER')),
    content_text TEXT,
    language TEXT,
    media_ref TEXT,
    source_page_start INTEGER,
    source_page_end INTEGER,
    extraction_confidence NUMERIC,
    warnings JSONB NOT NULL DEFAULT '[]'::jsonb,
    created_by UUID NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT DEFAULT auth.uid(),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- =========================================================================
-- 3. draft_questions — MUST permit incomplete extraction. No answer / option /
--    text / confirmation / extraction-success is required.
-- =========================================================================
CREATE TABLE IF NOT EXISTS public.draft_questions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    draft_paper_id UUID NOT NULL REFERENCES public.draft_papers(id) ON DELETE CASCADE,
    shared_material_id UUID REFERENCES public.draft_materials(id) ON DELETE SET NULL,
    position INTEGER NOT NULL DEFAULT 0,
    source_question_number TEXT,
    -- Response type is modeled INDEPENDENTLY of content/presentation. No composite types.
    response_type TEXT NOT NULL DEFAULT 'SINGLE_CHOICE'
        CHECK (response_type IN ('SINGLE_CHOICE','MULTI_SELECT','NUMERICAL','SUBJECTIVE')),
    content TEXT,                    -- nullable: incomplete allowed
    language TEXT,
    source_page INTEGER,
    source_reference TEXT,
    source_import_id UUID REFERENCES public.test_imports(id) ON DELETE SET NULL,
    extraction_status TEXT NOT NULL DEFAULT 'NEEDS_REVIEW'
        CHECK (extraction_status IN ('READY','NEEDS_REVIEW','UNRESOLVED','FAILED')),
    teacher_review_status TEXT NOT NULL DEFAULT 'UNREVIEWED'
        CHECK (teacher_review_status IN ('UNREVIEWED','EDITED','CONFIRMED')),
    extraction_confidence NUMERIC,
    warnings JSONB NOT NULL DEFAULT '[]'::jsonb,
    confirmed_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    confirmed_at TIMESTAMPTZ,
    created_by UUID NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT DEFAULT auth.uid(),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_draft_questions_paper ON public.draft_questions(draft_paper_id);
CREATE INDEX IF NOT EXISTS idx_draft_materials_paper ON public.draft_materials(draft_paper_id);

-- =========================================================================
-- 4. draft_options — normalized durable option rows. NO 0..3 rule, NO required
--    count, NO required proposed/confirmed answer. Proposed != Confirmed.
-- =========================================================================
CREATE TABLE IF NOT EXISTS public.draft_options (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    draft_question_id UUID NOT NULL REFERENCES public.draft_questions(id) ON DELETE CASCADE,
    position INTEGER NOT NULL DEFAULT 0,
    label TEXT,
    content TEXT,
    media_ref TEXT,
    is_proposed_correct BOOLEAN NOT NULL DEFAULT false,   -- parser/analysis may set this
    is_confirmed_correct BOOLEAN NOT NULL DEFAULT false,  -- ONLY a teacher action sets this
    extraction_confidence NUMERIC,
    warnings JSONB NOT NULL DEFAULT '[]'::jsonb,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_draft_options_question ON public.draft_options(draft_question_id);

-- =========================================================================
-- RLS — teacher + owner model, mirroring 0014/0015. Never publicly readable.
-- =========================================================================
ALTER TABLE public.draft_papers    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.draft_materials ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.draft_questions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.draft_options   ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Teachers manage own draft papers" ON public.draft_papers;
CREATE POLICY "Teachers manage own draft papers" ON public.draft_papers FOR ALL
TO authenticated
USING (public.is_teacher() AND created_by = auth.uid())
WITH CHECK (public.is_teacher() AND created_by = auth.uid());

DROP POLICY IF EXISTS "Teachers manage own draft materials" ON public.draft_materials;
CREATE POLICY "Teachers manage own draft materials" ON public.draft_materials FOR ALL
TO authenticated
USING (public.is_teacher() AND EXISTS (
  SELECT 1 FROM public.draft_papers p WHERE p.id = draft_materials.draft_paper_id AND p.created_by = auth.uid()))
WITH CHECK (public.is_teacher() AND EXISTS (
  SELECT 1 FROM public.draft_papers p WHERE p.id = draft_materials.draft_paper_id AND p.created_by = auth.uid()));

DROP POLICY IF EXISTS "Teachers manage own draft questions" ON public.draft_questions;
CREATE POLICY "Teachers manage own draft questions" ON public.draft_questions FOR ALL
TO authenticated
USING (public.is_teacher() AND EXISTS (
  SELECT 1 FROM public.draft_papers p WHERE p.id = draft_questions.draft_paper_id AND p.created_by = auth.uid()))
WITH CHECK (public.is_teacher() AND EXISTS (
  SELECT 1 FROM public.draft_papers p WHERE p.id = draft_questions.draft_paper_id AND p.created_by = auth.uid()));

DROP POLICY IF EXISTS "Teachers manage own draft options" ON public.draft_options;
CREATE POLICY "Teachers manage own draft options" ON public.draft_options FOR ALL
TO authenticated
USING (public.is_teacher() AND EXISTS (
  SELECT 1 FROM public.draft_questions q JOIN public.draft_papers p ON p.id = q.draft_paper_id
  WHERE q.id = draft_options.draft_question_id AND p.created_by = auth.uid()))
WITH CHECK (public.is_teacher() AND EXISTS (
  SELECT 1 FROM public.draft_questions q JOIN public.draft_papers p ON p.id = q.draft_paper_id
  WHERE q.id = draft_options.draft_question_id AND p.created_by = auth.uid()));

-- =========================================================================
-- updated_at triggers — reuse the existing 0014 helper (no new immutability).
-- =========================================================================
DROP TRIGGER IF EXISTS set_draft_papers_updated_at ON public.draft_papers;
CREATE TRIGGER set_draft_papers_updated_at BEFORE UPDATE ON public.draft_papers
FOR EACH ROW EXECUTE FUNCTION public.ksc_touch_test_import_updated_at();

DROP TRIGGER IF EXISTS set_draft_materials_updated_at ON public.draft_materials;
CREATE TRIGGER set_draft_materials_updated_at BEFORE UPDATE ON public.draft_materials
FOR EACH ROW EXECUTE FUNCTION public.ksc_touch_test_import_updated_at();

DROP TRIGGER IF EXISTS set_draft_questions_updated_at ON public.draft_questions;
CREATE TRIGGER set_draft_questions_updated_at BEFORE UPDATE ON public.draft_questions
FOR EACH ROW EXECUTE FUNCTION public.ksc_touch_test_import_updated_at();

DROP TRIGGER IF EXISTS set_draft_options_updated_at ON public.draft_options;
CREATE TRIGGER set_draft_options_updated_at BEFORE UPDATE ON public.draft_options
FOR EACH ROW EXECUTE FUNCTION public.ksc_touch_test_import_updated_at();

-- =========================================================================
-- Atomic analysis writer (NEW RPC, defined only here). Upserts the draft paper
-- for an import and replaces its normalized analysis in ONE transaction so a
-- client failure can never leave a half-deleted paper. Does NOT touch the
-- legacy candidate RPC. Proposed answers persist; confirmed answers do NOT get
-- set here — only a teacher confirmation call sets is_confirmed_correct.
-- =========================================================================
CREATE OR REPLACE FUNCTION public.ksc_replace_draft_analysis(
    p_import_id UUID,
    p_paper JSONB,
    p_materials JSONB,
    p_questions JSONB,
    p_options JSONB
) RETURNS UUID LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
    v_import RECORD;
    v_paper_id UUID;
BEGIN
    IF auth.uid() IS NULL OR NOT public.is_teacher() THEN
        RAISE EXCEPTION 'Teacher access required';
    END IF;
    IF p_materials IS NULL OR jsonb_typeof(p_materials) <> 'array'
    OR p_questions IS NULL OR jsonb_typeof(p_questions) <> 'array'
    OR p_options   IS NULL OR jsonb_typeof(p_options)   <> 'array' THEN
        RAISE EXCEPTION 'p_materials, p_questions and p_options must be JSON arrays';
    END IF;

    SELECT * INTO v_import FROM public.test_imports WHERE id = p_import_id AND created_by = auth.uid();
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Import not found or unauthorized';
    END IF;

    -- Upsert the durable Draft Paper for this import.
    INSERT INTO public.draft_papers (
        source_import_id, exam_id, level_id, subject_id, title,
        source_type, source_filename, source_page_count, detected_language, status, created_by
    ) VALUES (
        p_import_id,
        NULLIF(p_paper->>'exam_id','')::UUID,
        NULLIF(p_paper->>'level_id','')::UUID,
        NULLIF(p_paper->>'subject_id','')::UUID,
        p_paper->>'title',
        COALESCE(p_paper->>'source_type','PDF'),
        p_paper->>'source_filename',
        NULLIF(p_paper->>'source_page_count','')::INTEGER,
        p_paper->>'detected_language',
        'PREPARATION',
        auth.uid()
    )
    ON CONFLICT (source_import_id) DO UPDATE
      SET title = EXCLUDED.title,
          exam_id = EXCLUDED.exam_id,
          level_id = EXCLUDED.level_id,
          subject_id = EXCLUDED.subject_id,
          source_type = EXCLUDED.source_type,
          source_filename = EXCLUDED.source_filename,
          source_page_count = EXCLUDED.source_page_count,
          detected_language = EXCLUDED.detected_language,
          status = 'PREPARATION',
          updated_at = NOW()
    RETURNING id INTO v_paper_id;

    -- Replace prior analysis (options cascade from questions).
    DELETE FROM public.draft_questions WHERE draft_paper_id = v_paper_id;
    DELETE FROM public.draft_materials WHERE draft_paper_id = v_paper_id;

    IF jsonb_array_length(p_materials) > 0 THEN
        INSERT INTO public.draft_materials (
            id, draft_paper_id, material_type, content_text, language, media_ref,
            source_page_start, source_page_end, extraction_confidence, warnings, created_by)
        SELECT
            COALESCE(NULLIF(m->>'id','')::UUID, gen_random_uuid()),
            v_paper_id,
            COALESCE(m->>'material_type','OTHER'),
            m->>'content_text',
            m->>'language',
            m->>'media_ref',
            NULLIF(m->>'source_page_start','')::INTEGER,
            NULLIF(m->>'source_page_end','')::INTEGER,
            NULLIF(m->>'extraction_confidence','')::NUMERIC,
            COALESCE(m->'warnings','[]'::jsonb),
            auth.uid()
        FROM jsonb_array_elements(p_materials) AS m;
    END IF;

    IF jsonb_array_length(p_questions) > 0 THEN
        INSERT INTO public.draft_questions (
            id, draft_paper_id, shared_material_id, position, source_question_number,
            response_type, content, language, source_page, source_reference, source_import_id,
            extraction_status, teacher_review_status, extraction_confidence, warnings, created_by)
        SELECT
            COALESCE(NULLIF(q->>'id','')::UUID, gen_random_uuid()),
            v_paper_id,
            NULLIF(q->>'shared_material_id','')::UUID,
            COALESCE(NULLIF(q->>'position','')::INTEGER, 0),
            q->>'source_question_number',
            COALESCE(q->>'response_type','SINGLE_CHOICE'),
            q->>'content',
            q->>'language',
            NULLIF(q->>'source_page','')::INTEGER,
            q->>'source_reference',
            p_import_id,
            COALESCE(q->>'extraction_status','NEEDS_REVIEW'),
            'UNREVIEWED',
            NULLIF(q->>'extraction_confidence','')::NUMERIC,
            COALESCE(q->'warnings','[]'::jsonb),
            auth.uid()
        FROM jsonb_array_elements(p_questions) AS q;
    END IF;

    IF jsonb_array_length(p_options) > 0 THEN
        INSERT INTO public.draft_options (
            id, draft_question_id, position, label, content, media_ref,
            is_proposed_correct, is_confirmed_correct, extraction_confidence, warnings)
        SELECT
            COALESCE(NULLIF(o->>'id','')::UUID, gen_random_uuid()),
            (o->>'draft_question_id')::UUID,
            COALESCE(NULLIF(o->>'position','')::INTEGER, 0),
            o->>'label',
            o->>'content',
            o->>'media_ref',
            COALESCE((o->>'is_proposed_correct')::BOOLEAN, false),
            false,  -- confirmed answer is NEVER set by analysis ingest
            NULLIF(o->>'extraction_confidence','')::NUMERIC,
            COALESCE(o->'warnings','[]'::jsonb)
        FROM jsonb_array_elements(p_options) AS o;
    END IF;

    RETURN v_paper_id;
END;
$$;

-- Teacher confirmation for SINGLE_CHOICE. Sets exactly one confirmed option
-- (or none when p_option_id is NULL) and marks the question reviewed/confirmed.
CREATE OR REPLACE FUNCTION public.ksc_confirm_draft_single_choice(
    p_question_id UUID,
    p_option_id UUID
) RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
    v_q RECORD;
BEGIN
    IF auth.uid() IS NULL OR NOT public.is_teacher() THEN
        RAISE EXCEPTION 'Teacher access required';
    END IF;

    SELECT q.* INTO v_q
    FROM public.draft_questions q JOIN public.draft_papers p ON p.id = q.draft_paper_id
    WHERE q.id = p_question_id AND p.created_by = auth.uid();
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Draft question not found or unauthorized';
    END IF;

    IF p_option_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM public.draft_options WHERE id = p_option_id AND draft_question_id = p_question_id) THEN
        RAISE EXCEPTION 'Option does not belong to this draft question';
    END IF;

    UPDATE public.draft_options SET is_confirmed_correct = (id = p_option_id), updated_at = NOW()
    WHERE draft_question_id = p_question_id;

    UPDATE public.draft_questions
    SET teacher_review_status = 'CONFIRMED', confirmed_by = auth.uid(), confirmed_at = NOW(), updated_at = NOW()
    WHERE id = p_question_id;

    RETURN TRUE;
END;
$$;

-- =========================================================================
-- Grants — RLS-scoped table DML for authenticated; explicit RPC grants only.
-- =========================================================================
REVOKE ALL ON public.draft_papers    FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON public.draft_materials FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON public.draft_questions FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON public.draft_options   FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.draft_papers    TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.draft_materials TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.draft_questions TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.draft_options   TO authenticated;

REVOKE ALL ON FUNCTION public.ksc_replace_draft_analysis(UUID, JSONB, JSONB, JSONB, JSONB) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.ksc_replace_draft_analysis(UUID, JSONB, JSONB, JSONB, JSONB) TO authenticated;
REVOKE ALL ON FUNCTION public.ksc_confirm_draft_single_choice(UUID, UUID) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.ksc_confirm_draft_single_choice(UUID, UUID) TO authenticated;

COMMIT;
