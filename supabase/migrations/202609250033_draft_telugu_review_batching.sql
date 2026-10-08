-- KSC B4.8.4C — Telugu teacher-work compression (NEW guarded forward migration; needs 0032)
--
-- Lets the OWNING teacher make fewer, larger Telugu decisions without weakening any safety rule:
--
--   ksc_verify_question_telugu(question, items[{item_id, expected}], note)
--       ONE atomic "Looks correct" for a question's confidence/agreement-only Telugu checks. Every listed item
--       must be eligible and show exactly the text the teacher saw, or NOTHING is resolved. Never changes Telugu
--       text, options or answers.
--   ksc_apply_telugu_source_decision(paper, fingerprint, mode, text, occurrences[{item_id, expected}], note)
--       One decision for every occurrence of the SAME printed unit (frozen source fingerprint "tg1:…", never an
--       OCR string). VERIFY_SOURCE_AS_CORRECT or CORRECT_SOURCE_TEXT. Each occurrence is checked on its own:
--       stale or already-decided occurrences are never overwritten and are reported; the others apply (the
--       0032 per-placement philosophy). Corrections go through the 0028 history path.
--   ksc_replace_auto_material_telugu(paper, run, texts)  +  ksc_resolve_shared_passage(item, action, expected, text, note)
--       Shared-passage OCR stored as a PROPOSAL with its provenance (never teacher verification); the teacher
--       accepts or edits it once for every linked question. OCR text and provenance are write-once.
--   draft_telugu_decisions / draft_telugu_decision_items
--       APPEND-ONLY evidence of every Telugu teacher decision (also the single-item 0027/0028 paths, captured
--       server-side by a trigger), classified from server-stored values only. No accuracy is derived here.
--   Source evidence freeze: an AUTO_REGION crop's detection_detail (sourceFp, printedDigits, OCR provenance)
--       can no longer be changed by a client role.
--   ksc_draft_has_teacher_work: automatic passage OCR is not teacher work; every 0033 decision is.
--
-- Migrations 0001-0032 are not edited. No Question Bank, snapshot, publish, attempt, evaluation, storage-policy
-- or bucket object is touched. Students and anonymous users get no access.
BEGIN;

DO $$ BEGIN
 IF to_regclass('public.organizations') IS NOT NULL OR to_regprocedure('ksc_private.provision_student()') IS NULL
 THEN RAISE EXCEPTION 'Expected isolated KSC baseline'; END IF;
 IF to_regprocedure('public.ksc_resolve_math_image(uuid,text,text,text,jsonb,text)') IS NULL THEN
  RAISE EXCEPTION 'Missing B4.8.3C objects. Ensure 0032 is applied.';
 END IF;
END $$;

-- =========================================================================
-- 1. Source evidence freeze (automatic crops' evidence is read-only for clients).
-- =========================================================================
CREATE OR REPLACE FUNCTION public.ksc_guard_auto_region_evidence() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF OLD.capture_method = 'AUTO_REGION' AND NEW.detection_detail IS DISTINCT FROM OLD.detection_detail
     AND current_user IN ('authenticated', 'anon') THEN
    RAISE EXCEPTION 'KSC_SOURCE_EVIDENCE_READ_ONLY' USING HINT = 'Automatic crop evidence is written only by automatic preparation.';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.ksc_guard_auto_region_evidence() FROM PUBLIC, anon, authenticated, service_role;
DROP TRIGGER IF EXISTS guard_auto_region_evidence ON public.draft_media;
CREATE TRIGGER guard_auto_region_evidence BEFORE UPDATE OF detection_detail ON public.draft_media
FOR EACH ROW EXECUTE FUNCTION public.ksc_guard_auto_region_evidence();

-- =========================================================================
-- 2. Shared-passage OCR provenance on draft_material_texts (0027).
-- =========================================================================
ALTER TABLE public.draft_material_texts
  ADD COLUMN IF NOT EXISTS ocr_original_content TEXT,
  ADD COLUMN IF NOT EXISTS ocr_engine TEXT,
  ADD COLUMN IF NOT EXISTS ocr_version TEXT,
  ADD COLUMN IF NOT EXISTS ocr_confidence NUMERIC,
  ADD COLUMN IF NOT EXISTS ocr_verdict TEXT,
  ADD COLUMN IF NOT EXISTS ocr_detail JSONB;
DO $$
DECLARE c RECORD;
BEGIN
  -- 0027's inline CHECKs on text_quality / source / verification_state are replaced by wider named ones.
  FOR c IN SELECT conname FROM pg_constraint WHERE conrelid = 'public.draft_material_texts'::regclass AND contype = 'c'
             AND conname IN ('draft_material_texts_text_quality_check', 'draft_material_texts_source_check', 'draft_material_texts_verification_state_check') LOOP
    EXECUTE format('ALTER TABLE public.draft_material_texts DROP CONSTRAINT %I', c.conname);
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.draft_material_texts'::regclass AND contype = 'c'
             AND pg_get_constraintdef(oid) ~ '(text_quality|source|verification_state) = ANY' AND conname NOT LIKE 'draft_material_texts_v2_%') THEN
    RAISE EXCEPTION 'Unexpected CHECK constraint on draft_material_texts; refusing to widen.';
  END IF;
END $$;
ALTER TABLE public.draft_material_texts DROP CONSTRAINT IF EXISTS draft_material_texts_v2_quality;
ALTER TABLE public.draft_material_texts ADD CONSTRAINT draft_material_texts_v2_quality CHECK (text_quality IN ('TEACHER_ENTERED', 'MISSING', 'OCR_EXTRACTED'));
ALTER TABLE public.draft_material_texts DROP CONSTRAINT IF EXISTS draft_material_texts_v2_source;
ALTER TABLE public.draft_material_texts ADD CONSTRAINT draft_material_texts_v2_source CHECK (source IN ('TEACHER', 'AUTO_OCR'));
ALTER TABLE public.draft_material_texts DROP CONSTRAINT IF EXISTS draft_material_texts_v2_verification;
ALTER TABLE public.draft_material_texts ADD CONSTRAINT draft_material_texts_v2_verification CHECK (verification_state IS NULL OR verification_state IN
  ('TEACHER_TRANSCRIBED', 'MARKED_MISSING', 'VERIFIED_OCR', 'EDITED_FROM_OCR'));
ALTER TABLE public.draft_material_texts DROP CONSTRAINT IF EXISTS draft_material_texts_v2_ocr_provenance;
ALTER TABLE public.draft_material_texts ADD CONSTRAINT draft_material_texts_v2_ocr_provenance CHECK (
  source <> 'AUTO_OCR' OR (ocr_original_content IS NOT NULL AND coalesce(ocr_engine, '') <> '' AND coalesce(ocr_version, '') <> ''));
ALTER TABLE public.draft_material_texts DROP CONSTRAINT IF EXISTS draft_material_texts_v2_ocr_text;
ALTER TABLE public.draft_material_texts ADD CONSTRAINT draft_material_texts_v2_ocr_text CHECK (
  (text_quality <> 'OCR_EXTRACTED' OR content = ocr_original_content)
  AND (ocr_original_content IS NULL OR ocr_original_content !~ '[-�]'));
