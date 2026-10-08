-- KSC B4.5 — exception review model (NEW guarded forward migration; needs 0026)
--
-- The Draft already records WHY something needs review (review_reasons on questions/materials,
-- ocr_review_reasons on language rows) but not a reviewable unit, its resolution, or who resolved
-- it. This migration adds:
--   * draft_review_items — one row per granular review item (Telugu stem / option, shared-material
--     Telugu, visual, abnormal/empty option, answer key, unowned text, structure), owned by exactly
--     one question, option or shared material, with source page/crop/region, extracted value,
--     confidence, machine reasons, resolution state and teacher resolution provenance;
--   * verification provenance on Telugu language rows (accepted OCR stays OCR_EXTRACTED; edited
--     OCR becomes TEACHER_ENTERED but keeps the original OCR text and a verification state — OCR
--     history is never rewritten to look teacher-entered, including by a direct table write);
--   * draft_material_texts — a shared material's language versions (resolved once for every
--     question that references it);
--   * draft_question_readiness — readiness DERIVED from open blocking items (question + options +
--     shared material). No separate status is maintained;
--   * writer + resolution RPCs. Items are written only through them (no direct table writes).
-- Resolving any item never confirms an answer and never creates or edits options.
--
-- Migrations 0001-0026 are not edited. No Question Bank, snapshot, publish, attempt,
-- evaluation, storage-policy or bucket object is touched.
BEGIN;

DO $$ BEGIN
 IF to_regclass('public.organizations') IS NOT NULL OR to_regprocedure('ksc_private.provision_student()') IS NULL
 THEN RAISE EXCEPTION 'Expected isolated KSC baseline'; END IF;
 IF to_regprocedure('public.ksc_replace_draft_analysis_v3(uuid,uuid,jsonb,jsonb,jsonb,jsonb)') IS NULL THEN
  RAISE EXCEPTION 'Missing B4.2R objects. Ensure 0026 is applied.';
 END IF;
END $$;

-- =========================================================================
-- 1. Verification provenance on Telugu language rows.
-- =========================================================================
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['draft_question_texts', 'draft_option_texts'] LOOP
    EXECUTE format('ALTER TABLE public.%I ADD COLUMN IF NOT EXISTS verification_state TEXT', t);
    EXECUTE format('ALTER TABLE public.%I ADD COLUMN IF NOT EXISTS verified_by UUID REFERENCES auth.users(id) ON DELETE SET NULL', t);
    EXECUTE format('ALTER TABLE public.%I ADD COLUMN IF NOT EXISTS verified_at TIMESTAMPTZ', t);
    EXECUTE format('ALTER TABLE public.%I ADD COLUMN IF NOT EXISTS ocr_original_content TEXT', t);
    EXECUTE format('ALTER TABLE public.%I DROP CONSTRAINT IF EXISTS %I', t, t || '_verification_state_valid');
    EXECUTE format($f$ALTER TABLE public.%I ADD CONSTRAINT %I CHECK (verification_state IS NULL OR verification_state IN
      ('VERIFIED_OCR','EDITED_FROM_OCR','TEACHER_TRANSCRIBED','MARKED_MISSING'))$f$, t, t || '_verification_state_valid');
    EXECUTE format('ALTER TABLE public.%I DROP CONSTRAINT IF EXISTS %I', t, t || '_verification_provenance');
    EXECUTE format($f$ALTER TABLE public.%I ADD CONSTRAINT %I CHECK (verification_state IS NULL
      OR (verified_by IS NOT NULL AND verified_at IS NOT NULL))$f$, t, t || '_verification_provenance');
  END LOOP;
END $$;

