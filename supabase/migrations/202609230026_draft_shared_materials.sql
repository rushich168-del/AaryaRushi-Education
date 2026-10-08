-- KSC B4.2R — Draft construction repair: shared materials (NEW guarded forward migration; needs 0025)
--
-- The existing model already expresses "questions reference shared material":
--   draft_materials (0017)            one shared passage / data / figure / instruction block
--   draft_questions.shared_material_id (0017) many questions -> one material
--   draft_media.draft_material_id      (0019) figures owned by a material
-- It is reused. This migration only adds what the automatic pipeline must record and guard:
--   * material provenance: source regions, Telugu regions, the question range the heading states,
--     how that range was established, the heading, review reasons, origin and analysis run;
--   * a guard that a question can only reference a material of its own Draft paper;
--   * writer v3 = writer v2 + materials + question -> material links, in one transaction;
--   * an AUTO_REGION writer for material-owned figures / Telugu source crops;
--   * teacher-edited materials count as teacher work (Retry protection).
-- Question content is the STEM only; option text lives in options (enforced by the mapper and
-- verified by tests; the database cannot parse prose).
--
-- Migrations 0001-0025 are not edited. No Question Bank, snapshot, publish, attempt,
-- evaluation, storage-policy or bucket object is touched.
BEGIN;

DO $$ BEGIN
 IF to_regclass('public.organizations') IS NOT NULL OR to_regprocedure('ksc_private.provision_student()') IS NULL
 THEN RAISE EXCEPTION 'Expected isolated KSC baseline'; END IF;
 IF to_regprocedure('public.ksc_replace_auto_telugu(uuid,uuid,text,text,jsonb,jsonb,jsonb)') IS NULL THEN
  RAISE EXCEPTION 'Missing B4.4 objects. Ensure 0025 is applied.';
 END IF;
END $$;

-- =========================================================================
-- 1. Material provenance.
-- =========================================================================
ALTER TABLE public.draft_materials
  ADD COLUMN IF NOT EXISTS position INTEGER,
  ADD COLUMN IF NOT EXISTS heading TEXT,
  ADD COLUMN IF NOT EXISTS source_regions JSONB NOT NULL DEFAULT '[]'::jsonb,   -- [{page,column,x,y,w,h}] PDF points
  ADD COLUMN IF NOT EXISTS telugu_regions JSONB NOT NULL DEFAULT '[]'::jsonb,   -- geometry only, never glyph text
  ADD COLUMN IF NOT EXISTS applies_to_questions JSONB NOT NULL DEFAULT '[]'::jsonb,  -- question numbers the heading states
  ADD COLUMN IF NOT EXISTS range_source TEXT,
  ADD COLUMN IF NOT EXISTS review_reasons JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS origin TEXT NOT NULL DEFAULT 'EXTRACTED',
  ADD COLUMN IF NOT EXISTS analysis_run_id UUID REFERENCES public.draft_analysis_runs(id) ON DELETE SET NULL;

ALTER TABLE public.draft_materials DROP CONSTRAINT IF EXISTS draft_materials_range_source_valid;
ALTER TABLE public.draft_materials ADD CONSTRAINT draft_materials_range_source_valid
  CHECK (range_source IS NULL OR range_source IN ('HEADING_RANGE','SINGULAR_NEXT_QUESTION','UNLINKED','TEACHER'));
ALTER TABLE public.draft_materials DROP CONSTRAINT IF EXISTS draft_materials_origin_valid;
ALTER TABLE public.draft_materials ADD CONSTRAINT draft_materials_origin_valid CHECK (origin IN ('EXTRACTED','TEACHER'));
ALTER TABLE public.draft_materials DROP CONSTRAINT IF EXISTS draft_materials_no_legacy_glyphs;
ALTER TABLE public.draft_materials ADD CONSTRAINT draft_materials_no_legacy_glyphs
  CHECK (content_text IS NULL OR content_text !~ '[\uE000-\uF8FF\uFFFD]');

-- =========================================================================
-- 2. A question may only reference a material of its own Draft paper.
-- =========================================================================
CREATE OR REPLACE FUNCTION public.ksc_guard_question_shared_material() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF NEW.shared_material_id IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM public.draft_materials m WHERE m.id = NEW.shared_material_id AND m.draft_paper_id = NEW.draft_paper_id) THEN
    RAISE EXCEPTION 'KSC_SHARED_MATERIAL_WRONG_PAPER' USING HINT = 'A question can only reference material of its own Draft.';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.ksc_guard_question_shared_material() FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS guard_question_shared_material ON public.draft_questions;