ALTER TABLE public.draft_material_texts DROP CONSTRAINT IF EXISTS draft_material_texts_v2_verified_by;
ALTER TABLE public.draft_material_texts ADD CONSTRAINT draft_material_texts_v2_verified_by CHECK (
  verification_state IS NULL OR (verified_by IS NOT NULL AND verified_at IS NOT NULL)) NOT VALID;   -- 0027 rows already satisfy it

-- OCR proposals are inserted only by the automatic writer; OCR text and provenance are write-once; an OCR row
-- is deleted only by the writer (before any teacher decision) or with its material. A teacher's text over an
-- OCR proposal is recorded as EDITED_FROM_OCR, never as typed from scratch.
CREATE OR REPLACE FUNCTION public.ksc_guard_material_text_ocr() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE v_writer BOOLEAN := coalesce(current_setting('ksc.auto_material_telugu_writer', true), '') = 'on';
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF (NEW.source = 'AUTO_OCR' OR NEW.text_quality = 'OCR_EXTRACTED' OR NEW.ocr_original_content IS NOT NULL) AND NOT v_writer THEN
      RAISE EXCEPTION 'KSC_MATERIAL_OCR_WRITER_ONLY';
    END IF;
    IF NEW.source = 'AUTO_OCR' AND NEW.verification_state IS NOT NULL THEN RAISE EXCEPTION 'KSC_OCR_IS_A_PROPOSAL'; END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    IF OLD.source = 'AUTO_OCR' AND EXISTS (SELECT 1 FROM public.draft_materials WHERE id = OLD.draft_material_id)
       AND NOT (v_writer AND OLD.verification_state IS NULL) THEN
      RAISE EXCEPTION 'KSC_OCR_HISTORY_PROTECTED';
    END IF;
    RETURN OLD;
  END IF;
  IF NEW.source IS DISTINCT FROM OLD.source OR NEW.ocr_original_content IS DISTINCT FROM OLD.ocr_original_content
     OR NEW.ocr_engine IS DISTINCT FROM OLD.ocr_engine OR NEW.ocr_version IS DISTINCT FROM OLD.ocr_version
     OR NEW.ocr_confidence IS DISTINCT FROM OLD.ocr_confidence OR NEW.ocr_verdict IS DISTINCT FROM OLD.ocr_verdict
     OR NEW.ocr_detail IS DISTINCT FROM OLD.ocr_detail
     OR (OLD.source = 'AUTO_OCR' AND NEW.source_media_id IS NOT NULL AND NEW.source_media_id IS DISTINCT FROM OLD.source_media_id) THEN   -- SET NULL by the FK is allowed
    RAISE EXCEPTION 'KSC_OCR_HISTORY_PROTECTED' USING HINT = 'Passage OCR text and provenance are kept as they were read.';
  END IF;
  IF OLD.ocr_original_content IS NOT NULL AND NEW.verification_state = 'TEACHER_TRANSCRIBED' THEN
    NEW.verification_state := 'EDITED_FROM_OCR';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.ksc_guard_material_text_ocr() FROM PUBLIC, anon, authenticated, service_role;
DROP TRIGGER IF EXISTS guard_material_text_ocr ON public.draft_material_texts;
CREATE TRIGGER guard_material_text_ocr BEFORE INSERT OR UPDATE OR DELETE ON public.draft_material_texts
FOR EACH ROW EXECUTE FUNCTION public.ksc_guard_material_text_ocr();

-- =========================================================================
-- 3. Append-only decision evidence.
-- =========================================================================
CREATE TABLE IF NOT EXISTS public.draft_telugu_decisions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    draft_paper_id UUID NOT NULL REFERENCES public.draft_papers(id) ON DELETE CASCADE,
    decision_kind TEXT NOT NULL CHECK (decision_kind IN ('QUESTION_VERIFY', 'VERIFY_SOURCE_AS_CORRECT', 'CORRECT_SOURCE_TEXT',
      'PASSAGE_ACCEPT', 'PASSAGE_EDIT', 'UNIT_DECISION', 'REVISION')),
    draft_question_id UUID,                       -- no FKs: the evidence outlives a later row removal
    draft_material_id UUID,
    source_fingerprint TEXT CHECK (source_fingerprint IS NULL OR source_fingerprint ~ '^tg1:[0-9a-f]{24}$'),
    old_text TEXT,
    new_text TEXT,
    item_ids UUID[] NOT NULL DEFAULT '{}',        -- every review item this decision named
    note TEXT CHECK (note IS NULL OR length(note) <= 500),
    actor UUID NOT NULL,
    decided_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_telugu_decisions_paper ON public.draft_telugu_decisions(draft_paper_id, decided_at);

