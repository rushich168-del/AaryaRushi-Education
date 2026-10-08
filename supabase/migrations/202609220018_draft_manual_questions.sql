-- KSC P0-B1 — Manual Add Missing Question + Retry Safety (NEW guarded forward migration)
--
-- 1. Adds an origin marker (EXTRACTED | TEACHER) to draft_questions and draft_options.
-- 2. Adds a teacher-only RPC that atomically inserts a TEACHER-origin draft question
--    at a Draft position, shifting later positions without touching provenance.
-- 3. Redefines ksc_replace_draft_analysis (from 0017) so that Retry Analysis is
--    BLOCKED whenever the Draft Paper contains teacher-owned preparation work.
--    Retry must never silently destroy teacher work. No merge/reconciliation in B1.
--
-- SAFETY: additive only. Migrations 0001-0017 are not edited. No exam-engine object,
-- legacy candidate table, or ksc_replace_test_import_analysis is touched.
BEGIN;

DO $$ BEGIN
 IF to_regclass('public.organizations') IS NOT NULL OR to_regprocedure('ksc_private.provision_student()') IS NULL
 THEN RAISE EXCEPTION 'Expected isolated KSC baseline'; END IF;
 IF to_regprocedure('public.is_teacher()') IS NULL THEN
  RAISE EXCEPTION 'Missing is_teacher function';
 END IF;
 IF to_regclass('public.draft_questions') IS NULL OR to_regclass('public.draft_options') IS NULL
    OR to_regprocedure('public.ksc_replace_draft_analysis(uuid,jsonb,jsonb,jsonb,jsonb)') IS NULL THEN
  RAISE EXCEPTION 'Missing Draft Paper foundation. Ensure 0017 is applied.';
 END IF;
END $$;

-- =========================================================================
-- 1. Origin markers. Origin = where the row came from; review state stays separate.
--    Existing rows default to EXTRACTED. Editing never changes origin.
-- =========================================================================
ALTER TABLE public.draft_questions ADD COLUMN IF NOT EXISTS origin TEXT NOT NULL DEFAULT 'EXTRACTED';
ALTER TABLE public.draft_options   ADD COLUMN IF NOT EXISTS origin TEXT NOT NULL DEFAULT 'EXTRACTED';

DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'draft_questions_origin_check') THEN
  ALTER TABLE public.draft_questions
   ADD CONSTRAINT draft_questions_origin_check CHECK (origin IN ('EXTRACTED','TEACHER'));
 END IF;
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'draft_options_origin_check') THEN
  ALTER TABLE public.draft_options
   ADD CONSTRAINT draft_options_origin_check CHECK (origin IN ('EXTRACTED','TEACHER'));
 END IF;
END $$;

-- =========================================================================
-- 2. Single definition of "teacher-owned preparation work".
--    SECURITY INVOKER: when called by a client, RLS limits it to the caller's own
--    papers; when called inside the definer RPC below it sees the whole paper.
--    Question signals: TEACHER origin, any teacher review state, any confirmation.
--    Option signals: TEACHER origin, confirmed flag, or any update after insert
--    (only teacher actions ever update an option row; analysis only inserts).
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
  );
$$;

-- =========================================================================
-- 3. Retry-safe analysis writer. Identical to 0017 except the teacher-work guard,
--    which runs BEFORE any delete. If teacher work exists the call aborts with the
--    controlled token KSC_DRAFT_HAS_TEACHER_WORK and nothing is deleted or changed.
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
    v_existing_paper_id UUID;
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

    -- Retry safety: lock the existing paper and refuse to replace teacher work.
    SELECT id INTO v_existing_paper_id FROM public.draft_papers
    WHERE source_import_id = p_import_id FOR UPDATE;
    IF v_existing_paper_id IS NOT NULL AND public.ksc_draft_has_teacher_work(v_existing_paper_id) THEN
        RAISE EXCEPTION 'KSC_DRAFT_HAS_TEACHER_WORK'
          USING ERRCODE = 'P0001',
                HINT = 'Retry Analysis is unavailable because this Draft Paper contains teacher changes.';
    END IF;

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
            extraction_status, teacher_review_status, extraction_confidence, warnings, origin, created_by)
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
            'EXTRACTED',
            auth.uid()
        FROM jsonb_array_elements(p_questions) AS q;
    END IF;

    IF jsonb_array_length(p_options) > 0 THEN
        INSERT INTO public.draft_options (
            id, draft_question_id, position, label, content, media_ref,
            is_proposed_correct, is_confirmed_correct, extraction_confidence, warnings, origin)
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
            COALESCE(o->'warnings','[]'::jsonb),
            'EXTRACTED'
        FROM jsonb_array_elements(p_options) AS o;
    END IF;

    RETURN v_paper_id;
END;
$$;

-- =========================================================================
-- 4. Teacher-only atomic insert of a TEACHER-origin draft question.
--    Draft position (ordering) and question number (label) are separate.
--    Later questions shift by +1; their provenance is never rewritten.
--    No source_page is fabricated. No options or answer are created here.
-- =========================================================================
CREATE OR REPLACE FUNCTION public.ksc_insert_draft_question(
    p_draft_paper_id UUID,
    p_position INTEGER,
    p_source_question_number TEXT,
    p_content TEXT,
    p_source_reference TEXT
) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
    v_max INTEGER;
    v_pos INTEGER;
    v_id UUID;
BEGIN
    IF auth.uid() IS NULL OR NOT public.is_teacher() THEN
        RAISE EXCEPTION 'Teacher access required';
    END IF;

    -- Ownership + serialization with other edits/retry on the same paper.
    PERFORM 1 FROM public.draft_papers
    WHERE id = p_draft_paper_id AND created_by = auth.uid()
    FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Draft paper not found or unauthorized';
    END IF;

    SELECT COALESCE(MAX(position), -1) INTO v_max
    FROM public.draft_questions WHERE draft_paper_id = p_draft_paper_id;
    v_pos := LEAST(GREATEST(COALESCE(p_position, v_max + 1), 0), v_max + 1);

    UPDATE public.draft_questions
    SET position = position + 1
    WHERE draft_paper_id = p_draft_paper_id AND position >= v_pos;

    INSERT INTO public.draft_questions (
        draft_paper_id, position, source_question_number, response_type, content,
        source_page, source_reference, source_import_id,
        extraction_status, teacher_review_status, warnings, origin, created_by)
    VALUES (
        p_draft_paper_id, v_pos, NULLIF(btrim(p_source_question_number), ''), 'SINGLE_CHOICE', p_content,
        NULL, p_source_reference, NULL,
        'NEEDS_REVIEW', 'EDITED', '[]'::jsonb, 'TEACHER', auth.uid())
    RETURNING id INTO v_id;

    RETURN jsonb_build_object('id', v_id, 'position', v_pos);
END;
$$;

-- =========================================================================
-- Grants — explicit allowlist, authenticated only (RLS/ownership still apply).
-- =========================================================================
REVOKE ALL ON FUNCTION public.ksc_draft_has_teacher_work(UUID) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.ksc_draft_has_teacher_work(UUID) TO authenticated;

REVOKE ALL ON FUNCTION public.ksc_replace_draft_analysis(UUID, JSONB, JSONB, JSONB, JSONB) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.ksc_replace_draft_analysis(UUID, JSONB, JSONB, JSONB, JSONB) TO authenticated;

REVOKE ALL ON FUNCTION public.ksc_insert_draft_question(UUID, INTEGER, TEXT, TEXT, TEXT) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.ksc_insert_draft_question(UUID, INTEGER, TEXT, TEXT, TEXT) TO authenticated;

COMMIT;