CREATE TRIGGER guard_question_shared_material BEFORE INSERT OR UPDATE OF shared_material_id, draft_paper_id ON public.draft_questions
FOR EACH ROW EXECUTE FUNCTION public.ksc_guard_question_shared_material();

-- =========================================================================
-- 3. Retry safety. Identical to 0025, plus: a teacher-created or teacher-edited material is
--    teacher work (automatic replacement must never discard it).
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
  ) OR EXISTS (
    SELECT 1 FROM public.draft_materials mt
    WHERE mt.draft_paper_id = p_draft_paper_id
      AND (mt.origin = 'TEACHER' OR mt.updated_at > mt.created_at)
  );
$$;
REVOKE ALL ON FUNCTION public.ksc_draft_has_teacher_work(UUID) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.ksc_draft_has_teacher_work(UUID) TO authenticated;

-- =========================================================================
-- 4. Writer v3 — writer v2 (0023) plus shared materials and question -> material links.
--    Atomic; refuses teacher work; never sets a confirmed answer.
-- =========================================================================
CREATE OR REPLACE FUNCTION public.ksc_replace_draft_analysis_v3(
    p_import_id UUID,
    p_run_id UUID,
    p_paper JSONB,
    p_materials JSONB,
    p_questions JSONB,
    p_options JSONB
) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
    v_paper_id UUID;
    v_existing UUID;
    v_materials INT := 0;
    v_questions INT := 0;
    v_linked INT := 0;
    v_options INT := 0;
    v_proposed INT := 0;
BEGIN
    IF auth.uid() IS NULL OR NOT public.is_teacher() THEN RAISE EXCEPTION 'Teacher access required'; END IF;
    IF jsonb_typeof(p_questions) IS DISTINCT FROM 'array' OR jsonb_typeof(p_options) IS DISTINCT FROM 'array'
       OR jsonb_typeof(p_materials) IS DISTINCT FROM 'array' THEN
      RAISE EXCEPTION 'p_materials, p_questions and p_options must be JSON arrays';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.test_imports WHERE id = p_import_id AND created_by = auth.uid()) THEN
      RAISE EXCEPTION 'Import not found or unauthorized';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.draft_analysis_runs
                   WHERE id = p_run_id AND source_import_id = p_import_id AND status = 'RUNNING') THEN
      RAISE EXCEPTION 'KSC_ANALYSIS_RUN_INVALID' USING HINT = 'Start a run before writing its result.';
    END IF;
    -- Every referenced material must be in this payload.
    IF EXISTS (SELECT 1 FROM jsonb_array_elements(p_questions) q
               WHERE coalesce(q->>'shared_material_id', '') <> ''
                 AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(p_materials) m WHERE m->>'id' = q->>'shared_material_id')) THEN
      RAISE EXCEPTION 'KSC_SHARED_MATERIAL_NOT_IN_PAYLOAD';
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

    INSERT INTO public.draft_materials (
        id, draft_paper_id, material_type, content_text, language, source_page_start, source_page_end,
        extraction_confidence, warnings, created_by, position, heading, source_regions, telugu_regions,
        applies_to_questions, range_source, review_reasons, origin, analysis_run_id)
    SELECT (m->>'id')::UUID, v_paper_id, COALESCE(m->>'material_type','OTHER'), NULLIF(m->>'content_text',''),
        m->>'language', NULLIF(m->>'source_page_start','')::INTEGER, NULLIF(m->>'source_page_end','')::INTEGER,
        NULLIF(m->>'extraction_confidence','')::NUMERIC, COALESCE(m->'warnings','[]'::jsonb), auth.uid(),
        NULLIF(m->>'position','')::INTEGER, m->>'heading', COALESCE(m->'source_regions','[]'::jsonb),
        COALESCE(m->'telugu_regions','[]'::jsonb), COALESCE(m->'applies_to_questions','[]'::jsonb),
        m->>'range_source', COALESCE(m->'review_reasons','[]'::jsonb), 'EXTRACTED', p_run_id
    FROM jsonb_array_elements(p_materials) AS m;
    GET DIAGNOSTICS v_materials = ROW_COUNT;

    INSERT INTO public.draft_questions (
        id, draft_paper_id, shared_material_id, position, source_question_number, response_type, content, language,
        source_page, source_reference, source_import_id, extraction_status, teacher_review_status,
        extraction_confidence, warnings, origin, created_by,
        source_bbox, column_index, analysis_regions, review_reasons,
        pairing_confidence, answer_key_source, answer_key_confidence, analysis_run_id)
    SELECT
        (q->>'id')::UUID, v_paper_id, NULLIF(q->>'shared_material_id','')::UUID,
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
    SELECT count(*) INTO v_linked FROM public.draft_questions WHERE draft_paper_id = v_paper_id AND shared_material_id IS NOT NULL;

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
    SET status = 'SUCCEEDED', completed_at = NOW(), draft_paper_id = v_paper_id, pipeline_stage = 'B4.2R',
        metrics = metrics || jsonb_build_object('questions', v_questions, 'options', v_options, 'proposedAnswers', v_proposed,
                                                'sharedMaterials', v_materials, 'questionsWithSharedMaterial', v_linked)
    WHERE id = p_run_id;

    RETURN jsonb_build_object('draft_paper_id', v_paper_id, 'questions', v_questions, 'options', v_options,
                              'proposedAnswers', v_proposed, 'materials', v_materials, 'linkedQuestions', v_linked, 'run_id', p_run_id);