CREATE TABLE IF NOT EXISTS public.draft_telugu_decision_items (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    decision_id UUID NOT NULL REFERENCES public.draft_telugu_decisions(id) ON DELETE CASCADE,
    draft_paper_id UUID NOT NULL REFERENCES public.draft_papers(id) ON DELETE CASCADE,
    review_item_id UUID NOT NULL,
    item_type TEXT NOT NULL,
    draft_question_id UUID,
    text_row_id UUID,                             -- the question / option / material text row
    owner TEXT CHECK (owner IN ('QUESTION', 'OPTION', 'MATERIAL')),
    outcome TEXT NOT NULL CHECK (outcome IN ('RESOLVED', 'REVISED', 'CONFLICT', 'REFUSED', 'ALREADY_APPLIED')),
    reason TEXT,
    evidence_class TEXT NOT NULL CHECK (evidence_class IN ('QUESTION_ACCEPTED_UNCHANGED', 'OCR_ACCEPTED_UNCHANGED', 'OCR_KEPT_OVER_SUGGESTION',
      'SUGGESTION_ACCEPTED', 'PRINTED_DIGITS_USED', 'PRINTED_DIGITS_ASSISTED_EDIT', 'TEACHER_EDITED', 'TEACHER_TRANSCRIBED', 'MARKED_MISSING',
      'MARKED_FIXED', 'REPEATED_SOURCE_VERIFIED', 'REPEATED_SOURCE_CORRECTED', 'PASSAGE_ACCEPTED', 'PASSAGE_EDITED', 'PASSAGE_TRANSCRIBED',
      'REVISED', 'NONE')),
    resolution TEXT,
    text_before TEXT,                             -- what the teacher was shown (the preparation-time text)
    text_after TEXT,                              -- the stored text right after the decision
    ocr_verdict TEXT,
    machine_reasons JSONB,
    suggestion TEXT,                              -- the decoder suggestion recorded at preparation, if any
    printed_digits JSONB,                         -- the printed-digit evidence recorded at preparation, if any
    source_fingerprint TEXT,
    actor UUID NOT NULL,
    logged_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_telugu_decision_items_decision ON public.draft_telugu_decision_items(decision_id);
CREATE INDEX IF NOT EXISTS idx_telugu_decision_items_item ON public.draft_telugu_decision_items(draft_paper_id, review_item_id, id);

CREATE OR REPLACE FUNCTION public.ksc_guard_telugu_decision_log() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' AND NOT EXISTS (SELECT 1 FROM public.draft_papers WHERE id = OLD.draft_paper_id) THEN RETURN OLD; END IF;
  RAISE EXCEPTION 'KSC_TELUGU_DECISION_LOG_APPEND_ONLY';
END $$;
REVOKE ALL ON FUNCTION public.ksc_guard_telugu_decision_log() FROM PUBLIC, anon, authenticated, service_role;
DROP TRIGGER IF EXISTS guard_telugu_decisions ON public.draft_telugu_decisions;
CREATE TRIGGER guard_telugu_decisions BEFORE UPDATE OR DELETE ON public.draft_telugu_decisions
FOR EACH ROW EXECUTE FUNCTION public.ksc_guard_telugu_decision_log();
DROP TRIGGER IF EXISTS guard_telugu_decision_items ON public.draft_telugu_decision_items;
CREATE TRIGGER guard_telugu_decision_items BEFORE UPDATE OR DELETE ON public.draft_telugu_decision_items
FOR EACH ROW EXECUTE FUNCTION public.ksc_guard_telugu_decision_log();

ALTER TABLE public.draft_telugu_decisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.draft_telugu_decision_items ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Teachers read own Telugu decisions" ON public.draft_telugu_decisions;
CREATE POLICY "Teachers read own Telugu decisions" ON public.draft_telugu_decisions FOR SELECT TO authenticated
USING (public.is_teacher() AND EXISTS (SELECT 1 FROM public.draft_papers p WHERE p.id = draft_telugu_decisions.draft_paper_id AND p.created_by = auth.uid()));
DROP POLICY IF EXISTS "Teachers read own Telugu decision items" ON public.draft_telugu_decision_items;
CREATE POLICY "Teachers read own Telugu decision items" ON public.draft_telugu_decision_items FOR SELECT TO authenticated
USING (public.is_teacher() AND EXISTS (SELECT 1 FROM public.draft_papers p WHERE p.id = draft_telugu_decision_items.draft_paper_id AND p.created_by = auth.uid()));
REVOKE ALL ON public.draft_telugu_decisions FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON public.draft_telugu_decision_items FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.draft_telugu_decisions TO authenticated;          -- writes only through the functions below
GRANT SELECT ON public.draft_telugu_decision_items TO authenticated;

-- =========================================================================
-- 4. Shared helpers (not callable by clients).
-- =========================================================================
-- The Telugu a unit shows the teacher: its stored text, else the Telugu OCR attempt kept beside its own crop.
CREATE OR REPLACE FUNCTION public.ksc_telugu_unit_view(p_owner TEXT, p_row_id UUID, p_paper UUID) RETURNS TEXT
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE v_content TEXT; v_quality TEXT; v_media UUID; v_attempt TEXT;
BEGIN
  IF p_owner = 'QUESTION' THEN SELECT content, text_quality, source_media_id INTO v_content, v_quality, v_media FROM public.draft_question_texts WHERE id = p_row_id;
  ELSIF p_owner = 'OPTION' THEN SELECT content, text_quality, source_media_id INTO v_content, v_quality, v_media FROM public.draft_option_texts WHERE id = p_row_id;
  ELSE RETURN NULL; END IF;
  IF v_quality IN ('OCR_EXTRACTED', 'TEACHER_ENTERED') AND v_content IS NOT NULL THEN RETURN v_content; END IF;
  SELECT m.detection_detail->>'ocrText' INTO v_attempt FROM public.draft_media m
  WHERE m.id = v_media AND m.capture_method = 'AUTO_REGION' AND m.draft_paper_id = p_paper;
  RETURN CASE WHEN v_attempt ~ '[ఀ-౿]' THEN v_attempt ELSE '' END;
END $$;
REVOKE ALL ON FUNCTION public.ksc_telugu_unit_view(TEXT, UUID, UUID) FROM PUBLIC, anon, authenticated, service_role;

-- Answer state of some questions: flags, markers, positions, labels and question confirmation.
CREATE OR REPLACE FUNCTION public.ksc_answer_state(p_questions UUID[]) RETURNS TEXT
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT coalesce((SELECT string_agg(concat_ws('|', o.id, o.is_proposed_correct, o.is_confirmed_correct, o.marker, o.position, o.label, o.content), ',' ORDER BY o.id)
                   FROM public.draft_options o WHERE o.draft_question_id = ANY (p_questions)), '')
    || '#' || coalesce((SELECT string_agg(concat_ws('|', q.id, q.confirmed_by, q.confirmed_at), ',' ORDER BY q.id) FROM public.draft_questions q WHERE q.id = ANY (p_questions)), '');
$$;
REVOKE ALL ON FUNCTION public.ksc_answer_state(UUID[]) FROM PUBLIC, anon, authenticated, service_role;

-- Confidence/agreement-only machine reasons (the ONLY ones a question-level "Looks correct" may verify).
CREATE OR REPLACE FUNCTION public.ksc_telugu_reasons_confidence_only(p_reasons JSONB) RETURNS BOOLEAN
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT jsonb_typeof(p_reasons) = 'array' AND jsonb_array_length(p_reasons) > 0 AND NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements_text(p_reasons) r
    WHERE r NOT IN ('MEDIUM', 'LOW', 'OCR_DECODER_AGREE', 'OCR_CONFIDENCE_MEDIUM', 'OCR_CONFIDENCE_LOW', 'OCR_HIGH_CONFIDENCE_UNVERIFIED'));
$$;
REVOKE ALL ON FUNCTION public.ksc_telugu_reasons_confidence_only(JSONB) FROM PUBLIC, anon, authenticated, service_role;

-- What a resolved Telugu item's decision was, from server-stored values only (never an accuracy claim).
CREATE OR REPLACE FUNCTION public.ksc_telugu_evidence_class(p_item public.draft_review_items, p_kind TEXT) RETURNS TEXT
LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v TEXT := p_item.resolution_value;
  v_sug TEXT := CASE WHEN (p_item.detail->'decoder'->>'agree') = 'false' THEN p_item.detail->'decoder'->>'suggestion' END;
  v_pd JSONB := CASE WHEN p_item.detail->'printedDigits'->>'status' = 'REPAIRABLE' THEN p_item.detail->'printedDigits' END;
  v_digits JSONB;