-- OCR history cannot be rewritten by a direct table write (the 0022 policy lets a teacher UPDATE
-- their own language rows):
--   * verification columns change only inside the review RPCs (transaction flag);
--   * ocr_original_content is write-once, and is set only by the RPCs or by this trigger;
--   * a direct edit of OCR-provenanced text keeps the original OCR and is recorded as EDITED_FROM_OCR
--     by the editing teacher — it never looks originally teacher-entered.
CREATE OR REPLACE FUNCTION public.ksc_guard_text_verification() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE v_rpc BOOLEAN := coalesce(current_setting('ksc.review_resolution', true), '') = 'on';
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NOT v_rpc AND (NEW.verification_state IS NOT NULL OR NEW.verified_by IS NOT NULL OR NEW.verified_at IS NOT NULL OR NEW.ocr_original_content IS NOT NULL) THEN
      RAISE EXCEPTION 'KSC_VERIFICATION_RPC_ONLY';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.ocr_original_content IS NOT NULL THEN NEW.ocr_original_content := OLD.ocr_original_content; END IF;
  IF v_rpc THEN RETURN NEW; END IF;
  IF NEW.verification_state IS DISTINCT FROM OLD.verification_state OR NEW.verified_by IS DISTINCT FROM OLD.verified_by
     OR NEW.verified_at IS DISTINCT FROM OLD.verified_at OR NEW.ocr_original_content IS DISTINCT FROM OLD.ocr_original_content THEN
    RAISE EXCEPTION 'KSC_VERIFICATION_RPC_ONLY' USING HINT = 'Verification is recorded by ksc_resolve_telugu_review_item.';
  END IF;
  IF (OLD.text_quality = 'OCR_EXTRACTED' OR OLD.ocr_original_content IS NOT NULL)
     AND (NEW.content IS DISTINCT FROM OLD.content OR NEW.text_quality IS DISTINCT FROM OLD.text_quality) THEN
    NEW.ocr_original_content := coalesce(OLD.ocr_original_content, OLD.content);
    IF auth.uid() IS NOT NULL THEN      -- a teacher's edit; a database administrator's edit keeps the original only
      NEW.verification_state := CASE WHEN NEW.content IS NULL THEN 'MARKED_MISSING' ELSE 'EDITED_FROM_OCR' END;
      NEW.verified_by := auth.uid();
      NEW.verified_at := NOW();
    END IF;
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.ksc_guard_text_verification() FROM PUBLIC, anon, authenticated, service_role;
DROP TRIGGER IF EXISTS guard_text_verification_question ON public.draft_question_texts;
CREATE TRIGGER guard_text_verification_question BEFORE INSERT OR UPDATE ON public.draft_question_texts
FOR EACH ROW EXECUTE FUNCTION public.ksc_guard_text_verification();
DROP TRIGGER IF EXISTS guard_text_verification_option ON public.draft_option_texts;
CREATE TRIGGER guard_text_verification_option BEFORE INSERT OR UPDATE ON public.draft_option_texts
FOR EACH ROW EXECUTE FUNCTION public.ksc_guard_text_verification();

-- =========================================================================
-- 2. Shared-material language versions (e.g. the Telugu of a Directions block).
-- =========================================================================
CREATE TABLE IF NOT EXISTS public.draft_material_texts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    draft_material_id UUID NOT NULL REFERENCES public.draft_materials(id) ON DELETE CASCADE,
    language TEXT NOT NULL CHECK (language ~ '^[a-z]{2}(-[A-Z]{2})?$'),
    content TEXT,
    text_quality TEXT NOT NULL CHECK (text_quality IN ('TEACHER_ENTERED','MISSING')),
    source TEXT NOT NULL DEFAULT 'TEACHER' CHECK (source IN ('TEACHER')),
    source_media_id UUID REFERENCES public.draft_media(id) ON DELETE SET NULL,
    verification_state TEXT CHECK (verification_state IN ('TEACHER_TRANSCRIBED','MARKED_MISSING')),
    verified_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    verified_at TIMESTAMPTZ,
    created_by UUID NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT DEFAULT auth.uid(),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    CONSTRAINT draft_material_texts_one_per_language UNIQUE (draft_material_id, language),
    CONSTRAINT draft_material_texts_no_legacy_glyphs CHECK (content IS NULL OR content !~ '[\uE000-\uF8FF\uFFFD]')
);
ALTER TABLE public.draft_material_texts ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Teachers read own draft material texts" ON public.draft_material_texts;
CREATE POLICY "Teachers read own draft material texts" ON public.draft_material_texts FOR SELECT TO authenticated
USING (public.is_teacher() AND EXISTS (SELECT 1 FROM public.draft_materials m JOIN public.draft_papers p ON p.id = m.draft_paper_id
  WHERE m.id = draft_material_texts.draft_material_id AND p.created_by = auth.uid()));
REVOKE ALL ON public.draft_material_texts FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.draft_material_texts TO authenticated;