END $$;

-- =========================================================================
-- 5. Automatic material media (figures + Telugu source crops owned by a material).
--    Same contract as 0024/0025: crops uploaded first, atomic, private path, full provenance,
--    refuses teacher work, replaces only this paper's previous AUTO_REGION material media.
-- =========================================================================
CREATE OR REPLACE FUNCTION public.ksc_replace_auto_material_media(
    p_draft_paper_id UUID,
    p_run_id UUID,
    p_media JSONB
) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
    v_uid UUID := auth.uid();
    v_import UUID;
    v_prefix TEXT;
    v_removed TEXT[];
    v_inserted INT := 0;
    v_item JSONB;
BEGIN
    IF v_uid IS NULL OR NOT public.is_teacher() THEN RAISE EXCEPTION 'Teacher access required'; END IF;
    IF jsonb_typeof(p_media) IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'p_media must be a JSON array'; END IF;
    SELECT source_import_id INTO v_import FROM public.draft_papers WHERE id = p_draft_paper_id AND created_by = v_uid FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Draft paper not found or unauthorized'; END IF;
    IF NOT EXISTS (SELECT 1 FROM public.draft_analysis_runs WHERE id = p_run_id AND source_import_id = v_import
                     AND draft_paper_id = p_draft_paper_id AND status = 'SUCCEEDED') THEN
      RAISE EXCEPTION 'KSC_ANALYSIS_RUN_INVALID';
    END IF;
    IF public.ksc_draft_has_teacher_work(p_draft_paper_id) THEN
      RAISE EXCEPTION 'KSC_DRAFT_HAS_TEACHER_WORK';
    END IF;

    v_prefix := 'imports/' || v_uid::text || '/draft-media/' || p_draft_paper_id::text || '/';
    FOR v_item IN SELECT * FROM jsonb_array_elements(p_media) LOOP
      IF coalesce(v_item->>'draft_question_id', '') <> '' OR coalesce(v_item->>'draft_option_id', '') <> '' THEN
        RAISE EXCEPTION 'KSC_AUTO_MATERIAL_OWNER_UNSUPPORTED' USING HINT = 'This writer attaches media to materials only.';
      END IF;
      IF NOT EXISTS (SELECT 1 FROM public.draft_materials mt WHERE mt.id = NULLIF(v_item->>'draft_material_id','')::UUID
                       AND mt.draft_paper_id = p_draft_paper_id AND mt.analysis_run_id = p_run_id) THEN
        RAISE EXCEPTION 'KSC_AUTO_MATERIAL_OWNER_INVALID';
      END IF;
      IF coalesce(v_item->>'media_kind', '') NOT IN ('DIAGRAM','FIGURE','IMAGE','TABLE','CHART','MAP','OTHER','TEXT_REGION') THEN
        RAISE EXCEPTION 'KSC_AUTO_MATERIAL_KIND_INVALID';
      END IF;
      IF v_item->>'storage_path' IS DISTINCT FROM v_prefix || (v_item->>'id') || '.png' THEN
        RAISE EXCEPTION 'KSC_AUTO_MATERIAL_PATH_INVALID';
      END IF;
      IF jsonb_typeof(v_item->'detection_detail') IS DISTINCT FROM 'object'
         OR jsonb_typeof(v_item->'detection_confidence') IS DISTINCT FROM 'number' THEN
        RAISE EXCEPTION 'KSC_AUTO_MATERIAL_PROVENANCE_MISSING';
      END IF;
    END LOOP;

    PERFORM set_config('ksc.auto_visual_writer', 'on', true);
    WITH gone AS (
      DELETE FROM public.draft_media
      WHERE draft_paper_id = p_draft_paper_id AND capture_method = 'AUTO_REGION' AND draft_material_id IS NOT NULL
      RETURNING storage_path)
    SELECT coalesce(array_agg(storage_path), ARRAY[]::TEXT[]) INTO v_removed FROM gone;

    INSERT INTO public.draft_media (
        id, draft_paper_id, draft_material_id, position, media_kind, capture_method,
        storage_path, mime_type, width_px, height_px, source_import_id, source_page,
        region_x, region_y, region_w, region_h, page_width_pt, page_height_pt, render_scale,
        detection_confidence, detection_detail, warnings, created_by)
    SELECT (m->>'id')::UUID, p_draft_paper_id, (m->>'draft_material_id')::UUID,
        COALESCE(NULLIF(m->>'position','')::INTEGER, 0), m->>'media_kind', 'AUTO_REGION',
        m->>'storage_path', 'image/png', NULLIF(m->>'width_px','')::INTEGER, NULLIF(m->>'height_px','')::INTEGER,
        v_import, NULLIF(m->>'source_page','')::INTEGER,
        NULLIF(m->>'region_x','')::NUMERIC, NULLIF(m->>'region_y','')::NUMERIC,
        NULLIF(m->>'region_w','')::NUMERIC, NULLIF(m->>'region_h','')::NUMERIC,
        NULLIF(m->>'page_width_pt','')::NUMERIC, NULLIF(m->>'page_height_pt','')::NUMERIC,
        NULLIF(m->>'render_scale','')::NUMERIC, NULLIF(m->>'detection_confidence','')::NUMERIC,
        m->'detection_detail', COALESCE(m->'warnings','[]'::jsonb), v_uid
    FROM jsonb_array_elements(p_media) AS m;
    GET DIAGNOSTICS v_inserted = ROW_COUNT;
    PERFORM set_config('ksc.auto_visual_writer', 'off', true);

    UPDATE public.draft_analysis_runs
    SET metrics = metrics || jsonb_build_object('autoMaterialMedia', v_inserted)
    WHERE id = p_run_id;
    RETURN jsonb_build_object('inserted', v_inserted, 'removed_paths', to_jsonb(v_removed));
