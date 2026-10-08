-- KSC B4.4 — automatic Telugu OCR language versions (NEW guarded forward migration; needs 0024)
--
-- Persists B4.4 OCR results as Telugu LANGUAGE VERSIONS of existing logical questions/options:
--   * OCR text is stored as text_quality OCR_EXTRACTED, source EXTRACTED — never TEACHER_ENTERED;
--   * every OCR row carries confidence (0..1), engine, version, a verdict and review reasons, and
--     points at its AUTO_REGION TEXT_REGION source crop (the provenance is always kept);
--   * OCR_EXTRACTED content must contain Telugu and never legacy private-use/replacement glyphs;
--   * script-neutral options (e.g. Q6 "15") get SCRIPT_NEUTRAL rows, only when the option's own
--     content really is digits/symbols — no OCR, no new options;
--   * the writer never creates, deletes or edits draft_options and never touches answer flags;
--   * it refuses any Draft holding teacher work, so teacher-entered Telugu is never replaced;
--   * OCR_EXTRACTED rows can only be written by the automatic writer (transaction flag).
-- Automatic rows are not teacher work until a teacher edits them. Teacher rows (source TEACHER,
-- TEACHER_ENTERED, teacher SCRIPT_NEUTRAL) remain teacher work exactly as before.
--
-- Migrations 0001-0024 are not edited. No Question Bank, snapshot, publish, attempt,
-- evaluation, storage-policy or bucket object is touched.
BEGIN;

DO $$ BEGIN
 IF to_regclass('public.organizations') IS NOT NULL OR to_regprocedure('ksc_private.provision_student()') IS NULL
 THEN RAISE EXCEPTION 'Expected isolated KSC baseline'; END IF;
 IF to_regprocedure('public.ksc_replace_auto_visuals(uuid,uuid,jsonb)') IS NULL
    OR NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'draft_media_auto_region_provenance') THEN
  RAISE EXCEPTION 'Missing B4.3 objects. Ensure 0024 is applied.';
 END IF;
END $$;

-- =========================================================================
-- 1. OCR verdict/review columns and integrity on both language tables.
-- =========================================================================
ALTER TABLE public.draft_question_texts
  ADD COLUMN IF NOT EXISTS ocr_verdict TEXT,
  ADD COLUMN IF NOT EXISTS ocr_review_reasons JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE public.draft_option_texts
  ADD COLUMN IF NOT EXISTS ocr_verdict TEXT,
  ADD COLUMN IF NOT EXISTS ocr_review_reasons JSONB NOT NULL DEFAULT '[]'::jsonb;

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['draft_question_texts', 'draft_option_texts'] LOOP
    EXECUTE format('ALTER TABLE public.%I DROP CONSTRAINT IF EXISTS %I', t, t || '_ocr_verdict_valid');
    EXECUTE format($f$ALTER TABLE public.%I ADD CONSTRAINT %I CHECK (ocr_verdict IS NULL
      OR ocr_verdict IN ('HIGH','MEDIUM','LOW','DIGIT_MISMATCH','EMPTY','NOT_TELUGU'))$f$, t, t || '_ocr_verdict_valid');
    EXECUTE format('ALTER TABLE public.%I DROP CONSTRAINT IF EXISTS %I', t, t || '_ocr_confidence_range');
    EXECUTE format($f$ALTER TABLE public.%I ADD CONSTRAINT %I CHECK (ocr_confidence IS NULL
      OR (ocr_confidence >= 0 AND ocr_confidence <= 1))$f$, t, t || '_ocr_confidence_range');
    -- OCR text is extracted, provenanced, genuinely Telugu and never legacy glyphs.
    EXECUTE format('ALTER TABLE public.%I DROP CONSTRAINT IF EXISTS %I', t, t || '_ocr_extracted_valid');
    EXECUTE format($f$ALTER TABLE public.%I ADD CONSTRAINT %I CHECK (text_quality <> 'OCR_EXTRACTED' OR (
      source = 'EXTRACTED' AND content IS NOT NULL AND content ~ '[\u0C00-\u0C7F]'
      AND content !~ '[\uE000-\uF8FF\uFFFD]'
      AND ocr_confidence IS NOT NULL AND ocr_engine IS NOT NULL AND ocr_version IS NOT NULL
      AND ocr_verdict IS NOT NULL AND source_media_id IS NOT NULL))$f$, t, t || '_ocr_extracted_valid');
  END LOOP;