-- =========================================================================
-- 3. Review items.
-- =========================================================================
CREATE TABLE IF NOT EXISTS public.draft_review_items (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    draft_paper_id UUID NOT NULL REFERENCES public.draft_papers(id) ON DELETE CASCADE,
    item_key TEXT NOT NULL,
    item_type TEXT NOT NULL CHECK (item_type IN ('TELUGU_STEM','TELUGU_OPTION','TELUGU_VERIFY','TELUGU_STRUCTURE_AMBIGUOUS',
        'MATERIAL_TELUGU','MATERIAL_VISUAL_MISSING','MATERIAL_VISUAL_VERIFY','MATERIAL_RANGE_UNLINKED',
        'QUESTION_VISUAL_MISSING','QUESTION_VISUAL_VERIFY','OPTION_SET_ABNORMAL','OPTION_EMPTY','ANSWER_KEY',
        'UNASSIGNED_TEXT','ENGLISH_STEM_MISSING','STRUCTURE')),
    route TEXT NOT NULL CHECK (route IN ('QUICK_CHECK','MANUAL_REVIEW','ADVISORY')),
    blocking BOOLEAN NOT NULL,
    effort TEXT CHECK (effort IN ('ONE_CLICK_ACCEPT','SHORT_CORRECTION','TRANSCRIPTION','MANUAL_INVESTIGATION')),
    draft_question_id UUID REFERENCES public.draft_questions(id) ON DELETE CASCADE,
    draft_option_id UUID REFERENCES public.draft_options(id) ON DELETE CASCADE,
    draft_material_id UUID REFERENCES public.draft_materials(id) ON DELETE CASCADE,
    target_question_text_id UUID REFERENCES public.draft_question_texts(id) ON DELETE SET NULL,
    target_option_text_id UUID REFERENCES public.draft_option_texts(id) ON DELETE SET NULL,
    source_page INTEGER,
    source_media_id UUID REFERENCES public.draft_media(id) ON DELETE SET NULL,
    source_region JSONB,
    extracted_value TEXT,
    confidence NUMERIC CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
    machine_reasons JSONB NOT NULL DEFAULT '[]'::jsonb,
    detail JSONB NOT NULL DEFAULT '{}'::jsonb,
    status TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','DEFERRED','RESOLVED')),
    resolution TEXT CHECK (resolution IN ('ACCEPTED_OCR','EDITED_OCR','TRANSCRIBED','MARKED_MISSING','RESOLVED','ACCEPTED_AS_IS')),
    resolution_value TEXT,
    resolution_note TEXT,
    resolved_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    resolved_at TIMESTAMPTZ,
    origin_run_id UUID REFERENCES public.draft_analysis_runs(id) ON DELETE SET NULL,
    generator TEXT NOT NULL,
    created_by UUID NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT DEFAULT auth.uid(),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    CONSTRAINT draft_review_items_one_key UNIQUE (draft_paper_id, item_key),
    CONSTRAINT draft_review_items_exactly_one_owner CHECK (num_nonnulls(draft_question_id, draft_option_id, draft_material_id) = 1),
    CONSTRAINT draft_review_items_route_blocking CHECK ((route = 'ADVISORY') = (NOT blocking)),
    CONSTRAINT draft_review_items_resolution_consistent CHECK (
      (status = 'RESOLVED' AND resolution IS NOT NULL AND resolved_by IS NOT NULL AND resolved_at IS NOT NULL)
      OR (status IN ('OPEN','DEFERRED') AND resolution IS NULL))
);
CREATE INDEX IF NOT EXISTS idx_draft_review_items_paper ON public.draft_review_items(draft_paper_id);
CREATE INDEX IF NOT EXISTS idx_draft_review_items_question ON public.draft_review_items(draft_question_id);
CREATE INDEX IF NOT EXISTS idx_draft_review_items_option ON public.draft_review_items(draft_option_id);
CREATE INDEX IF NOT EXISTS idx_draft_review_items_material ON public.draft_review_items(draft_material_id);

