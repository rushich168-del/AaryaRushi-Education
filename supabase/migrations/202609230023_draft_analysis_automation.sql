-- KSC B4.2 — automated Draft persistence foundation (NEW guarded forward migration)
--
-- Adds the provenance/automation fields the accepted B4 architecture needs, plus an atomic
-- "writer v2" that persists a B4.1 paper model, and a run log that makes failures observable.
--
-- Safety semantics preserved exactly:
--   * the writer refuses to touch a Draft that holds teacher work (Retry protection);
--   * one B4 logical question -> one draft question; language versions never add questions;
--   * options stay unique per position (0021) and limited to the detected set;
--   * answer-key mappings set is_proposed_correct ONLY; is_confirmed_correct stays false;
--   * legacy Telugu glyph strings are never stored as language content (no text rows here);
--   * a failed write rolls back whole; the run row survives to record the failure.
--
-- B4.2 writes NO OCR text and NO image crops. Telugu/figure region geometry is persisted so
-- B4.3 (crops) and B4.4 (OCR) can consume it.
--
-- Migrations 0001-0022 are not edited. Two CHECK constraints from 0019/0022 are widened here.
BEGIN;

DO $$ BEGIN
 IF to_regclass('public.organizations') IS NOT NULL OR to_regprocedure('ksc_private.provision_student()') IS NULL
 THEN RAISE EXCEPTION 'Expected isolated KSC baseline'; END IF;
 IF to_regclass('public.draft_question_texts') IS NULL OR to_regclass('public.draft_media') IS NULL
    OR to_regprocedure('public.ksc_draft_has_teacher_work(uuid)') IS NULL THEN
  RAISE EXCEPTION 'Missing P0-B3 objects. Ensure 0022 is applied.';
 END IF;
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'draft_options_one_row_per_position') THEN
  RAISE EXCEPTION 'Missing option uniqueness. Ensure 0021 is applied.';
 END IF;
END $$;

-- =========================================================================
-- 1. Run log: one row per automatic analysis attempt. Survives a failed write.
-- =========================================================================
CREATE TABLE IF NOT EXISTS public.draft_analysis_runs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    source_import_id UUID NOT NULL REFERENCES public.test_imports(id) ON DELETE CASCADE,
    draft_paper_id UUID REFERENCES public.draft_papers(id) ON DELETE SET NULL,
    engine TEXT NOT NULL,
    engine_version TEXT NOT NULL,
    pipeline_stage TEXT NOT NULL DEFAULT 'B4.2',
    status TEXT NOT NULL DEFAULT 'RUNNING' CHECK (status IN ('RUNNING','SUCCEEDED','FAILED')),
    started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at TIMESTAMPTZ,
    failed_at TIMESTAMPTZ,
    error_message TEXT,
    error_detail JSONB,
    metrics JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_by UUID NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT DEFAULT auth.uid(),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_draft_analysis_runs_import ON public.draft_analysis_runs(source_import_id);

ALTER TABLE public.draft_analysis_runs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Teachers manage own analysis runs" ON public.draft_analysis_runs;
CREATE POLICY "Teachers manage own analysis runs" ON public.draft_analysis_runs FOR ALL
TO authenticated
USING (public.is_teacher() AND EXISTS (
  SELECT 1 FROM public.test_imports i WHERE i.id = draft_analysis_runs.source_import_id AND i.created_by = auth.uid()))
WITH CHECK (public.is_teacher() AND EXISTS (
  SELECT 1 FROM public.test_imports i WHERE i.id = draft_analysis_runs.source_import_id AND i.created_by = auth.uid()));
REVOKE ALL ON public.draft_analysis_runs FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE ON public.draft_analysis_runs TO authenticated;

DROP TRIGGER IF EXISTS set_draft_analysis_runs_updated_at ON public.draft_analysis_runs;
CREATE TRIGGER set_draft_analysis_runs_updated_at BEFORE UPDATE ON public.draft_analysis_runs
FOR EACH ROW EXECUTE FUNCTION public.ksc_touch_test_import_updated_at();