END $$;

-- OCR_EXTRACTED rows are written only inside ksc_replace_auto_telugu (transaction flag), so a
-- teacher's own text can never be relabelled as automatic (and silently replaced later).
CREATE OR REPLACE FUNCTION public.ksc_guard_ocr_language_rows() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF NEW.text_quality = 'OCR_EXTRACTED'
     AND (TG_OP = 'INSERT' OR OLD.text_quality IS DISTINCT FROM 'OCR_EXTRACTED' OR OLD.content IS DISTINCT FROM NEW.content)
     AND coalesce(current_setting('ksc.auto_telugu_writer', true), '') <> 'on' THEN
    RAISE EXCEPTION 'KSC_OCR_WRITER_ONLY'
      USING HINT = 'OCR text is written only by ksc_replace_auto_telugu; a teacher edit is TEACHER_ENTERED.';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.ksc_guard_ocr_language_rows() FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS guard_ocr_question_texts ON public.draft_question_texts;
CREATE TRIGGER guard_ocr_question_texts BEFORE INSERT OR UPDATE ON public.draft_question_texts
FOR EACH ROW EXECUTE FUNCTION public.ksc_guard_ocr_language_rows();
DROP TRIGGER IF EXISTS guard_ocr_option_texts ON public.draft_option_texts;
CREATE TRIGGER guard_ocr_option_texts BEFORE INSERT OR UPDATE ON public.draft_option_texts
FOR EACH ROW EXECUTE FUNCTION public.ksc_guard_ocr_language_rows();

-- =========================================================================
-- 2. Retry safety. Identical to 0024 except language rows: automatic (EXTRACTED) rows are
--    teacher work only once edited; teacher rows are teacher work as before (the app always
--    writes source TEACHER, including teacher SCRIPT_NEUTRAL).
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
      AND (m.capture_method <> 'AUTO_REGION'
           OR m.caption IS NOT NULL
           OR m.updated_at > m.created_at)
  ) OR EXISTS (
    SELECT 1 FROM public.draft_question_texts t
    JOIN public.draft_questions q ON q.id = t.draft_question_id
    WHERE q.draft_paper_id = p_draft_paper_id
      AND (t.source = 'TEACHER' OR t.text_quality = 'TEACHER_ENTERED' OR t.updated_at > t.created_at)
  ) OR EXISTS (
    SELECT 1 FROM public.draft_option_texts t
    JOIN public.draft_options o ON o.id = t.draft_option_id
    JOIN public.draft_questions q ON q.id = o.draft_question_id
    WHERE q.draft_paper_id = p_draft_paper_id
      AND (t.source = 'TEACHER' OR t.text_quality = 'TEACHER_ENTERED' OR t.updated_at > t.created_at)
  );
$$;
REVOKE ALL ON FUNCTION public.ksc_draft_has_teacher_work(UUID) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.ksc_draft_has_teacher_work(UUID) TO authenticated;

-- =========================================================================
-- 3. Automatic Telugu writer. Atomic. Crops must already be uploaded; a failure writes nothing.
--    Replaces only this paper's previous automatic Telugu (EXTRACTED 'te' rows and AUTO_REGION
--    TEXT_REGION crops) and returns the replaced crop paths for storage cleanup.
--    p_media:          [{ id, draft_question_id, storage_path, source_page, region_*, page_*_pt,
--                         render_scale, width_px, height_px, detection_confidence, detection_detail }]
--    p_question_texts: [{ draft_question_id, text_quality, content, ocr_confidence, ocr_verdict,
--                         ocr_review_reasons, source_media_id }]
--    p_option_texts:   [{ draft_option_id, text_quality, content, ocr_confidence, ocr_verdict,
--                         ocr_review_reasons, source_media_id }]
-- =========================================================================
CREATE OR REPLACE FUNCTION public.ksc_replace_auto_telugu(
    p_draft_paper_id UUID,
    p_run_id UUID,
    p_ocr_engine TEXT,
    p_ocr_version TEXT,
    p_media JSONB,
    p_question_texts JSONB,
    p_option_texts JSONB
) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
    v_uid UUID := auth.uid();
    v_import UUID;
    v_prefix TEXT;
    v_removed TEXT[];
    v_options_before INT;
    v_options_after INT;
    v_answers_before TEXT;
    v_answers_after TEXT;
    v_media INT := 0;
    v_qt INT := 0;
    v_ot INT := 0;
    v_item JSONB;