-- Owner, target text and crop must all belong to the item's Draft paper.
CREATE OR REPLACE FUNCTION public.ksc_guard_review_item() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE v_paper UUID;
BEGIN
  IF NEW.draft_question_id IS NOT NULL THEN SELECT draft_paper_id INTO v_paper FROM public.draft_questions WHERE id = NEW.draft_question_id;
  ELSIF NEW.draft_option_id IS NOT NULL THEN SELECT q.draft_paper_id INTO v_paper FROM public.draft_options o JOIN public.draft_questions q ON q.id = o.draft_question_id WHERE o.id = NEW.draft_option_id;
  ELSE SELECT draft_paper_id INTO v_paper FROM public.draft_materials WHERE id = NEW.draft_material_id; END IF;
  IF v_paper IS DISTINCT FROM NEW.draft_paper_id THEN RAISE EXCEPTION 'KSC_REVIEW_ITEM_WRONG_PAPER'; END IF;
  IF NEW.source_media_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.draft_media WHERE id = NEW.source_media_id AND draft_paper_id = NEW.draft_paper_id) THEN
    RAISE EXCEPTION 'KSC_REVIEW_ITEM_WRONG_PAPER';
  END IF;
  IF NEW.target_question_text_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.draft_question_texts t
       WHERE t.id = NEW.target_question_text_id AND t.draft_question_id = NEW.draft_question_id) THEN
    RAISE EXCEPTION 'KSC_REVIEW_ITEM_TARGET_MISMATCH';
  END IF;
  IF NEW.target_option_text_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.draft_option_texts t
       WHERE t.id = NEW.target_option_text_id AND t.draft_option_id = NEW.draft_option_id) THEN
    RAISE EXCEPTION 'KSC_REVIEW_ITEM_TARGET_MISMATCH';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.ksc_guard_review_item() FROM PUBLIC, anon, authenticated, service_role;
DROP TRIGGER IF EXISTS guard_review_item ON public.draft_review_items;
CREATE TRIGGER guard_review_item BEFORE INSERT OR UPDATE ON public.draft_review_items FOR EACH ROW EXECUTE FUNCTION public.ksc_guard_review_item();

ALTER TABLE public.draft_review_items ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Teachers read own review items" ON public.draft_review_items;
CREATE POLICY "Teachers read own review items" ON public.draft_review_items FOR SELECT TO authenticated
USING (public.is_teacher() AND EXISTS (SELECT 1 FROM public.draft_papers p WHERE p.id = draft_review_items.draft_paper_id AND p.created_by = auth.uid()));
REVOKE ALL ON public.draft_review_items FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.draft_review_items TO authenticated;     -- writes only through the RPCs below

-- =========================================================================
-- 4. Readiness, derived — never stored. A shared material's open items count for every question
--    that references it; resolving the material item once clears them all.
-- =========================================================================
CREATE OR REPLACE VIEW public.draft_question_readiness WITH (security_invoker = true) AS
WITH attributed AS (
  SELECT COALESCE(i.draft_question_id, o.draft_question_id) AS draft_question_id, i.route, i.blocking, i.status
  FROM public.draft_review_items i LEFT JOIN public.draft_options o ON o.id = i.draft_option_id
  WHERE i.draft_material_id IS NULL
  UNION ALL
  SELECT q.id, i.route, i.blocking, i.status
  FROM public.draft_review_items i JOIN public.draft_questions q ON q.shared_material_id = i.draft_material_id
)
SELECT q.id AS draft_question_id, q.draft_paper_id, q.source_question_number, q.position,
  count(a.*) FILTER (WHERE a.blocking AND a.status <> 'RESOLVED') AS open_blocking,
  count(a.*) FILTER (WHERE a.blocking AND a.status <> 'RESOLVED' AND a.route = 'MANUAL_REVIEW') AS open_manual,
  count(a.*) FILTER (WHERE a.blocking AND a.status <> 'RESOLVED' AND a.route = 'QUICK_CHECK') AS open_quick,
  count(a.*) FILTER (WHERE NOT a.blocking AND a.status <> 'RESOLVED') AS open_advisory,
  CASE WHEN count(a.*) FILTER (WHERE a.blocking AND a.status <> 'RESOLVED' AND a.route = 'MANUAL_REVIEW') > 0 THEN 'MANUAL_REVIEW'
       WHEN count(a.*) FILTER (WHERE a.blocking AND a.status <> 'RESOLVED') > 0 THEN 'QUICK_CHECK'
       ELSE 'READY' END AS readiness
FROM public.draft_questions q LEFT JOIN attributed a ON a.draft_question_id = q.id
GROUP BY q.id, q.draft_paper_id, q.source_question_number, q.position;
REVOKE ALL ON public.draft_question_readiness FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.draft_question_readiness TO authenticated;