-- =========================================================================
-- 2. Automation/provenance columns.
-- =========================================================================
ALTER TABLE public.draft_questions
  ADD COLUMN IF NOT EXISTS source_bbox JSONB,              -- question block geometry per page
  ADD COLUMN IF NOT EXISTS column_index INTEGER,
  ADD COLUMN IF NOT EXISTS analysis_regions JSONB,         -- { telugu: [...], figures: [...] }
  ADD COLUMN IF NOT EXISTS review_reasons JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS pairing_confidence NUMERIC,
  ADD COLUMN IF NOT EXISTS answer_key_source TEXT,
  ADD COLUMN IF NOT EXISTS answer_key_confidence NUMERIC,
  ADD COLUMN IF NOT EXISTS analysis_run_id UUID REFERENCES public.draft_analysis_runs(id) ON DELETE SET NULL;

ALTER TABLE public.draft_options
  ADD COLUMN IF NOT EXISTS marker TEXT,
  ADD COLUMN IF NOT EXISTS marker_confidence NUMERIC;

ALTER TABLE public.draft_question_texts
  ADD COLUMN IF NOT EXISTS ocr_confidence NUMERIC,
  ADD COLUMN IF NOT EXISTS ocr_engine TEXT,
  ADD COLUMN IF NOT EXISTS ocr_version TEXT;

ALTER TABLE public.draft_option_texts
  ADD COLUMN IF NOT EXISTS ocr_confidence NUMERIC,
  ADD COLUMN IF NOT EXISTS ocr_engine TEXT,
  ADD COLUMN IF NOT EXISTS ocr_version TEXT;

ALTER TABLE public.draft_media
  ADD COLUMN IF NOT EXISTS detection_confidence NUMERIC;

-- =========================================================================
-- 3. Widen the two CHECK constraints (only here, never by editing 0019/0022).
--    text_quality gains OCR_EXTRACTED; capture_method gains AUTO_REGION.
-- =========================================================================
DO $$
DECLARE c TEXT;
BEGIN
  FOR c IN SELECT conname FROM pg_constraint
           WHERE conrelid = 'public.draft_question_texts'::regclass AND contype = 'c'
             AND pg_get_constraintdef(oid) ILIKE '%text_quality%'
  LOOP EXECUTE format('ALTER TABLE public.draft_question_texts DROP CONSTRAINT %I', c); END LOOP;

  FOR c IN SELECT conname FROM pg_constraint
           WHERE conrelid = 'public.draft_option_texts'::regclass AND contype = 'c'
             AND pg_get_constraintdef(oid) ILIKE '%text_quality%'
  LOOP EXECUTE format('ALTER TABLE public.draft_option_texts DROP CONSTRAINT %I', c); END LOOP;

  FOR c IN SELECT conname FROM pg_constraint
           WHERE conrelid = 'public.draft_media'::regclass AND contype = 'c'
             AND pg_get_constraintdef(oid) ILIKE '%capture_method%'
  LOOP EXECUTE format('ALTER TABLE public.draft_media DROP CONSTRAINT %I', c); END LOOP;
END $$;

ALTER TABLE public.draft_question_texts ADD CONSTRAINT draft_question_texts_text_quality_v2
  CHECK (text_quality IN ('VALID_UNICODE','UNRELIABLE','TEACHER_ENTERED','SCRIPT_NEUTRAL','MISSING','OCR_EXTRACTED'));
ALTER TABLE public.draft_option_texts ADD CONSTRAINT draft_option_texts_text_quality_v2
  CHECK (text_quality IN ('VALID_UNICODE','UNRELIABLE','TEACHER_ENTERED','SCRIPT_NEUTRAL','MISSING','OCR_EXTRACTED'));
ALTER TABLE public.draft_media ADD CONSTRAINT draft_media_capture_method_v2
  CHECK (capture_method IN ('SOURCE_REGION','TEACHER_UPLOAD','AUTO_REGION'));