BEGIN
  IF p_kind = 'QUESTION_VERIFY' THEN RETURN 'QUESTION_ACCEPTED_UNCHANGED'; END IF;
  IF p_kind IN ('VERIFY_SOURCE_AS_CORRECT', 'CORRECT_SOURCE_TEXT') THEN
    RETURN CASE WHEN p_item.resolution = 'ACCEPTED_OCR' THEN 'REPEATED_SOURCE_VERIFIED' ELSE 'REPEATED_SOURCE_CORRECTED' END;
  END IF;
  IF p_item.item_type = 'MATERIAL_TELUGU' THEN
    RETURN CASE p_item.resolution WHEN 'ACCEPTED_OCR' THEN 'PASSAGE_ACCEPTED' WHEN 'EDITED_OCR' THEN 'PASSAGE_EDITED'
      WHEN 'TRANSCRIBED' THEN 'PASSAGE_TRANSCRIBED' WHEN 'MARKED_MISSING' THEN 'MARKED_MISSING' ELSE 'NONE' END;
  END IF;
  IF p_item.resolution = 'ACCEPTED_OCR' THEN RETURN CASE WHEN v_sug IS NOT NULL THEN 'OCR_KEPT_OVER_SUGGESTION' ELSE 'OCR_ACCEPTED_UNCHANGED' END; END IF;
  IF p_item.resolution = 'MARKED_MISSING' THEN RETURN 'MARKED_MISSING'; END IF;
  IF p_item.resolution IN ('RESOLVED', 'ACCEPTED_AS_IS') THEN RETURN 'MARKED_FIXED'; END IF;
  IF p_item.resolution IN ('EDITED_OCR', 'TRANSCRIBED') THEN
    IF v IS NOT NULL AND v_sug IS NOT NULL AND btrim(v) = btrim(v_sug) THEN RETURN 'SUGGESTION_ACCEPTED'; END IF;
    IF v IS NOT NULL AND v_pd IS NOT NULL AND btrim(v) = btrim(v_pd->>'text') THEN RETURN 'PRINTED_DIGITS_USED'; END IF;
    IF v IS NOT NULL AND v_pd IS NOT NULL THEN
      SELECT coalesce(jsonb_agg(m[1]), '[]'::jsonb) INTO v_digits FROM regexp_matches(v, '(\d+)', 'g') m;
      IF v_digits = v_pd->'after' THEN RETURN 'PRINTED_DIGITS_ASSISTED_EDIT'; END IF;   -- the PDF's digits, letters edited
    END IF;
    RETURN CASE WHEN p_item.resolution = 'TRANSCRIBED' THEN 'TEACHER_TRANSCRIBED' ELSE 'TEACHER_EDITED' END;
  END IF;
  RETURN 'NONE';
END $$;
REVOKE ALL ON FUNCTION public.ksc_telugu_evidence_class(public.draft_review_items, TEXT) FROM PUBLIC, anon, authenticated, service_role;

-- Evidence capture: every Telugu item a teacher resolves (any path) and every later revision is logged.
-- Inside a 0033 decision the rows join that decision; otherwise each gets its own UNIT_DECISION / REVISION.
CREATE OR REPLACE FUNCTION public.ksc_log_telugu_item_decision() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_decision UUID := NULLIF(current_setting('ksc.telugu_decision_id', true), '')::UUID;
  v_kind TEXT := coalesce(NULLIF(current_setting('ksc.telugu_decision_kind', true), ''), 'UNIT_DECISION');
  v_revision BOOLEAN := OLD.status = 'RESOLVED' AND NEW.status = 'RESOLVED';
  v_owner TEXT; v_row UUID; v_after TEXT; v_q UUID; v_fp TEXT; v_actor UUID;
BEGIN
  IF v_revision THEN v_kind := 'REVISION'; v_decision := NULL; END IF;
  v_actor := coalesce(auth.uid(), NEW.resolved_by);
  IF NEW.target_question_text_id IS NOT NULL THEN
    v_owner := 'QUESTION'; v_row := NEW.target_question_text_id;
    SELECT content INTO v_after FROM public.draft_question_texts WHERE id = v_row;
  ELSIF NEW.target_option_text_id IS NOT NULL THEN
    v_owner := 'OPTION'; v_row := NEW.target_option_text_id;
    SELECT content INTO v_after FROM public.draft_option_texts WHERE id = v_row;
  ELSIF NEW.draft_material_id IS NOT NULL THEN
    v_owner := 'MATERIAL';
    SELECT id, content INTO v_row, v_after FROM public.draft_material_texts WHERE draft_material_id = NEW.draft_material_id AND language = 'te';
  END IF;
  v_q := coalesce(NEW.draft_question_id, (SELECT draft_question_id FROM public.draft_options WHERE id = NEW.draft_option_id));
  SELECT m.detection_detail->>'sourceFp' INTO v_fp FROM public.draft_media m WHERE m.id = NEW.source_media_id AND m.capture_method = 'AUTO_REGION';
  IF v_decision IS NULL THEN
    INSERT INTO public.draft_telugu_decisions (draft_paper_id, decision_kind, draft_question_id, draft_material_id, old_text, new_text, item_ids, note, actor)
    VALUES (NEW.draft_paper_id, v_kind, v_q, NEW.draft_material_id, NEW.extracted_value, v_after, ARRAY[NEW.id],
      left(CASE WHEN v_revision THEN NEW.detail->'revisions'->-1->>'note' ELSE NEW.resolution_note END, 500), v_actor)
    RETURNING id INTO v_decision;
  END IF;
  INSERT INTO public.draft_telugu_decision_items (decision_id, draft_paper_id, review_item_id, item_type, draft_question_id, text_row_id, owner,
      outcome, evidence_class, resolution, text_before, text_after, ocr_verdict, machine_reasons, suggestion, printed_digits, source_fingerprint, actor)
  VALUES (v_decision, NEW.draft_paper_id, NEW.id, NEW.item_type, v_q, v_row, v_owner,
      CASE WHEN v_revision THEN 'REVISED' ELSE 'RESOLVED' END,
      CASE WHEN v_revision THEN 'REVISED' ELSE public.ksc_telugu_evidence_class(NEW, v_kind) END,
      NEW.resolution, NEW.extracted_value, v_after, NEW.detail->>'verdict', NEW.machine_reasons,
      CASE WHEN (NEW.detail->'decoder'->>'agree') = 'false' THEN NEW.detail->'decoder'->>'suggestion' END,
      NEW.detail->'printedDigits', v_fp, v_actor);
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION public.ksc_log_telugu_item_decision() FROM PUBLIC, anon, authenticated, service_role;
DROP TRIGGER IF EXISTS log_telugu_item_decision ON public.draft_review_items;
CREATE TRIGGER log_telugu_item_decision AFTER UPDATE ON public.draft_review_items
FOR EACH ROW WHEN (NEW.item_type IN ('TELUGU_STEM', 'TELUGU_OPTION', 'TELUGU_VERIFY', 'TELUGU_STRUCTURE_AMBIGUOUS', 'MATERIAL_TELUGU')
  AND NEW.status = 'RESOLVED' AND NEW.resolution IS DISTINCT FROM 'RECONCILED'
  AND (OLD.status IS DISTINCT FROM 'RESOLVED'
       OR coalesce(jsonb_array_length(NEW.detail->'revisions'), 0) > coalesce(jsonb_array_length(OLD.detail->'revisions'), 0)))
EXECUTE FUNCTION public.ksc_log_telugu_item_decision();

-- Opens a decision inside the current transaction; item resolutions made after it join it.
CREATE OR REPLACE FUNCTION public.ksc_open_telugu_decision(p_paper UUID, p_kind TEXT, p_question UUID, p_material UUID, p_fp TEXT,
    p_old TEXT, p_new TEXT, p_items UUID[], p_note TEXT) RETURNS UUID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE v_id UUID;