BEGIN
    IF v_uid IS NULL OR NOT public.is_teacher() THEN RAISE EXCEPTION 'Teacher access required'; END IF;
    IF jsonb_typeof(p_media) IS DISTINCT FROM 'array' OR jsonb_typeof(p_question_texts) IS DISTINCT FROM 'array'
       OR jsonb_typeof(p_option_texts) IS DISTINCT FROM 'array' THEN
      RAISE EXCEPTION 'p_media, p_question_texts and p_option_texts must be JSON arrays';
    END IF;
    IF coalesce(p_ocr_engine, '') = '' OR coalesce(p_ocr_version, '') = '' THEN
      RAISE EXCEPTION 'KSC_OCR_PROVENANCE_MISSING' USING HINT = 'OCR engine and version are required.';
    END IF;

    SELECT source_import_id INTO v_import FROM public.draft_papers
    WHERE id = p_draft_paper_id AND created_by = v_uid FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Draft paper not found or unauthorized'; END IF;

    IF NOT EXISTS (SELECT 1 FROM public.draft_analysis_runs
                   WHERE id = p_run_id AND source_import_id = v_import
                     AND draft_paper_id = p_draft_paper_id AND status = 'SUCCEEDED') THEN
      RAISE EXCEPTION 'KSC_ANALYSIS_RUN_INVALID' USING HINT = 'OCR must come from the run that produced this Draft.';
    END IF;

    IF public.ksc_draft_has_teacher_work(p_draft_paper_id) THEN
      RAISE EXCEPTION 'KSC_DRAFT_HAS_TEACHER_WORK'
        USING HINT = 'Automatic Telugu cannot replace or join a Draft that contains teacher changes.';
    END IF;

    -- ---- validate every crop -------------------------------------------------------------
    v_prefix := 'imports/' || v_uid::text || '/draft-media/' || p_draft_paper_id::text || '/';
    FOR v_item IN SELECT * FROM jsonb_array_elements(p_media) LOOP
      IF coalesce(v_item->>'draft_option_id', '') <> '' OR coalesce(v_item->>'draft_material_id', '') <> '' THEN
        RAISE EXCEPTION 'KSC_AUTO_TELUGU_OWNER_UNSUPPORTED' USING HINT = 'Telugu source crops belong to the question.';
      END IF;
      IF NOT EXISTS (SELECT 1 FROM public.draft_questions q
                     WHERE q.id = NULLIF(v_item->>'draft_question_id','')::UUID
                       AND q.draft_paper_id = p_draft_paper_id AND q.analysis_run_id = p_run_id) THEN
        RAISE EXCEPTION 'KSC_AUTO_TELUGU_OWNER_INVALID' USING HINT = 'Owner must be a question of this Draft and run.';
      END IF;
      IF v_item->>'storage_path' IS DISTINCT FROM v_prefix || (v_item->>'id') || '.png' THEN
        RAISE EXCEPTION 'KSC_AUTO_TELUGU_PATH_INVALID' USING HINT = 'Crops live in the caller''s private Draft media namespace.';
      END IF;
      IF jsonb_typeof(v_item->'detection_detail') IS DISTINCT FROM 'object'
         OR jsonb_typeof(v_item->'detection_confidence') IS DISTINCT FROM 'number' THEN
        RAISE EXCEPTION 'KSC_AUTO_TELUGU_PROVENANCE_MISSING';
      END IF;
    END LOOP;

    -- ---- validate every language row --------------------------------------------------------
    FOR v_item IN SELECT * FROM jsonb_array_elements(p_question_texts) LOOP
      IF NOT EXISTS (SELECT 1 FROM public.draft_questions q
                     WHERE q.id = NULLIF(v_item->>'draft_question_id','')::UUID
                       AND q.draft_paper_id = p_draft_paper_id AND q.analysis_run_id = p_run_id) THEN
        RAISE EXCEPTION 'KSC_AUTO_TELUGU_OWNER_INVALID';
      END IF;
      IF coalesce(v_item->>'text_quality', '') NOT IN ('OCR_EXTRACTED', 'MISSING') THEN
        RAISE EXCEPTION 'KSC_AUTO_TELUGU_QUALITY_INVALID' USING HINT = 'A Telugu stem is OCR_EXTRACTED or MISSING.';
      END IF;
    END LOOP;
    FOR v_item IN SELECT * FROM jsonb_array_elements(p_option_texts) LOOP
      IF NOT EXISTS (SELECT 1 FROM public.draft_options o JOIN public.draft_questions q ON q.id = o.draft_question_id
                     WHERE o.id = NULLIF(v_item->>'draft_option_id','')::UUID
                       AND q.draft_paper_id = p_draft_paper_id AND q.analysis_run_id = p_run_id) THEN
        RAISE EXCEPTION 'KSC_AUTO_TELUGU_OWNER_INVALID' USING HINT = 'Language versions attach to existing options only.';
      END IF;
      IF coalesce(v_item->>'text_quality', '') NOT IN ('OCR_EXTRACTED', 'SCRIPT_NEUTRAL', 'MISSING') THEN
        RAISE EXCEPTION 'KSC_AUTO_TELUGU_QUALITY_INVALID';
      END IF;
      -- SCRIPT_NEUTRAL must be earned by the option's own content (digits/symbols only).
      IF v_item->>'text_quality' = 'SCRIPT_NEUTRAL' AND NOT EXISTS (
           SELECT 1 FROM public.draft_options o WHERE o.id = (v_item->>'draft_option_id')::UUID
             AND o.content ~ '^[[:space:][:digit:][:punct:]$+<=>^`|~]+$') THEN
        RAISE EXCEPTION 'KSC_NOT_SCRIPT_NEUTRAL';
      END IF;
    END LOOP;

    SELECT count(*), string_agg(o.id::text || ':' || o.is_proposed_correct::text || ':' || o.is_confirmed_correct::text, ',' ORDER BY o.id)
      INTO v_options_before, v_answers_before
    FROM public.draft_options o JOIN public.draft_questions q ON q.id = o.draft_question_id
    WHERE q.draft_paper_id = p_draft_paper_id;

    PERFORM set_config('ksc.auto_visual_writer', 'on', true);
    PERFORM set_config('ksc.auto_telugu_writer', 'on', true);

    -- ---- replace previous automatic Telugu only -------------------------------------------
    DELETE FROM public.draft_question_texts t USING public.draft_questions q
    WHERE q.id = t.draft_question_id AND q.draft_paper_id = p_draft_paper_id AND t.language = 'te' AND t.source = 'EXTRACTED';
    DELETE FROM public.draft_option_texts t USING public.draft_options o, public.draft_questions q
    WHERE o.id = t.draft_option_id AND q.id = o.draft_question_id AND q.draft_paper_id = p_draft_paper_id
      AND t.language = 'te' AND t.source = 'EXTRACTED';
    WITH gone AS (
      DELETE FROM public.draft_media
      WHERE draft_paper_id = p_draft_paper_id AND capture_method = 'AUTO_REGION' AND media_kind = 'TEXT_REGION'
      RETURNING storage_path)
    SELECT coalesce(array_agg(storage_path), ARRAY[]::TEXT[]) INTO v_removed FROM gone;

    -- ---- insert crops, then language rows ----------------------------------------------------
    INSERT INTO public.draft_media (
        id, draft_paper_id, draft_question_id, position, media_kind, capture_method,
        storage_path, mime_type, width_px, height_px, source_import_id, source_page,
        region_x, region_y, region_w, region_h, page_width_pt, page_height_pt, render_scale,
        detection_confidence, detection_detail, warnings, created_by)
    SELECT (m->>'id')::UUID, p_draft_paper_id, (m->>'draft_question_id')::UUID,
        COALESCE(NULLIF(m->>'position','')::INTEGER, 0), 'TEXT_REGION', 'AUTO_REGION',
        m->>'storage_path', 'image/png', NULLIF(m->>'width_px','')::INTEGER, NULLIF(m->>'height_px','')::INTEGER,
        v_import, NULLIF(m->>'source_page','')::INTEGER,
        NULLIF(m->>'region_x','')::NUMERIC, NULLIF(m->>'region_y','')::NUMERIC,
        NULLIF(m->>'region_w','')::NUMERIC, NULLIF(m->>'region_h','')::NUMERIC,
        NULLIF(m->>'page_width_pt','')::NUMERIC, NULLIF(m->>'page_height_pt','')::NUMERIC,
        NULLIF(m->>'render_scale','')::NUMERIC, NULLIF(m->>'detection_confidence','')::NUMERIC,
        m->'detection_detail', '[]'::jsonb, v_uid
    FROM jsonb_array_elements(p_media) AS m;
    GET DIAGNOSTICS v_media = ROW_COUNT;

    INSERT INTO public.draft_question_texts (draft_question_id, language, content, text_quality, source,
        source_media_id, ocr_confidence, ocr_engine, ocr_version, ocr_verdict, ocr_review_reasons, created_by)
    SELECT (t->>'draft_question_id')::UUID, 'te', NULLIF(t->>'content',''), t->>'text_quality', 'EXTRACTED',
        NULLIF(t->>'source_media_id','')::UUID, NULLIF(t->>'ocr_confidence','')::NUMERIC,
        p_ocr_engine, p_ocr_version, t->>'ocr_verdict', COALESCE(t->'ocr_review_reasons','[]'::jsonb), v_uid
    FROM jsonb_array_elements(p_question_texts) AS t;
    GET DIAGNOSTICS v_qt = ROW_COUNT;

    INSERT INTO public.draft_option_texts (draft_option_id, language, content, text_quality, source,
        source_media_id, ocr_confidence, ocr_engine, ocr_version, ocr_verdict, ocr_review_reasons, created_by)
    SELECT (t->>'draft_option_id')::UUID, 'te', NULLIF(t->>'content',''), t->>'text_quality', 'EXTRACTED',
        NULLIF(t->>'source_media_id','')::UUID, NULLIF(t->>'ocr_confidence','')::NUMERIC,
        CASE WHEN t->>'text_quality' = 'SCRIPT_NEUTRAL' THEN NULL ELSE p_ocr_engine END,
        CASE WHEN t->>'text_quality' = 'SCRIPT_NEUTRAL' THEN NULL ELSE p_ocr_version END,
        t->>'ocr_verdict', COALESCE(t->'ocr_review_reasons','[]'::jsonb), v_uid
    FROM jsonb_array_elements(p_option_texts) AS t;
    GET DIAGNOSTICS v_ot = ROW_COUNT;

    PERFORM set_config('ksc.auto_telugu_writer', 'off', true);
    PERFORM set_config('ksc.auto_visual_writer', 'off', true);

    -- ---- defence in depth: logical options and answers are untouched --------------------------
    SELECT count(*), string_agg(o.id::text || ':' || o.is_proposed_correct::text || ':' || o.is_confirmed_correct::text, ',' ORDER BY o.id)
      INTO v_options_after, v_answers_after
    FROM public.draft_options o JOIN public.draft_questions q ON q.id = o.draft_question_id
    WHERE q.draft_paper_id = p_draft_paper_id;
    IF v_options_after IS DISTINCT FROM v_options_before OR v_answers_after IS DISTINCT FROM v_answers_before THEN
      RAISE EXCEPTION 'KSC_AUTO_TELUGU_CHANGED_OPTIONS';
    END IF;

    UPDATE public.draft_analysis_runs
    SET metrics = metrics || jsonb_build_object('autoTelugu', jsonb_build_object(
          'engine', p_ocr_engine, 'version', p_ocr_version, 'crops', v_media,
          'questionTexts', v_qt, 'optionTexts', v_ot, 'replacedCrops', coalesce(array_length(v_removed, 1), 0)))
    WHERE id = p_run_id;

    RETURN jsonb_build_object('crops', v_media, 'question_texts', v_qt, 'option_texts', v_ot, 'removed_paths', to_jsonb(v_removed));
END $$;

REVOKE ALL ON FUNCTION public.ksc_replace_auto_telugu(UUID, UUID, TEXT, TEXT, JSONB, JSONB, JSONB) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.ksc_replace_auto_telugu(UUID, UUID, TEXT, TEXT, JSONB, JSONB, JSONB) TO authenticated;

COMMIT;