-- =========================================================================
-- 5. Retry safety = 0026 definition + any teacher resolution or material text.
-- =========================================================================
CREATE OR REPLACE FUNCTION public.ksc_draft_has_teacher_work(p_draft_paper_id UUID)
RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY INVOKER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.draft_questions q
    WHERE q.draft_paper_id = p_draft_paper_id
      AND (q.origin = 'TEACHER' OR q.teacher_review_status <> 'UNREVIEWED' OR q.confirmed_by IS NOT NULL OR q.confirmed_at IS NOT NULL)
  ) OR EXISTS (
    SELECT 1 FROM public.draft_options o JOIN public.draft_questions q ON q.id = o.draft_question_id
    WHERE q.draft_paper_id = p_draft_paper_id AND (o.origin = 'TEACHER' OR o.is_confirmed_correct OR o.updated_at > o.created_at)
  ) OR EXISTS (
    SELECT 1 FROM public.draft_media m
    WHERE m.draft_paper_id = p_draft_paper_id AND (m.capture_method <> 'AUTO_REGION' OR m.caption IS NOT NULL OR m.updated_at > m.created_at)
  ) OR EXISTS (
    SELECT 1 FROM public.draft_question_texts t JOIN public.draft_questions q ON q.id = t.draft_question_id
    WHERE q.draft_paper_id = p_draft_paper_id AND (t.source = 'TEACHER' OR t.text_quality = 'TEACHER_ENTERED' OR t.updated_at > t.created_at)
  ) OR EXISTS (
    SELECT 1 FROM public.draft_option_texts t JOIN public.draft_options o ON o.id = t.draft_option_id JOIN public.draft_questions q ON q.id = o.draft_question_id
    WHERE q.draft_paper_id = p_draft_paper_id AND (t.source = 'TEACHER' OR t.text_quality = 'TEACHER_ENTERED' OR t.updated_at > t.created_at)
  ) OR EXISTS (
    SELECT 1 FROM public.draft_materials mt WHERE mt.draft_paper_id = p_draft_paper_id AND (mt.origin = 'TEACHER' OR mt.updated_at > mt.created_at)
  ) OR EXISTS (
    SELECT 1 FROM public.draft_material_texts mx JOIN public.draft_materials mt ON mt.id = mx.draft_material_id WHERE mt.draft_paper_id = p_draft_paper_id
  ) OR EXISTS (
    SELECT 1 FROM public.draft_review_items ri WHERE ri.draft_paper_id = p_draft_paper_id AND ri.status <> 'OPEN'
  );
$$;
REVOKE ALL ON FUNCTION public.ksc_draft_has_teacher_work(UUID) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.ksc_draft_has_teacher_work(UUID) TO authenticated;

-- =========================================================================
-- 6. Automatic item writer. Replaces this paper's items atomically; refused once any teacher work
--    (including any resolution) exists.
-- =========================================================================
CREATE OR REPLACE FUNCTION public.ksc_replace_review_items(p_draft_paper_id UUID, p_run_id UUID, p_generator TEXT, p_items JSONB)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE v_uid UUID := auth.uid(); v_import UUID; v_n INT := 0;
BEGIN
  IF v_uid IS NULL OR NOT public.is_teacher() THEN RAISE EXCEPTION 'Teacher access required'; END IF;
  IF jsonb_typeof(p_items) IS DISTINCT FROM 'array' OR coalesce(p_generator, '') = '' THEN RAISE EXCEPTION 'p_items (array) and p_generator are required'; END IF;
  SELECT source_import_id INTO v_import FROM public.draft_papers WHERE id = p_draft_paper_id AND created_by = v_uid FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Draft paper not found or unauthorized'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.draft_analysis_runs WHERE id = p_run_id AND draft_paper_id = p_draft_paper_id AND status = 'SUCCEEDED') THEN
    RAISE EXCEPTION 'KSC_ANALYSIS_RUN_INVALID';
  END IF;
  IF public.ksc_draft_has_teacher_work(p_draft_paper_id) THEN RAISE EXCEPTION 'KSC_DRAFT_HAS_TEACHER_WORK'; END IF;
  DELETE FROM public.draft_review_items WHERE draft_paper_id = p_draft_paper_id;
  INSERT INTO public.draft_review_items (draft_paper_id, item_key, item_type, route, blocking, effort,
      draft_question_id, draft_option_id, draft_material_id, target_question_text_id, target_option_text_id,
      source_page, source_media_id, source_region, extracted_value, confidence, machine_reasons, detail,
      origin_run_id, generator, created_by)
  SELECT p_draft_paper_id, i->>'item_key', i->>'item_type', i->>'route', (i->>'blocking')::BOOLEAN, i->>'effort',
      NULLIF(i->>'draft_question_id','')::UUID, NULLIF(i->>'draft_option_id','')::UUID, NULLIF(i->>'draft_material_id','')::UUID,
      NULLIF(i->>'target_question_text_id','')::UUID, NULLIF(i->>'target_option_text_id','')::UUID,
      NULLIF(i->>'source_page','')::INTEGER, NULLIF(i->>'source_media_id','')::UUID, i->'source_region',
      i->>'extracted_value', NULLIF(i->>'confidence','')::NUMERIC, COALESCE(i->'machine_reasons','[]'::jsonb), COALESCE(i->'detail','{}'::jsonb),
      p_run_id, p_generator, v_uid
  FROM jsonb_array_elements(p_items) AS i;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  UPDATE public.draft_analysis_runs SET metrics = metrics || jsonb_build_object('reviewItems', v_n) WHERE id = p_run_id;
  RETURN jsonb_build_object('items', v_n);