BEGIN
  INSERT INTO public.draft_telugu_decisions (draft_paper_id, decision_kind, draft_question_id, draft_material_id, source_fingerprint, old_text, new_text, item_ids, note, actor)
  VALUES (p_paper, p_kind, p_question, p_material, p_fp, p_old, p_new, coalesce(p_items, '{}'), left(p_note, 500), auth.uid())
  RETURNING id INTO v_id;
  PERFORM set_config('ksc.telugu_decision_id', v_id::TEXT, true);
  PERFORM set_config('ksc.telugu_decision_kind', p_kind, true);
  RETURN v_id;
END $$;
REVOKE ALL ON FUNCTION public.ksc_open_telugu_decision(UUID, TEXT, UUID, UUID, TEXT, TEXT, TEXT, UUID[], TEXT) FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.ksc_close_telugu_decision() RETURNS VOID
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  PERFORM set_config('ksc.telugu_decision_id', '', true);
  PERFORM set_config('ksc.telugu_decision_kind', '', true);
END $$;
REVOKE ALL ON FUNCTION public.ksc_close_telugu_decision() FROM PUBLIC, anon, authenticated, service_role;

-- =========================================================================
-- 5. Question-level "Looks correct" — atomic, confidence/agreement-only, stale-checked, idempotent.
--    p_items: [{ "item_id": uuid, "expected": "<the Telugu the teacher saw>" }]
-- =========================================================================
CREATE OR REPLACE FUNCTION public.ksc_verify_question_telugu(p_question_id UUID, p_items JSONB, p_note TEXT DEFAULT NULL)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_uid UUID := auth.uid(); v_paper UUID; v_req JSONB; v_item public.draft_review_items; v_owner TEXT; v_row UUID; v_view TEXT; v_state TEXT;
  v_q UUID; v_todo UUID[] := '{}'; v_already UUID[] := '{}'; v_expected JSONB := '{}'::jsonb; v_answers TEXT; v_decision UUID; v_id UUID;
BEGIN
  IF v_uid IS NULL OR NOT public.is_teacher() THEN RAISE EXCEPTION 'Teacher access required'; END IF;
  SELECT q.draft_paper_id INTO v_paper FROM public.draft_questions q JOIN public.draft_papers p ON p.id = q.draft_paper_id
  WHERE q.id = p_question_id AND p.created_by = v_uid;
  IF NOT FOUND THEN RAISE EXCEPTION 'Question not found or unauthorized'; END IF;
  PERFORM 1 FROM public.draft_papers WHERE id = v_paper FOR UPDATE;
  IF NOT EXISTS (SELECT 1 FROM public.draft_analysis_runs WHERE draft_paper_id = v_paper AND preparation_state = 'PREPARED') THEN
    RAISE EXCEPTION 'KSC_PAPER_NOT_PREPARED';
  END IF;
  IF jsonb_typeof(p_items) IS DISTINCT FROM 'array' OR jsonb_array_length(p_items) = 0 OR jsonb_array_length(p_items) > 12 THEN
    RAISE EXCEPTION 'KSC_ITEMS_REQUIRED';
  END IF;
  IF (SELECT count(DISTINCT e->>'item_id') FROM jsonb_array_elements(p_items) e) <> jsonb_array_length(p_items) THEN RAISE EXCEPTION 'KSC_ITEMS_DUPLICATED'; END IF;

  -- Validate EVERY item before changing anything (any refusal = nothing resolved).
  FOR v_req IN SELECT e FROM jsonb_array_elements(p_items) e ORDER BY e->>'item_id' LOOP
    SELECT * INTO v_item FROM public.draft_review_items WHERE id = NULLIF(v_req->>'item_id', '')::UUID AND draft_paper_id = v_paper FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'KSC_ITEM_NOT_OF_QUESTION' USING DETAIL = coalesce(v_req->>'item_id', '?'); END IF;
    v_q := coalesce(v_item.draft_question_id, (SELECT draft_question_id FROM public.draft_options WHERE id = v_item.draft_option_id));
    IF v_q IS DISTINCT FROM p_question_id THEN RAISE EXCEPTION 'KSC_ITEM_NOT_OF_QUESTION' USING DETAIL = v_item.id::TEXT; END IF;
    IF v_item.item_type NOT IN ('TELUGU_STEM', 'TELUGU_OPTION', 'TELUGU_VERIFY') OR NOT public.ksc_telugu_reasons_confidence_only(v_item.machine_reasons)
       OR coalesce(v_item.detail->'decoder'->>'agree', '') = 'false' THEN
      RAISE EXCEPTION 'KSC_ITEM_NOT_ELIGIBLE' USING DETAIL = v_item.id::TEXT || ' ' || v_item.machine_reasons::TEXT,
        HINT = 'Only confidence/agreement checks can be verified together; decide the others one by one.';
    END IF;
    IF v_item.target_question_text_id IS NOT NULL THEN v_owner := 'QUESTION'; v_row := v_item.target_question_text_id;
      SELECT verification_state INTO v_state FROM public.draft_question_texts WHERE id = v_row FOR UPDATE;
    ELSE v_owner := 'OPTION'; v_row := v_item.target_option_text_id;
      SELECT verification_state INTO v_state FROM public.draft_option_texts WHERE id = v_row FOR UPDATE; END IF;
    IF v_row IS NULL THEN RAISE EXCEPTION 'KSC_REVIEW_ITEM_TARGET_MISSING' USING DETAIL = v_item.id::TEXT; END IF;
    v_view := public.ksc_telugu_unit_view(v_owner, v_row, v_paper);
    IF v_item.status = 'RESOLVED' THEN
      -- A repeated click: already verified with exactly this text by this path is not an error.
      IF v_item.resolution = 'ACCEPTED_OCR' AND v_state = 'VERIFIED_OCR' AND v_view = v_req->>'expected' THEN v_already := v_already || v_item.id; CONTINUE; END IF;
      RAISE EXCEPTION 'KSC_STALE_STATE' USING DETAIL = v_item.id::TEXT, HINT = 'This check was decided differently since the page was loaded.';
    END IF;
    IF v_state IS NOT NULL THEN RAISE EXCEPTION 'KSC_STALE_STATE' USING DETAIL = v_item.id::TEXT; END IF;
    IF coalesce(v_view, '') = '' OR v_view IS DISTINCT FROM v_req->>'expected' THEN
      RAISE EXCEPTION 'KSC_STALE_VIEW' USING DETAIL = v_item.id::TEXT, HINT = 'The Telugu changed since the page was loaded; reload and look again.';
    END IF;
    v_todo := v_todo || v_item.id;
    v_expected := v_expected || jsonb_build_object(v_item.id::TEXT, v_view);
  END LOOP;
  IF cardinality(v_todo) = 0 THEN
    RETURN jsonb_build_object('status', 'ALREADY_APPLIED', 'resolved', 0, 'already', cardinality(v_already));
  END IF;

  v_answers := public.ksc_answer_state(ARRAY[p_question_id]);
  v_decision := public.ksc_open_telugu_decision(v_paper, 'QUESTION_VERIFY', p_question_id, NULL, NULL, NULL, NULL, v_todo, p_note);
  FOREACH v_id IN ARRAY v_todo LOOP
    PERFORM public.ksc_resolve_telugu_review_item(v_id, 'ACCEPT', NULL, coalesce(p_note, 'Looks correct (question-level Telugu verification)'));
  END LOOP;
  PERFORM public.ksc_close_telugu_decision();

  -- The Telugu text is exactly what the teacher saw; answers are untouched.
  FOR v_item IN SELECT * FROM public.draft_review_items WHERE id = ANY (v_todo) LOOP
    IF public.ksc_telugu_unit_view(CASE WHEN v_item.target_question_text_id IS NOT NULL THEN 'QUESTION' ELSE 'OPTION' END,
         coalesce(v_item.target_question_text_id, v_item.target_option_text_id), v_paper) IS DISTINCT FROM v_expected->>v_item.id::TEXT THEN
      RAISE EXCEPTION 'KSC_TELUGU_TEXT_INVARIANT_VIOLATED';
    END IF;
  END LOOP;
  IF public.ksc_answer_state(ARRAY[p_question_id]) IS DISTINCT FROM v_answers THEN RAISE EXCEPTION 'KSC_ANSWER_INVARIANT_VIOLATED'; END IF;
  RETURN jsonb_build_object('status', 'RESOLVED', 'decision_id', v_decision, 'resolved', cardinality(v_todo), 'already', cardinality(v_already), 'item_ids', to_jsonb(v_todo));