-- =========================================================================
-- 4. Run lifecycle RPCs (separate transactions, so a failure stays observable).
-- =========================================================================
CREATE OR REPLACE FUNCTION public.ksc_start_draft_analysis_run(
    p_import_id UUID, p_engine TEXT, p_engine_version TEXT, p_metrics JSONB DEFAULT '{}'::jsonb
) RETURNS UUID LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE v_id UUID;
BEGIN
  IF auth.uid() IS NULL OR NOT public.is_teacher() THEN RAISE EXCEPTION 'Teacher access required'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.test_imports WHERE id = p_import_id AND created_by = auth.uid()) THEN
    RAISE EXCEPTION 'Import not found or unauthorized';
  END IF;
  INSERT INTO public.draft_analysis_runs (source_import_id, engine, engine_version, metrics, created_by)
  VALUES (p_import_id, p_engine, p_engine_version, coalesce(p_metrics, '{}'::jsonb), auth.uid())
  RETURNING id INTO v_id;
  RETURN v_id;
END $$;

CREATE OR REPLACE FUNCTION public.ksc_fail_draft_analysis_run(
    p_run_id UUID, p_message TEXT, p_detail JSONB DEFAULT NULL
) RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF auth.uid() IS NULL OR NOT public.is_teacher() THEN RAISE EXCEPTION 'Teacher access required'; END IF;
  UPDATE public.draft_analysis_runs r
  SET status = 'FAILED', failed_at = NOW(), error_message = left(coalesce(p_message, ''), 2000), error_detail = p_detail
  FROM public.test_imports i
  WHERE r.id = p_run_id AND i.id = r.source_import_id AND i.created_by = auth.uid() AND r.status = 'RUNNING';
  IF NOT FOUND THEN RAISE EXCEPTION 'Run not found, unauthorized, or already finished'; END IF;
  RETURN TRUE;
END $$;

-- =========================================================================
-- 5. Writer v2 — atomic persistence of a B4.1 paper model.
--    Refuses any Draft holding teacher work. Never sets a confirmed answer.
--    Re-running on an untouched automatic Draft replaces it in place (same paper row).
-- =========================================================================
CREATE OR REPLACE FUNCTION public.ksc_replace_draft_analysis_v2(
    p_import_id UUID,
    p_run_id UUID,
    p_paper JSONB,
    p_questions JSONB,
    p_options JSONB
) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
    v_paper_id UUID;
    v_existing UUID;
    v_questions INT := 0;
    v_options INT := 0;
    v_proposed INT := 0;