END $$;

-- Common lookup for the resolution RPCs: the caller must own the item's paper.
CREATE OR REPLACE FUNCTION public.ksc_review_item_for_update(p_item_id UUID) RETURNS public.draft_review_items
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE r public.draft_review_items;
BEGIN
  IF auth.uid() IS NULL OR NOT public.is_teacher() THEN RAISE EXCEPTION 'Teacher access required'; END IF;
  SELECT i.* INTO r FROM public.draft_review_items i JOIN public.draft_papers p ON p.id = i.draft_paper_id
  WHERE i.id = p_item_id AND p.created_by = auth.uid() FOR UPDATE OF i;
  IF NOT FOUND THEN RAISE EXCEPTION 'Review item not found or unauthorized'; END IF;
  IF r.status = 'RESOLVED' THEN RAISE EXCEPTION 'KSC_REVIEW_ITEM_ALREADY_RESOLVED'; END IF;
  RETURN r;
END $$;
REVOKE ALL ON FUNCTION public.ksc_review_item_for_update(UUID) FROM PUBLIC, anon, authenticated, service_role;

-- =========================================================================
-- 7. Telugu items: ACCEPT (OCR as-is) | EDIT (teacher text) | MARK_MISSING | DEFER.
--    Never touches options or answer flags.
-- =========================================================================
CREATE OR REPLACE FUNCTION public.ksc_resolve_telugu_review_item(p_item_id UUID, p_action TEXT, p_text TEXT DEFAULT NULL, p_note TEXT DEFAULT NULL)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  r public.draft_review_items;
  v_uid UUID := auth.uid();
  v_tbl TEXT; v_row_id UUID; v_content TEXT; v_quality TEXT; v_resolution TEXT; v_media UUID; v_attempt TEXT;