END $$;
REVOKE ALL ON FUNCTION public.ksc_verify_question_telugu(UUID, JSONB, TEXT) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.ksc_verify_question_telugu(UUID, JSONB, TEXT) TO authenticated;

-- =========================================================================
-- 6. Repeated identical source: verify or correct once, per occurrence, never on matching OCR strings.
--    p_occurrences: [{ "item_id": uuid, "expected": "<the Telugu the teacher saw there>" }]
-- =========================================================================
CREATE OR REPLACE FUNCTION public.ksc_apply_telugu_source_decision(p_draft_paper_id UUID, p_fingerprint TEXT, p_mode TEXT, p_text TEXT,
    p_occurrences JSONB, p_note TEXT DEFAULT NULL)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_uid UUID := auth.uid(); v_req JSONB; v_item public.draft_review_items; v_owner TEXT; v_row UUID; v_row_media UUID; v_state TEXT; v_content TEXT;
  v_view TEXT; v_outcome TEXT; v_reason TEXT; v_q UUID; v_questions UUID[] := '{}'; v_ids UUID[] := '{}'; v_answers TEXT;
  v_decision UUID; v_results JSONB := '[]'::jsonb; v_applied INT := 0; v_conflicts INT := 0; v_old TEXT;
BEGIN
  IF v_uid IS NULL OR NOT public.is_teacher() THEN RAISE EXCEPTION 'Teacher access required'; END IF;
  PERFORM 1 FROM public.draft_papers WHERE id = p_draft_paper_id AND created_by = v_uid FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Draft paper not found or unauthorized'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.draft_analysis_runs WHERE draft_paper_id = p_draft_paper_id AND preparation_state = 'PREPARED') THEN
    RAISE EXCEPTION 'KSC_PAPER_NOT_PREPARED';
  END IF;
  IF p_fingerprint IS NULL OR p_fingerprint !~ '^tg1:[0-9a-f]{24}$' THEN RAISE EXCEPTION 'KSC_FINGERPRINT_INVALID'; END IF;
  IF p_mode NOT IN ('VERIFY_SOURCE_AS_CORRECT', 'CORRECT_SOURCE_TEXT') THEN RAISE EXCEPTION 'KSC_SOURCE_MODE_INVALID'; END IF;
  IF coalesce(btrim(p_text), '') = '' OR p_text ~ '[-�]' OR p_text !~ '[ఀ-౿]' OR length(p_text) > 2000 THEN
    RAISE EXCEPTION 'KSC_TELUGU_TEXT_INVALID';
  END IF;
  IF jsonb_typeof(p_occurrences) IS DISTINCT FROM 'array' OR jsonb_array_length(p_occurrences) = 0 OR jsonb_array_length(p_occurrences) > 40 THEN
    RAISE EXCEPTION 'KSC_OCCURRENCES_REQUIRED';
  END IF;
  IF (SELECT count(DISTINCT e->>'item_id') FROM jsonb_array_elements(p_occurrences) e) <> jsonb_array_length(p_occurrences) THEN RAISE EXCEPTION 'KSC_OCCURRENCES_DUPLICATED'; END IF;

  -- Every named occurrence must be THIS paper's Telugu unit printed from THIS frozen fingerprint (else nothing).
  -- The fingerprint is read from the review item's own crop (items are not client-writable) and the text row
  -- must still point at that crop.
  FOR v_req IN SELECT e FROM jsonb_array_elements(p_occurrences) e LOOP
    SELECT * INTO v_item FROM public.draft_review_items WHERE id = NULLIF(v_req->>'item_id', '')::UUID AND draft_paper_id = p_draft_paper_id;
    IF NOT FOUND OR v_item.item_type NOT IN ('TELUGU_STEM', 'TELUGU_OPTION', 'TELUGU_VERIFY')
       OR NOT EXISTS (SELECT 1 FROM public.draft_media m WHERE m.id = v_item.source_media_id AND m.draft_paper_id = p_draft_paper_id
                        AND m.capture_method = 'AUTO_REGION' AND m.detection_detail->>'sourceFp' = p_fingerprint) THEN
      RAISE EXCEPTION 'KSC_OCCURRENCE_NOT_OF_FINGERPRINT' USING DETAIL = coalesce(v_req->>'item_id', '?');
    END IF;
    IF v_item.target_question_text_id IS NOT NULL THEN SELECT source_media_id INTO v_row_media FROM public.draft_question_texts WHERE id = v_item.target_question_text_id;
    ELSE SELECT source_media_id INTO v_row_media FROM public.draft_option_texts WHERE id = v_item.target_option_text_id; END IF;
    IF v_row_media IS DISTINCT FROM v_item.source_media_id THEN RAISE EXCEPTION 'KSC_OCCURRENCE_NOT_OF_FINGERPRINT' USING DETAIL = v_item.id::TEXT; END IF;
    v_ids := v_ids || v_item.id;
    v_questions := v_questions || coalesce(v_item.draft_question_id, (SELECT draft_question_id FROM public.draft_options WHERE id = v_item.draft_option_id));
  END LOOP;
  v_answers := public.ksc_answer_state(v_questions);

  -- Each occurrence on its own, against ITS current state.
  FOR v_req IN SELECT e FROM jsonb_array_elements(p_occurrences) e ORDER BY e->>'item_id' LOOP
    SELECT * INTO v_item FROM public.draft_review_items WHERE id = (v_req->>'item_id')::UUID FOR UPDATE;
    IF v_item.target_question_text_id IS NOT NULL THEN v_owner := 'QUESTION'; v_row := v_item.target_question_text_id;
      SELECT verification_state, content INTO v_state, v_content FROM public.draft_question_texts WHERE id = v_row FOR UPDATE;
    ELSE v_owner := 'OPTION'; v_row := v_item.target_option_text_id;
      SELECT verification_state, content INTO v_state, v_content FROM public.draft_option_texts WHERE id = v_row FOR UPDATE; END IF;
    v_view := public.ksc_telugu_unit_view(v_owner, v_row, p_draft_paper_id);
    v_outcome := NULL; v_reason := NULL; v_old := v_view;
    IF v_item.status = 'RESOLVED' OR v_state IS NOT NULL THEN
      IF v_state IS NOT NULL AND v_content = p_text THEN v_outcome := 'ALREADY_APPLIED';             -- idempotent repeat
      ELSE v_outcome := 'CONFLICT'; v_reason := 'ALREADY_DECIDED'; END IF;                        -- never overwritten
    ELSIF v_view IS DISTINCT FROM v_req->>'expected' THEN v_outcome := 'CONFLICT'; v_reason := 'STALE_VIEW';
    ELSIF v_view = p_text THEN v_outcome := 'VERIFIED';
    ELSIF p_mode = 'VERIFY_SOURCE_AS_CORRECT' THEN v_outcome := 'CONFLICT'; v_reason := 'READING_DIFFERS';
    ELSE v_outcome := 'CORRECTED'; END IF;

    IF v_outcome IN ('VERIFIED', 'CORRECTED', 'CONFLICT') AND v_decision IS NULL THEN
      v_decision := public.ksc_open_telugu_decision(p_draft_paper_id, p_mode, NULL, NULL, p_fingerprint, NULL, p_text, v_ids, p_note);
    END IF;
    IF v_outcome IN ('VERIFIED', 'CORRECTED') THEN
      BEGIN
        IF v_outcome = 'VERIFIED' THEN
          PERFORM public.ksc_resolve_telugu_review_item(v_item.id, 'ACCEPT', NULL, coalesce(p_note, 'Verified once for every identical print (' || p_fingerprint || ')'));
        ELSE
          PERFORM public.ksc_revise_language_text(v_row, v_owner, 'REPLACE', p_text, coalesce(p_note, 'Corrected once for every identical print (' || p_fingerprint || ')'));
        END IF;
        v_applied := v_applied + 1;
      EXCEPTION WHEN OTHERS THEN
        v_outcome := 'REFUSED'; v_reason := SQLERRM;
      END;
    END IF;
    IF v_outcome IN ('CONFLICT', 'REFUSED') THEN
      v_conflicts := v_conflicts + 1;
      INSERT INTO public.draft_telugu_decision_items (decision_id, draft_paper_id, review_item_id, item_type, draft_question_id, text_row_id, owner,
          outcome, reason, evidence_class, resolution, text_before, text_after, ocr_verdict, machine_reasons, source_fingerprint, actor)
      VALUES (v_decision, p_draft_paper_id, v_item.id, v_item.item_type,
          coalesce(v_item.draft_question_id, (SELECT draft_question_id FROM public.draft_options WHERE id = v_item.draft_option_id)), v_row, v_owner,
          v_outcome, v_reason, 'NONE', v_item.resolution, v_old, v_view, v_item.detail->>'verdict', v_item.machine_reasons, p_fingerprint, v_uid);
    END IF;
    v_results := v_results || jsonb_build_object('item_id', v_item.id, 'outcome', v_outcome, 'reason', v_reason, 'before', v_old);
  END LOOP;
  PERFORM public.ksc_close_telugu_decision();

  IF public.ksc_answer_state(v_questions) IS DISTINCT FROM v_answers THEN RAISE EXCEPTION 'KSC_ANSWER_INVARIANT_VIOLATED'; END IF;
  RETURN jsonb_build_object('decision_id', v_decision, 'fingerprint', p_fingerprint, 'mode', p_mode, 'applied', v_applied, 'conflicts', v_conflicts,
    'reused', v_decision IS NULL, 'occurrences', v_results);