END $$;

-- =========================================================================
-- 6. Writer scopes. 0024 (visuals) and 0025 (Telugu) replaced ALL automatic media of their kind
--    on the paper, which would delete material-owned figures / Telugu crops written by section 5.
--    Redefined here, verbatim except that each replaces QUESTION-owned media only.
-- =========================================================================
CREATE OR REPLACE FUNCTION public.ksc_replace_auto_visuals(
    p_draft_paper_id UUID,
    p_run_id UUID,
    p_media JSONB
) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
    v_uid UUID := auth.uid();
    v_import UUID;
    v_prefix TEXT;
    v_removed TEXT[];
    v_inserted INT := 0;
    v_item JSONB;
BEGIN
    IF v_uid IS NULL OR NOT public.is_teacher() THEN RAISE EXCEPTION 'Teacher access required'; END IF;
    IF p_media IS NULL OR jsonb_typeof(p_media) <> 'array' THEN RAISE EXCEPTION 'p_media must be a JSON array'; END IF;

    SELECT source_import_id INTO v_import FROM public.draft_papers
    WHERE id = p_draft_paper_id AND created_by = v_uid FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Draft paper not found or unauthorized'; END IF;

    IF NOT EXISTS (SELECT 1 FROM public.draft_analysis_runs
                   WHERE id = p_run_id AND source_import_id = v_import
                     AND draft_paper_id = p_draft_paper_id AND status = 'SUCCEEDED') THEN
      RAISE EXCEPTION 'KSC_ANALYSIS_RUN_INVALID' USING HINT = 'Visuals must come from the run that produced this Draft.';
    END IF;

    IF public.ksc_draft_has_teacher_work(p_draft_paper_id) THEN
      RAISE EXCEPTION 'KSC_DRAFT_HAS_TEACHER_WORK'
        USING HINT = 'Automatic visuals cannot replace or join a Draft that contains teacher changes.';
    END IF;

    v_prefix := 'imports/' || v_uid::text || '/draft-media/' || p_draft_paper_id::text || '/';
    FOR v_item IN SELECT * FROM jsonb_array_elements(p_media) LOOP
      IF coalesce(v_item->>'draft_option_id', '') <> '' OR coalesce(v_item->>'draft_material_id', '') <> '' THEN
        RAISE EXCEPTION 'KSC_AUTO_VISUAL_OWNER_UNSUPPORTED' USING HINT = 'Automatic visuals attach to questions only.';
      END IF;
      IF NOT EXISTS (SELECT 1 FROM public.draft_questions q
                     WHERE q.id = NULLIF(v_item->>'draft_question_id','')::UUID
                       AND q.draft_paper_id = p_draft_paper_id AND q.analysis_run_id = p_run_id) THEN
        RAISE EXCEPTION 'KSC_AUTO_VISUAL_OWNER_INVALID' USING HINT = 'Owner must be a question of this Draft and run.';
      END IF;
      IF coalesce(v_item->>'media_kind', '') NOT IN ('DIAGRAM','FIGURE','IMAGE','TABLE','CHART','MAP','OTHER') THEN
        RAISE EXCEPTION 'KSC_AUTO_VISUAL_KIND_INVALID' USING HINT = 'TEXT_REGION is never an automatic visual.';
      END IF;
      IF jsonb_typeof(v_item->'detection_detail') IS DISTINCT FROM 'object'
         OR jsonb_typeof(v_item->'detection_confidence') IS DISTINCT FROM 'number' THEN
        RAISE EXCEPTION 'KSC_AUTO_VISUAL_PROVENANCE_MISSING' USING HINT = 'Detector provenance and confidence are required.';
      END IF;
      IF v_item->>'storage_path' IS DISTINCT FROM v_prefix || (v_item->>'id') || '.png' THEN
        RAISE EXCEPTION 'KSC_AUTO_VISUAL_PATH_INVALID' USING HINT = 'Crops live in the caller''s private Draft media namespace.';
      END IF;
    END LOOP;

    PERFORM set_config('ksc.auto_visual_writer', 'on', true);

    WITH gone AS (
      DELETE FROM public.draft_media
      WHERE draft_paper_id = p_draft_paper_id AND capture_method = 'AUTO_REGION' AND media_kind <> 'TEXT_REGION'
        AND draft_question_id IS NOT NULL      -- 0026: question-owned only; material media has its own writer
      RETURNING storage_path)
    SELECT coalesce(array_agg(storage_path), ARRAY[]::TEXT[]) INTO v_removed FROM gone;

    INSERT INTO public.draft_media (
        id, draft_paper_id, draft_question_id, position, media_kind, capture_method,
        storage_path, mime_type, width_px, height_px, source_import_id, source_page,
        region_x, region_y, region_w, region_h, page_width_pt, page_height_pt, render_scale,
        detection_confidence, detection_detail, warnings, created_by)
    SELECT
        (m->>'id')::UUID, p_draft_paper_id, (m->>'draft_question_id')::UUID,
        COALESCE(NULLIF(m->>'position','')::INTEGER, 0), m->>'media_kind', 'AUTO_REGION',
        m->>'storage_path', 'image/png',
        NULLIF(m->>'width_px','')::INTEGER, NULLIF(m->>'height_px','')::INTEGER, v_import,
        NULLIF(m->>'source_page','')::INTEGER,
        NULLIF(m->>'region_x','')::NUMERIC, NULLIF(m->>'region_y','')::NUMERIC,
        NULLIF(m->>'region_w','')::NUMERIC, NULLIF(m->>'region_h','')::NUMERIC,
        NULLIF(m->>'page_width_pt','')::NUMERIC, NULLIF(m->>'page_height_pt','')::NUMERIC,
        NULLIF(m->>'render_scale','')::NUMERIC,
        NULLIF(m->>'detection_confidence','')::NUMERIC, m->'detection_detail',
        COALESCE(m->'warnings','[]'::jsonb), v_uid
    FROM jsonb_array_elements(p_media) AS m;
    GET DIAGNOSTICS v_inserted = ROW_COUNT;

    PERFORM set_config('ksc.auto_visual_writer', 'off', true);

    UPDATE public.draft_analysis_runs
    SET metrics = metrics || jsonb_build_object('autoVisuals', v_inserted, 'autoVisualsReplaced', coalesce(array_length(v_removed, 1), 0))
    WHERE id = p_run_id;

    RETURN jsonb_build_object('inserted', v_inserted, 'removed_paths', to_jsonb(v_removed));
END $$;

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
        AND draft_question_id IS NOT NULL      -- 0026: question-owned only; material media has its own writer
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

REVOKE ALL ON FUNCTION public.ksc_replace_draft_analysis_v3(UUID, UUID, JSONB, JSONB, JSONB, JSONB) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.ksc_replace_auto_material_media(UUID, UUID, JSONB) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.ksc_replace_draft_analysis_v3(UUID, UUID, JSONB, JSONB, JSONB, JSONB) TO authenticated;
GRANT EXECUTE ON FUNCTION public.ksc_replace_auto_material_media(UUID, UUID, JSONB) TO authenticated;

COMMIT;
