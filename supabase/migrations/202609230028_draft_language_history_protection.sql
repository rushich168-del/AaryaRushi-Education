-- KSC B4.5R — language-row history protection (NEW guarded forward migration; needs 0027)
--
-- 0022's policy lets a teacher DELETE their own Telugu language rows, and 0027 left that open:
-- deleting a row erased its OCR text, OCR attempt pointer, confidence, engine/model/hybrid version,
-- verdict, review reasons and teacher-verification record, and left the review item's target NULL.
-- This migration closes that without editing 0017-0027:
--   * a language row that carries extraction / OCR / verification history can no longer be
--     DELETEd directly; its OCR provenance columns and owner can no longer be rewritten directly;
--     and its source crop cannot be deleted out from under it (the FK's SET NULL is refused);
--   * the supported teacher operation for intentionally replacing or clearing such a value is
--     ksc_revise_language_text(REPLACE | CLEAR): the value changes, the OCR original, provenance,
--     crop and confidence stay, and the teacher verification is recorded. While an open Telugu
--     review item targets the row, the call is the review resolution itself (EDIT / MARK_MISSING),
--     so the item and the text never diverge;
--   * rows with no such history (a teacher's own row) keep 0022's behaviour, including DELETE;
--   * cascades are unchanged: deleting the owning question/option/paper removes its rows, and the
--     automatic Telugu writer still replaces its own EXTRACTED rows (it already refuses any Draft
--     with teacher work).
-- Nothing here confirms or proposes an answer, or creates, deletes or edits an option.
--
-- Migrations 0001-0027 are not edited. No Question Bank, snapshot, publish, attempt,
-- evaluation, storage-policy or bucket object is touched.
BEGIN;

DO $$ BEGIN
 IF to_regclass('public.organizations') IS NOT NULL OR to_regprocedure('ksc_private.provision_student()') IS NULL
 THEN RAISE EXCEPTION 'Expected isolated KSC baseline'; END IF;
 IF to_regprocedure('public.ksc_resolve_telugu_review_item(uuid,text,text,text)') IS NULL
    OR to_regclass('public.draft_review_items') IS NULL THEN
  RAISE EXCEPTION 'Missing B4.5 objects. Ensure 0027 is applied.';
 END IF;
END $$;

-- =========================================================================
-- 1. History guard on both language tables.
-- =========================================================================
-- A row "carries history" when anything in it came from extraction/OCR or records a teacher
-- verification. SCRIPT_NEUTRAL and TELUGU_OPTIONS_NOT_IN_SOURCE rows are automatic decisions
-- (source EXTRACTED) and are covered too.
CREATE OR REPLACE FUNCTION public.ksc_guard_language_history() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_history BOOLEAN;
  v_owner_exists BOOLEAN;
BEGIN
  -- The automatic writer replaces its own rows (and refuses any Draft with teacher work).
  IF coalesce(current_setting('ksc.auto_telugu_writer', true), '') = 'on' THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;
  v_history := OLD.source = 'EXTRACTED' OR OLD.ocr_original_content IS NOT NULL OR OLD.ocr_verdict IS NOT NULL
    OR OLD.ocr_engine IS NOT NULL OR OLD.ocr_version IS NOT NULL OR OLD.ocr_confidence IS NOT NULL
    OR OLD.verification_state IS NOT NULL OR coalesce(jsonb_array_length(OLD.ocr_review_reasons), 0) > 0;
  IF NOT v_history THEN RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END; END IF;

  -- A cascade from deleting the owning question / option / paper is not a language-row deletion.
  IF TG_TABLE_NAME = 'draft_question_texts' THEN
    SELECT EXISTS (SELECT 1 FROM public.draft_questions q WHERE q.id = OLD.draft_question_id) INTO v_owner_exists;
  ELSE
    SELECT EXISTS (SELECT 1 FROM public.draft_options o JOIN public.draft_questions q ON q.id = o.draft_question_id
                   WHERE o.id = OLD.draft_option_id) INTO v_owner_exists;
  END IF;
  IF NOT v_owner_exists THEN RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END; END IF;

  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'KSC_LANGUAGE_HISTORY_PROTECTED'
      USING HINT = 'This language value has OCR/extraction history. Clear or replace it with ksc_revise_language_text; the history is kept.';
  END IF;

  -- UPDATE: the value may change (0027 records it as EDITED_FROM_OCR / MARKED_MISSING), but the
  -- provenance of where it came from may not, and neither may its owner, language or source crop.
  IF NEW.ocr_engine IS DISTINCT FROM OLD.ocr_engine OR NEW.ocr_version IS DISTINCT FROM OLD.ocr_version
     OR NEW.ocr_confidence IS DISTINCT FROM OLD.ocr_confidence OR NEW.ocr_verdict IS DISTINCT FROM OLD.ocr_verdict
     OR NEW.ocr_review_reasons IS DISTINCT FROM OLD.ocr_review_reasons OR NEW.source_media_id IS DISTINCT FROM OLD.source_media_id
     OR NEW.language IS DISTINCT FROM OLD.language THEN
    RAISE EXCEPTION 'KSC_LANGUAGE_HISTORY_PROTECTED'
      USING HINT = 'OCR engine/model/version, confidence, verdict, review reasons, source crop and language of an extracted value are write-once.';
  END IF;
  IF TG_TABLE_NAME = 'draft_question_texts' THEN
    IF NEW.draft_question_id IS DISTINCT FROM OLD.draft_question_id THEN RAISE EXCEPTION 'KSC_LANGUAGE_HISTORY_PROTECTED'; END IF;
  ELSIF NEW.draft_option_id IS DISTINCT FROM OLD.draft_option_id THEN
    RAISE EXCEPTION 'KSC_LANGUAGE_HISTORY_PROTECTED';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.ksc_guard_language_history() FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS guard_language_history_question ON public.draft_question_texts;
CREATE TRIGGER guard_language_history_question BEFORE UPDATE OR DELETE ON public.draft_question_texts
FOR EACH ROW EXECUTE FUNCTION public.ksc_guard_language_history();
DROP TRIGGER IF EXISTS guard_language_history_option ON public.draft_option_texts;
CREATE TRIGGER guard_language_history_option BEFORE UPDATE OR DELETE ON public.draft_option_texts
FOR EACH ROW EXECUTE FUNCTION public.ksc_guard_language_history();

-- =========================================================================
-- 2. The supported teacher operation: replace or clear a language value, keeping its history.
--    p_owner: 'QUESTION' (draft_question_texts) | 'OPTION' (draft_option_texts)
--    p_action: 'REPLACE' (teacher text) | 'CLEAR' (no value; the row and its history stay)
-- =========================================================================
CREATE OR REPLACE FUNCTION public.ksc_revise_language_text(p_text_id UUID, p_owner TEXT, p_action TEXT, p_text TEXT DEFAULT NULL, p_note TEXT DEFAULT NULL)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_uid UUID := auth.uid();
  v_tbl TEXT; v_paper UUID; v_content TEXT; v_quality TEXT; v_media UUID; v_original TEXT; v_attempt TEXT;
  v_item public.draft_review_items; v_state TEXT; v_res JSONB;
BEGIN
  IF v_uid IS NULL OR NOT public.is_teacher() THEN RAISE EXCEPTION 'Teacher access required'; END IF;
  IF p_owner NOT IN ('QUESTION','OPTION') THEN RAISE EXCEPTION 'KSC_LANGUAGE_OWNER_INVALID'; END IF;
  IF p_action NOT IN ('REPLACE','CLEAR') THEN RAISE EXCEPTION 'KSC_LANGUAGE_ACTION_INVALID'; END IF;
  IF p_action = 'REPLACE' AND (coalesce(btrim(p_text), '') = '' OR p_text ~ '[\uE000-\uF8FF\uFFFD]') THEN
    RAISE EXCEPTION 'KSC_TELUGU_TEXT_INVALID' USING HINT = 'Type the text; legacy PDF glyphs cannot be stored.';
  END IF;
  v_tbl := CASE p_owner WHEN 'QUESTION' THEN 'draft_question_texts' ELSE 'draft_option_texts' END;

  IF p_owner = 'QUESTION' THEN
    SELECT q.draft_paper_id, t.content, t.text_quality, t.source_media_id, t.ocr_original_content
      INTO v_paper, v_content, v_quality, v_media, v_original
    FROM public.draft_question_texts t JOIN public.draft_questions q ON q.id = t.draft_question_id
    JOIN public.draft_papers p ON p.id = q.draft_paper_id
    WHERE t.id = p_text_id AND p.created_by = v_uid FOR UPDATE OF t;
  ELSE
    SELECT q.draft_paper_id, t.content, t.text_quality, t.source_media_id, t.ocr_original_content
      INTO v_paper, v_content, v_quality, v_media, v_original
    FROM public.draft_option_texts t JOIN public.draft_options o ON o.id = t.draft_option_id
    JOIN public.draft_questions q ON q.id = o.draft_question_id JOIN public.draft_papers p ON p.id = q.draft_paper_id
    WHERE t.id = p_text_id AND p.created_by = v_uid FOR UPDATE OF t;
  END IF;
  IF NOT FOUND THEN RAISE EXCEPTION 'Language text not found or unauthorized'; END IF;
  IF v_quality = 'SCRIPT_NEUTRAL' THEN
    RAISE EXCEPTION 'KSC_SCRIPT_NEUTRAL_NOT_REVISABLE' USING HINT = 'The option''s own digits/symbols are its text in every language.';
  END IF;

  -- An open Telugu review item for this row: the revision IS its resolution.
  SELECT i.* INTO v_item FROM public.draft_review_items i
  WHERE i.draft_paper_id = v_paper AND i.status IN ('OPEN','DEFERRED')
    AND i.item_type IN ('TELUGU_STEM','TELUGU_OPTION','TELUGU_VERIFY')
    AND (i.target_question_text_id = p_text_id OR i.target_option_text_id = p_text_id)
  ORDER BY i.item_key LIMIT 1;
  IF FOUND THEN
    v_res := public.ksc_resolve_telugu_review_item(v_item.id, CASE p_action WHEN 'REPLACE' THEN 'EDIT' ELSE 'MARK_MISSING' END, p_text, p_note);
    RETURN v_res || jsonb_build_object('review_item_id', v_item.id);
  END IF;

  -- No open item: revise in place. The unstored OCR attempt comes from the row's own automatic crop.
  SELECT m.detection_detail->>'ocrText' INTO v_attempt FROM public.draft_media m
  WHERE m.id = v_media AND m.capture_method = 'AUTO_REGION' AND m.draft_paper_id = v_paper;
  IF v_attempt IS NOT NULL AND v_attempt !~ '[\u0C00-\u0C7F]' THEN v_attempt := NULL; END IF;
  -- Only OCR text is ever kept as the OCR original — never an earlier teacher value.
  v_original := COALESCE(v_original, CASE WHEN v_quality = 'OCR_EXTRACTED' THEN v_content END, v_attempt);
  v_state := CASE WHEN p_action = 'CLEAR' THEN 'MARKED_MISSING' WHEN v_original IS NULL THEN 'TEACHER_TRANSCRIBED' ELSE 'EDITED_FROM_OCR' END;

  PERFORM set_config('ksc.review_resolution', 'on', true);   -- 0027 guard: verification columns may change
  IF p_action = 'REPLACE' THEN
    EXECUTE format('UPDATE public.%I SET ocr_original_content = $3, content = $4, text_quality = ''TEACHER_ENTERED'', source = ''TEACHER'',
      verification_state = $5, verified_by = $2, verified_at = NOW(), updated_at = NOW() WHERE id = $1', v_tbl)
      USING p_text_id, v_uid, v_original, p_text, v_state;
  ELSE
    EXECUTE format('UPDATE public.%I SET ocr_original_content = $3, content = NULL, text_quality = ''MISSING'',
      verification_state = $4, verified_by = $2, verified_at = NOW(), updated_at = NOW() WHERE id = $1', v_tbl)
      USING p_text_id, v_uid, v_original, v_state;
  END IF;
  PERFORM set_config('ksc.review_resolution', 'off', true);

  -- A resolved item for this row keeps its original decision and gains a revision record.
  UPDATE public.draft_review_items i
  SET detail = jsonb_set(i.detail, '{revisions}', coalesce(i.detail->'revisions', '[]'::jsonb) || jsonb_build_array(jsonb_build_object(
        'action', p_action, 'value', CASE WHEN p_action = 'REPLACE' THEN p_text END, 'note', p_note, 'by', v_uid, 'at', NOW()))),
      updated_at = NOW()
  WHERE i.draft_paper_id = v_paper AND i.status = 'RESOLVED'
    AND (i.target_question_text_id = p_text_id OR i.target_option_text_id = p_text_id);

  RETURN jsonb_build_object('status', 'REVISED', 'action', p_action, 'verification_state', v_state);
END $$;

REVOKE ALL ON FUNCTION public.ksc_revise_language_text(UUID, TEXT, TEXT, TEXT, TEXT) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.ksc_revise_language_text(UUID, TEXT, TEXT, TEXT, TEXT) TO authenticated;

COMMIT;
