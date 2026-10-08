-- KSC B4.3 — automatic Draft visuals (NEW guarded forward migration; requires 0023)
--
-- Lets automatic preparation attach detector-produced crops (capture_method AUTO_REGION)
-- to Draft questions WITHOUT turning them into teacher work, while keeping every existing
-- Retry-protection guarantee:
--   * teacher/manual media (SOURCE_REGION, TEACHER_UPLOAD) is still teacher work;
--   * an AUTO_REGION row a teacher has edited (updated or captioned) becomes teacher work;
--   * automatic replacement is refused whenever the Draft holds any teacher work;
--   * AUTO_REGION rows can only be written by the automatic writer below, so a manual
--     visual can never masquerade as automatic (and be silently replaced);
--   * AUTO_REGION rows must carry full provenance and a detection confidence;
--   * the writer accepts question-owned visual kinds only (never TEXT_REGION, never an
--     option or material owner) and only for questions of the given analysis run;
--   * storage stays in the caller's private Draft media namespace (0019 contract).
--
-- Migrations 0001-0023 are not edited. No Question Bank, snapshot, publish, attempt,
-- evaluation, storage-policy or bucket object is touched; the bucket stays private.
BEGIN;

DO $$ BEGIN
 IF to_regclass('public.organizations') IS NOT NULL OR to_regprocedure('ksc_private.provision_student()') IS NULL
 THEN RAISE EXCEPTION 'Expected isolated KSC baseline'; END IF;
 IF to_regclass('public.draft_analysis_runs') IS NULL
    OR to_regprocedure('public.ksc_replace_draft_analysis_v2(uuid,uuid,jsonb,jsonb,jsonb)') IS NULL THEN
  RAISE EXCEPTION 'Missing B4.2 objects. Ensure 0023 is applied.';
 END IF;
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'draft_media_capture_method_v2') THEN
  RAISE EXCEPTION 'Missing AUTO_REGION capture method. Ensure 0023 is applied.';
 END IF;
END $$;

-- =========================================================================
-- 1. Detection provenance and AUTO_REGION integrity.
-- =========================================================================
ALTER TABLE public.draft_media
  ADD COLUMN IF NOT EXISTS detection_detail JSONB;   -- detector, version, tier, ink box, run

ALTER TABLE public.draft_media DROP CONSTRAINT IF EXISTS draft_media_detection_confidence_range;
ALTER TABLE public.draft_media ADD CONSTRAINT draft_media_detection_confidence_range
  CHECK (detection_confidence IS NULL OR (detection_confidence >= 0 AND detection_confidence <= 1));

ALTER TABLE public.draft_media DROP CONSTRAINT IF EXISTS draft_media_auto_region_provenance;
ALTER TABLE public.draft_media ADD CONSTRAINT draft_media_auto_region_provenance CHECK (
  capture_method <> 'AUTO_REGION'
  OR (source_page IS NOT NULL AND region_x IS NOT NULL
      AND page_width_pt IS NOT NULL AND page_height_pt IS NOT NULL
      AND render_scale IS NOT NULL AND width_px IS NOT NULL AND height_px IS NOT NULL
      AND detection_confidence IS NOT NULL AND jsonb_typeof(detection_detail) = 'object')
);

-- AUTO_REGION rows are created only inside ksc_replace_auto_visuals (transaction flag).
CREATE OR REPLACE FUNCTION public.ksc_guard_auto_region_media() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF NEW.capture_method = 'AUTO_REGION'
     AND (TG_OP = 'INSERT' OR OLD.capture_method IS DISTINCT FROM 'AUTO_REGION')
     AND coalesce(current_setting('ksc.auto_visual_writer', true), '') <> 'on' THEN
    RAISE EXCEPTION 'KSC_AUTO_REGION_WRITER_ONLY'
      USING HINT = 'Automatic visuals can only be written by ksc_replace_auto_visuals.';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.ksc_guard_auto_region_media() FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS guard_auto_region_media ON public.draft_media;
CREATE TRIGGER guard_auto_region_media BEFORE INSERT OR UPDATE ON public.draft_media
FOR EACH ROW EXECUTE FUNCTION public.ksc_guard_auto_region_media();

-- =========================================================================
-- 2. Retry safety: untouched automatic crops are not teacher work. Everything else is
--    identical to the 0022 definition (additive redefinition pattern).
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

-- =========================================================================
-- 3. Automatic visual writer. Atomic: validates everything, replaces only this paper's
--    previous automatic VISUAL crops (never manual media, never TEXT_REGION), inserts the
--    new rows, and returns the storage paths of the replaced rows so the caller can remove
--    those private objects. Crops must already be uploaded; a failure here writes nothing.
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

REVOKE ALL ON FUNCTION public.ksc_replace_auto_visuals(UUID, UUID, JSONB) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.ksc_replace_auto_visuals(UUID, UUID, JSONB) TO authenticated;

COMMIT;