END $$;
REVOKE ALL ON FUNCTION public.ksc_apply_telugu_source_decision(UUID, TEXT, TEXT, TEXT, JSONB, TEXT) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.ksc_apply_telugu_source_decision(UUID, TEXT, TEXT, TEXT, JSONB, TEXT) TO authenticated;

-- =========================================================================
-- 7. Shared passages: automatic OCR proposal (writer) and the teacher's one decision.
--    p_texts: [{ draft_material_id, content|null, text_quality ('OCR_EXTRACTED'|'MISSING'), ocr_original_content,
--                ocr_engine, ocr_version, ocr_confidence, ocr_verdict, ocr_detail, source_media_id }]
-- =========================================================================
CREATE OR REPLACE FUNCTION public.ksc_replace_auto_material_telugu(p_draft_paper_id UUID, p_run_id UUID, p_texts JSONB)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE v_uid UUID := auth.uid(); v_import UUID; v_t JSONB; v_n INT := 0;
BEGIN
  IF v_uid IS NULL OR NOT public.is_teacher() THEN RAISE EXCEPTION 'Teacher access required'; END IF;
  IF jsonb_typeof(p_texts) IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'p_texts must be a JSON array'; END IF;
  SELECT source_import_id INTO v_import FROM public.draft_papers WHERE id = p_draft_paper_id AND created_by = v_uid FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Draft paper not found or unauthorized'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.draft_analysis_runs WHERE id = p_run_id AND source_import_id = v_import
                   AND draft_paper_id = p_draft_paper_id AND status = 'SUCCEEDED') THEN
    RAISE EXCEPTION 'KSC_ANALYSIS_RUN_INVALID' USING HINT = 'OCR must come from the run that produced this Draft.';
  END IF;
  IF public.ksc_draft_has_teacher_work(p_draft_paper_id) THEN RAISE EXCEPTION 'KSC_DRAFT_HAS_TEACHER_WORK'; END IF;
  FOR v_t IN SELECT * FROM jsonb_array_elements(p_texts) LOOP
    IF NOT EXISTS (SELECT 1 FROM public.draft_materials WHERE id = NULLIF(v_t->>'draft_material_id', '')::UUID AND draft_paper_id = p_draft_paper_id) THEN
      RAISE EXCEPTION 'KSC_MATERIAL_NOT_OF_PAPER';
    END IF;
    IF NULLIF(v_t->>'source_media_id', '') IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.draft_media WHERE id = (v_t->>'source_media_id')::UUID
         AND draft_material_id = (v_t->>'draft_material_id')::UUID AND capture_method = 'AUTO_REGION' AND media_kind = 'TEXT_REGION') THEN
      RAISE EXCEPTION 'KSC_MATERIAL_CROP_INVALID';
    END IF;
    IF v_t->>'text_quality' NOT IN ('OCR_EXTRACTED', 'MISSING') OR coalesce(v_t->>'ocr_original_content', '') !~ '[ఀ-౿]' THEN
      RAISE EXCEPTION 'KSC_MATERIAL_OCR_INVALID';
    END IF;
  END LOOP;
  PERFORM set_config('ksc.auto_material_telugu_writer', 'on', true);
  DELETE FROM public.draft_material_texts mx USING public.draft_materials m
  WHERE m.id = mx.draft_material_id AND m.draft_paper_id = p_draft_paper_id AND mx.source = 'AUTO_OCR' AND mx.verification_state IS NULL;
  INSERT INTO public.draft_material_texts (draft_material_id, language, content, text_quality, source, source_media_id, ocr_original_content,
      ocr_engine, ocr_version, ocr_confidence, ocr_verdict, ocr_detail, created_by)
  SELECT (t->>'draft_material_id')::UUID, 'te', CASE WHEN t->>'text_quality' = 'OCR_EXTRACTED' THEN t->>'ocr_original_content' END, t->>'text_quality',
      'AUTO_OCR', NULLIF(t->>'source_media_id', '')::UUID, t->>'ocr_original_content', t->>'ocr_engine', t->>'ocr_version',
      NULLIF(t->>'ocr_confidence', '')::NUMERIC, t->>'ocr_verdict', t->'ocr_detail', v_uid
  FROM jsonb_array_elements(p_texts) t;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  PERFORM set_config('ksc.auto_material_telugu_writer', 'off', true);
  RETURN jsonb_build_object('material_texts', v_n);