BEGIN
  r := public.ksc_review_item_for_update(p_item_id);
  IF r.item_type NOT IN ('TELUGU_STEM','TELUGU_OPTION','TELUGU_VERIFY','MATERIAL_TELUGU') THEN RAISE EXCEPTION 'KSC_NOT_A_TELUGU_ITEM'; END IF;
  IF p_action NOT IN ('ACCEPT','EDIT','MARK_MISSING','DEFER') THEN RAISE EXCEPTION 'KSC_TELUGU_ACTION_INVALID'; END IF;
  IF p_action = 'DEFER' THEN
    UPDATE public.draft_review_items SET status = 'DEFERRED', resolution_note = p_note, updated_at = NOW() WHERE id = r.id;
    RETURN jsonb_build_object('status', 'DEFERRED');
  END IF;
  IF p_action = 'EDIT' AND (coalesce(btrim(p_text), '') = '' OR p_text ~ '[\uE000-\uF8FF\uFFFD]') THEN
    RAISE EXCEPTION 'KSC_TELUGU_TEXT_INVALID' USING HINT = 'Type the Telugu; legacy PDF glyphs cannot be stored.';
  END IF;
  PERFORM set_config('ksc.review_resolution', 'on', true);   -- verification columns may change (section 1 guard)

  -- Shared material: stored once in draft_material_texts, for every linked question.
  IF r.item_type = 'MATERIAL_TELUGU' THEN
    IF p_action = 'ACCEPT' THEN RAISE EXCEPTION 'KSC_NOTHING_TO_ACCEPT' USING HINT = 'This material has no OCR text; type it or mark it missing.'; END IF;
    INSERT INTO public.draft_material_texts (draft_material_id, language, content, text_quality, source, source_media_id, verification_state, verified_by, verified_at, created_by)
    VALUES (r.draft_material_id, 'te', CASE WHEN p_action = 'EDIT' THEN p_text END, CASE WHEN p_action = 'EDIT' THEN 'TEACHER_ENTERED' ELSE 'MISSING' END,
            'TEACHER', r.source_media_id, CASE WHEN p_action = 'EDIT' THEN 'TEACHER_TRANSCRIBED' ELSE 'MARKED_MISSING' END, v_uid, NOW(), v_uid)
    ON CONFLICT (draft_material_id, language) DO UPDATE SET content = EXCLUDED.content, text_quality = EXCLUDED.text_quality,
      verification_state = EXCLUDED.verification_state, verified_by = EXCLUDED.verified_by, verified_at = EXCLUDED.verified_at, updated_at = NOW();
    v_resolution := CASE WHEN p_action = 'EDIT' THEN 'TRANSCRIBED' ELSE 'MARKED_MISSING' END;
  ELSE
    IF r.target_question_text_id IS NOT NULL THEN v_tbl := 'draft_question_texts'; v_row_id := r.target_question_text_id;
    ELSE v_tbl := 'draft_option_texts'; v_row_id := r.target_option_text_id; END IF;
    IF v_row_id IS NULL THEN RAISE EXCEPTION 'KSC_REVIEW_ITEM_TARGET_MISSING'; END IF;
    EXECUTE format('SELECT content, text_quality, source_media_id FROM public.%I WHERE id = $1 FOR UPDATE', v_tbl) INTO v_content, v_quality, v_media USING v_row_id;
    -- The unstored OCR attempt is read from the row's own automatic crop (written by the OCR
    -- writer), never from the item's client-supplied extracted_value.
    SELECT m.detection_detail->>'ocrText' INTO v_attempt FROM public.draft_media m
    WHERE m.id = v_media AND m.capture_method = 'AUTO_REGION' AND m.draft_paper_id = r.draft_paper_id;
    IF v_attempt IS NOT NULL AND v_attempt !~ '[\u0C00-\u0C7F]' THEN v_attempt := NULL; END IF;

    IF p_action = 'ACCEPT' THEN
      IF v_quality = 'OCR_EXTRACTED' AND v_content IS NOT NULL THEN
        -- Accepted unchanged: still OCR_EXTRACTED, now with teacher verification provenance.
        EXECUTE format('UPDATE public.%I SET verification_state = ''VERIFIED_OCR'', verified_by = $2, verified_at = NOW(), updated_at = NOW() WHERE id = $1', v_tbl)
          USING v_row_id, v_uid;
      ELSIF v_quality = 'MISSING' AND v_attempt IS NOT NULL THEN
        -- The teacher accepts the OCR attempt that was not stored automatically: it becomes OCR text,
        -- verified by the teacher (never TEACHER_ENTERED — the words came from OCR).
        PERFORM set_config('ksc.auto_telugu_writer', 'on', true);
        EXECUTE format('UPDATE public.%I SET content = $3, text_quality = ''OCR_EXTRACTED'', ocr_original_content = $3,
          verification_state = ''VERIFIED_OCR'', verified_by = $2, verified_at = NOW(), updated_at = NOW() WHERE id = $1', v_tbl)
          USING v_row_id, v_uid, v_attempt;
        PERFORM set_config('ksc.auto_telugu_writer', 'off', true);
      ELSE
        RAISE EXCEPTION 'KSC_NOTHING_TO_ACCEPT' USING HINT = 'No usable OCR text; edit it or mark it missing.';
      END IF;
      v_resolution := 'ACCEPTED_OCR';
    ELSIF p_action = 'EDIT' THEN
      -- Teacher text, with the original OCR (stored text or attempt) kept beside it.
      EXECUTE format('UPDATE public.%I SET ocr_original_content = COALESCE(ocr_original_content, content, $4), content = $3,
        text_quality = ''TEACHER_ENTERED'', source = ''TEACHER'',
        verification_state = CASE WHEN COALESCE(content, $4) IS NULL THEN ''TEACHER_TRANSCRIBED'' ELSE ''EDITED_FROM_OCR'' END,
        verified_by = $2, verified_at = NOW(), updated_at = NOW() WHERE id = $1', v_tbl)
        USING v_row_id, v_uid, p_text, v_attempt;
      v_resolution := CASE WHEN COALESCE(v_content, v_attempt) IS NULL THEN 'TRANSCRIBED' ELSE 'EDITED_OCR' END;
    ELSE
      EXECUTE format('UPDATE public.%I SET ocr_original_content = COALESCE(ocr_original_content, content, $3), content = NULL, text_quality = ''MISSING'',
        verification_state = ''MARKED_MISSING'', verified_by = $2, verified_at = NOW(), updated_at = NOW() WHERE id = $1', v_tbl)
        USING v_row_id, v_uid, v_attempt;
      v_resolution := 'MARKED_MISSING';
    END IF;
  END IF;

  UPDATE public.draft_review_items SET status = 'RESOLVED', resolution = v_resolution, resolution_value = CASE WHEN p_action = 'EDIT' THEN p_text END,
    resolution_note = p_note, resolved_by = v_uid, resolved_at = NOW(), updated_at = NOW() WHERE id = r.id;
  PERFORM set_config('ksc.review_resolution', 'off', true);
  RETURN jsonb_build_object('status', 'RESOLVED', 'resolution', v_resolution);
END $$;

-- =========================================================================
-- 8. Other items: RESOLVED (the defect was fixed elsewhere), ACCEPTED_AS_IS (with a note), DEFER.
--    Answer-key and empty-option items cannot be closed while the defect remains, and cannot be
--    "accepted as is" — no invented option text, no answer confirmation, ever.
-- =========================================================================
CREATE OR REPLACE FUNCTION public.ksc_resolve_review_item(p_item_id UUID, p_resolution TEXT, p_note TEXT DEFAULT NULL)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE r public.draft_review_items; v_uid UUID := auth.uid(); v_proposed INT; v_blank INT;
BEGIN
  r := public.ksc_review_item_for_update(p_item_id);
  IF r.item_type IN ('TELUGU_STEM','TELUGU_OPTION','TELUGU_VERIFY','MATERIAL_TELUGU') THEN
    RAISE EXCEPTION 'KSC_USE_TELUGU_RESOLUTION' USING HINT = 'Telugu items are resolved with ksc_resolve_telugu_review_item.';
  END IF;
  IF p_resolution NOT IN ('RESOLVED','ACCEPTED_AS_IS','DEFER') THEN RAISE EXCEPTION 'KSC_RESOLUTION_INVALID'; END IF;
  IF p_resolution = 'DEFER' THEN
    UPDATE public.draft_review_items SET status = 'DEFERRED', resolution_note = p_note, updated_at = NOW() WHERE id = r.id;
    RETURN jsonb_build_object('status', 'DEFERRED');
  END IF;
  IF p_resolution = 'ACCEPTED_AS_IS' AND coalesce(btrim(p_note), '') = '' THEN RAISE EXCEPTION 'KSC_NOTE_REQUIRED'; END IF;
  IF r.item_type = 'ANSWER_KEY' THEN
    IF p_resolution = 'ACCEPTED_AS_IS' THEN RAISE EXCEPTION 'KSC_ANSWER_ISSUE_MUST_BE_FIXED'; END IF;
    SELECT count(*) FILTER (WHERE is_proposed_correct), count(*) FILTER (WHERE is_proposed_correct AND coalesce(btrim(content), '') = '')
      INTO v_proposed, v_blank FROM public.draft_options WHERE draft_question_id = r.draft_question_id;
    IF v_proposed <> 1 OR v_blank > 0 THEN RAISE EXCEPTION 'KSC_ANSWER_ISSUE_STILL_PRESENT'; END IF;
  END IF;
  IF r.item_type = 'OPTION_EMPTY' THEN
    IF p_resolution = 'ACCEPTED_AS_IS' THEN RAISE EXCEPTION 'KSC_EMPTY_OPTION_MUST_BE_FIXED'; END IF;
    IF EXISTS (SELECT 1 FROM public.draft_options WHERE id = r.draft_option_id AND coalesce(btrim(content), '') = '') THEN
      RAISE EXCEPTION 'KSC_EMPTY_OPTION_STILL_PRESENT';
    END IF;
  END IF;
  UPDATE public.draft_review_items SET status = 'RESOLVED', resolution = p_resolution, resolution_note = p_note,
    resolved_by = v_uid, resolved_at = NOW(), updated_at = NOW() WHERE id = r.id;
  RETURN jsonb_build_object('status', 'RESOLVED', 'resolution', p_resolution);
END $$;

REVOKE ALL ON FUNCTION public.ksc_replace_review_items(UUID, UUID, TEXT, JSONB) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.ksc_resolve_telugu_review_item(UUID, TEXT, TEXT, TEXT) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.ksc_resolve_review_item(UUID, TEXT, TEXT) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.ksc_replace_review_items(UUID, UUID, TEXT, JSONB) TO authenticated;
GRANT EXECUTE ON FUNCTION public.ksc_resolve_telugu_review_item(UUID, TEXT, TEXT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.ksc_resolve_review_item(UUID, TEXT, TEXT) TO authenticated;

COMMIT;