BEGIN
    IF auth.uid() IS NULL OR NOT public.is_teacher() THEN RAISE EXCEPTION 'Teacher access required'; END IF;
    IF p_questions IS NULL OR jsonb_typeof(p_questions) <> 'array'
    OR p_options IS NULL OR jsonb_typeof(p_options) <> 'array' THEN
      RAISE EXCEPTION 'p_questions and p_options must be JSON arrays';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.test_imports WHERE id = p_import_id AND created_by = auth.uid()) THEN
      RAISE EXCEPTION 'Import not found or unauthorized';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.draft_analysis_runs
                   WHERE id = p_run_id AND source_import_id = p_import_id AND status = 'RUNNING') THEN
      RAISE EXCEPTION 'KSC_ANALYSIS_RUN_INVALID' USING HINT = 'Start a run before writing its result.';
    END IF;

    SELECT id INTO v_existing FROM public.draft_papers WHERE source_import_id = p_import_id FOR UPDATE;
    IF v_existing IS NOT NULL AND public.ksc_draft_has_teacher_work(v_existing) THEN
      RAISE EXCEPTION 'KSC_DRAFT_HAS_TEACHER_WORK'
        USING HINT = 'Automatic preparation cannot replace a Draft that contains teacher changes.';
    END IF;

    INSERT INTO public.draft_papers (source_import_id, exam_id, level_id, subject_id, title,
        source_type, source_filename, source_page_count, detected_language, status, created_by)
    VALUES (p_import_id,
        NULLIF(p_paper->>'exam_id','')::UUID, NULLIF(p_paper->>'level_id','')::UUID, NULLIF(p_paper->>'subject_id','')::UUID,
        p_paper->>'title', COALESCE(p_paper->>'source_type','PDF'), p_paper->>'source_filename',
        NULLIF(p_paper->>'source_page_count','')::INTEGER, p_paper->>'detected_language', 'PREPARATION', auth.uid())
    ON CONFLICT (source_import_id) DO UPDATE
      SET title = EXCLUDED.title, source_page_count = EXCLUDED.source_page_count,
          detected_language = EXCLUDED.detected_language, status = 'PREPARATION', updated_at = NOW()
    RETURNING id INTO v_paper_id;

    DELETE FROM public.draft_questions WHERE draft_paper_id = v_paper_id;
    DELETE FROM public.draft_materials WHERE draft_paper_id = v_paper_id;

    INSERT INTO public.draft_questions (
        id, draft_paper_id, position, source_question_number, response_type, content, language,
        source_page, source_reference, source_import_id, extraction_status, teacher_review_status,
        extraction_confidence, warnings, origin, created_by,
        source_bbox, column_index, analysis_regions, review_reasons,
        pairing_confidence, answer_key_source, answer_key_confidence, analysis_run_id)
    SELECT
        (q->>'id')::UUID, v_paper_id,
        COALESCE(NULLIF(q->>'position','')::INTEGER, 0),
        q->>'source_question_number', 'SINGLE_CHOICE', q->>'content', q->>'language',
        NULLIF(q->>'source_page','')::INTEGER, q->>'source_reference', p_import_id,
        COALESCE(q->>'extraction_status','NEEDS_REVIEW'), 'UNREVIEWED',
        NULLIF(q->>'extraction_confidence','')::NUMERIC, COALESCE(q->'warnings','[]'::jsonb), 'EXTRACTED', auth.uid(),
        q->'source_bbox', NULLIF(q->>'column_index','')::INTEGER, q->'analysis_regions',
        COALESCE(q->'review_reasons','[]'::jsonb),
        NULLIF(q->>'pairing_confidence','')::NUMERIC, q->>'answer_key_source',
        NULLIF(q->>'answer_key_confidence','')::NUMERIC, p_run_id
    FROM jsonb_array_elements(p_questions) AS q;
    GET DIAGNOSTICS v_questions = ROW_COUNT;

    INSERT INTO public.draft_options (
        id, draft_question_id, position, marker, marker_confidence, content,
        is_proposed_correct, is_confirmed_correct, warnings, origin)
    SELECT
        COALESCE(NULLIF(o->>'id','')::UUID, gen_random_uuid()),
        (o->>'draft_question_id')::UUID,
        COALESCE(NULLIF(o->>'position','')::INTEGER, 0),
        o->>'marker', NULLIF(o->>'marker_confidence','')::NUMERIC,
        o->>'content',
        COALESCE((o->>'is_proposed_correct')::BOOLEAN, false),
        false,                              -- confirmed answers are a teacher action only
        COALESCE(o->'warnings','[]'::jsonb), 'EXTRACTED'
    FROM jsonb_array_elements(p_options) AS o;
    GET DIAGNOSTICS v_options = ROW_COUNT;

    SELECT count(*) INTO v_proposed FROM public.draft_options o
    JOIN public.draft_questions q ON q.id = o.draft_question_id
    WHERE q.draft_paper_id = v_paper_id AND o.is_proposed_correct;

    UPDATE public.draft_analysis_runs
    SET status = 'SUCCEEDED', completed_at = NOW(), draft_paper_id = v_paper_id,
        metrics = metrics || jsonb_build_object('questions', v_questions, 'options', v_options, 'proposedAnswers', v_proposed)
    WHERE id = p_run_id;

    RETURN jsonb_build_object('draft_paper_id', v_paper_id, 'questions', v_questions,
                              'options', v_options, 'proposedAnswers', v_proposed, 'run_id', p_run_id);
END $$;

REVOKE ALL ON FUNCTION public.ksc_start_draft_analysis_run(UUID, TEXT, TEXT, JSONB) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.ksc_fail_draft_analysis_run(UUID, TEXT, JSONB) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.ksc_replace_draft_analysis_v2(UUID, UUID, JSONB, JSONB, JSONB) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.ksc_start_draft_analysis_run(UUID, TEXT, TEXT, JSONB) TO authenticated;
GRANT EXECUTE ON FUNCTION public.ksc_fail_draft_analysis_run(UUID, TEXT, JSONB) TO authenticated;
GRANT EXECUTE ON FUNCTION public.ksc_replace_draft_analysis_v2(UUID, UUID, JSONB, JSONB, JSONB) TO authenticated;

COMMIT;