END $$;
REVOKE ALL ON FUNCTION public.ksc_replace_auto_material_telugu(UUID, UUID, JSONB) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.ksc_replace_auto_material_telugu(UUID, UUID, JSONB) TO authenticated;

-- ACCEPT: the OCR proposal becomes teacher-verified OCR text. EDIT: the teacher's text, the OCR kept beside it.
CREATE OR REPLACE FUNCTION public.ksc_resolve_shared_passage(p_item_id UUID, p_action TEXT, p_expected TEXT, p_text TEXT DEFAULT NULL, p_note TEXT DEFAULT NULL)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE v_uid UUID := auth.uid(); r public.draft_review_items; mx public.draft_material_texts; v_decision UUID; v_new TEXT;
BEGIN
  IF v_uid IS NULL OR NOT public.is_teacher() THEN RAISE EXCEPTION 'Teacher access required'; END IF;
  IF p_action NOT IN ('ACCEPT', 'EDIT') THEN RAISE EXCEPTION 'KSC_TELUGU_ACTION_INVALID'; END IF;
  SELECT i.* INTO r FROM public.draft_review_items i JOIN public.draft_papers p ON p.id = i.draft_paper_id
  WHERE i.id = p_item_id AND p.created_by = v_uid FOR UPDATE OF i;
  IF NOT FOUND THEN RAISE EXCEPTION 'Review item not found or unauthorized'; END IF;
  IF r.item_type <> 'MATERIAL_TELUGU' THEN RAISE EXCEPTION 'KSC_NOT_A_PASSAGE_ITEM'; END IF;
  SELECT * INTO mx FROM public.draft_material_texts WHERE draft_material_id = r.draft_material_id AND language = 'te' FOR UPDATE;
  IF NOT FOUND OR mx.ocr_original_content IS NULL THEN RAISE EXCEPTION 'KSC_NO_PASSAGE_OCR' USING HINT = 'This passage has no OCR proposal; type it instead.'; END IF;
  v_new := CASE WHEN p_action = 'ACCEPT' THEN mx.ocr_original_content ELSE p_text END;
  IF r.status = 'RESOLVED' THEN
    IF mx.verification_state IN ('VERIFIED_OCR', 'EDITED_FROM_OCR') AND mx.content = v_new THEN
      RETURN jsonb_build_object('status', 'ALREADY_APPLIED');
    END IF;
    RAISE EXCEPTION 'KSC_REVIEW_ITEM_ALREADY_RESOLVED';
  END IF;
  IF mx.verification_state IS NOT NULL OR p_expected IS DISTINCT FROM mx.ocr_original_content THEN
    RAISE EXCEPTION 'KSC_STALE_VIEW' USING HINT = 'The passage changed since the page was loaded; reload and look again.';
  END IF;
  IF p_action = 'EDIT' AND (coalesce(btrim(p_text), '') = '' OR p_text ~ '[-�]') THEN RAISE EXCEPTION 'KSC_TELUGU_TEXT_INVALID'; END IF;

  v_decision := public.ksc_open_telugu_decision(r.draft_paper_id, CASE WHEN p_action = 'ACCEPT' THEN 'PASSAGE_ACCEPT' ELSE 'PASSAGE_EDIT' END,
    NULL, r.draft_material_id, NULL, mx.ocr_original_content, v_new, ARRAY[r.id], p_note);
  PERFORM set_config('ksc.review_resolution', 'on', true);
  IF p_action = 'ACCEPT' THEN
    UPDATE public.draft_material_texts SET content = mx.ocr_original_content, text_quality = 'OCR_EXTRACTED', verification_state = 'VERIFIED_OCR',
      verified_by = v_uid, verified_at = NOW(), updated_at = NOW() WHERE id = mx.id;
  ELSE
    UPDATE public.draft_material_texts SET content = p_text, text_quality = 'TEACHER_ENTERED', verification_state = 'EDITED_FROM_OCR',
      verified_by = v_uid, verified_at = NOW(), updated_at = NOW() WHERE id = mx.id;
  END IF;
  UPDATE public.draft_review_items SET status = 'RESOLVED', resolution = CASE WHEN p_action = 'ACCEPT' THEN 'ACCEPTED_OCR' ELSE 'EDITED_OCR' END,
    resolution_value = CASE WHEN p_action = 'EDIT' THEN p_text END, resolution_note = p_note, resolved_by = v_uid, resolved_at = NOW(), updated_at = NOW()
  WHERE id = r.id;
  PERFORM set_config('ksc.review_resolution', 'off', true);
  PERFORM public.ksc_close_telugu_decision();
  RETURN jsonb_build_object('status', 'RESOLVED', 'decision_id', v_decision, 'resolution', CASE WHEN p_action = 'ACCEPT' THEN 'ACCEPTED_OCR' ELSE 'EDITED_OCR' END);
END $$;
REVOKE ALL ON FUNCTION public.ksc_resolve_shared_passage(UUID, TEXT, TEXT, TEXT, TEXT) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.ksc_resolve_shared_passage(UUID, TEXT, TEXT, TEXT, TEXT) TO authenticated;

-- =========================================================================
-- 8. Retry safety = 0032 definition, except that an untouched automatic passage OCR proposal is not teacher
--    work; any teacher decision on it (and any 0033 decision) is.
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
      AND (mx.source <> 'AUTO_OCR' OR mx.verification_state IS NOT NULL OR mx.updated_at > mx.created_at)
  ) OR EXISTS (
    SELECT 1 FROM public.draft_review_items ri WHERE ri.draft_paper_id = p_draft_paper_id AND ri.status <> 'OPEN'
  ) OR EXISTS (
    SELECT 1 FROM public.draft_math_image_resolutions mr WHERE mr.draft_paper_id = p_draft_paper_id
  ) OR EXISTS (
    SELECT 1 FROM public.draft_telugu_decisions td WHERE td.draft_paper_id = p_draft_paper_id
  );
$$;
REVOKE ALL ON FUNCTION public.ksc_draft_has_teacher_work(UUID) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.ksc_draft_has_teacher_work(UUID) TO authenticated;

COMMIT;
