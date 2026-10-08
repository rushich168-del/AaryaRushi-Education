-- KSC B4.8.2 — review-item reconciliation after teacher edits (NEW guarded forward migration; needs 0030)
--
-- Review items are generated once, when a paper is prepared. A teacher who then fixes the Draft itself
-- (types an empty option, adds the missing option D, types a missing stem) removes the defect, but the
-- item stayed open: on KSC, Q28's ANSWER_KEY item still said "the key points at an empty option" after
-- the teacher typed option D.
--
-- This migration closes such an item automatically — and ONLY when its defect is provably gone from the
-- stored Draft, judged with the same rules that created it:
--   OPTION_EMPTY          the option now has text;
--   ANSWER_KEY            (KEY_POINTS_AT_EMPTY_OPTION / KEY_LETTER_HAS_NO_OPTION) exactly one option is
--                         PROPOSED and it has text — the same check ksc_resolve_review_item (0027) applies.
--                         Nothing is confirmed; NO_ANSWER_KEY_ENTRY is never closed automatically;
--   OPTION_SET_ABNORMAL   (FEWER/MORE_THAN_4_OPTIONS, NO_OPTIONS, OPTION_COUNT_n, DUPLICATE_OPTION_TEXT)
--                         exactly four options A-D (or 1-4), all with text, all different, and no option
--                         still carrying another option's marker ("Iron D)Aluminium"). An item that
--                         carries DUPLICATE_OPTION_MARKERS is NEVER closed automatically: that evidence
--                         is in the source layout, not in the stored options (Q28, Q43);
--   ENGLISH_STEM_MISSING  the stem has at least 10 characters (the generator's threshold).
-- Every other item type is never closed by this migration. A defect that still exists keeps its item.
--
-- A closed item is status RESOLVED with the new resolution RECONCILED, resolved_by = the teacher whose
-- edit removed the defect, and a note naming the rule. If a later edit brings the defect back, an item
-- closed this way reopens (never one a teacher closed by hand). Answers are never confirmed, no text is written
-- anywhere except the item's own status, and no option, question or language row is changed.
--
-- Triggers on draft_options (insert/update/delete) and draft_questions.content reconcile the edited
-- question's items at the moment of the edit. ksc_reconcile_review_items(paper) lets the owner reconcile
-- items left stale by edits made before this migration (the Review Center calls it when it opens).
-- Automatic preparation is unaffected: its writers delete and re-insert questions (items cascade) and
-- write review items afterwards, so no item exists yet when their rows are inserted.
--
-- Migrations 0001-0030 are not edited. No Question Bank, snapshot, publish, attempt, evaluation,
-- storage-policy or bucket object is touched.
BEGIN;

DO $$ BEGIN
 IF to_regclass('public.organizations') IS NOT NULL OR to_regprocedure('ksc_private.provision_student()') IS NULL
 THEN RAISE EXCEPTION 'Expected isolated KSC baseline'; END IF;
 IF to_regclass('public.draft_review_items') IS NULL OR to_regprocedure('public.ksc_paper_preparation_status(uuid)') IS NULL THEN
  RAISE EXCEPTION 'Missing B4.5/B4.7 objects. Ensure 0027 and 0029 are applied.';
 END IF;
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.draft_media'::regclass AND conname = 'draft_media_source_region_provenance') THEN
  RAISE EXCEPTION 'Missing draft_media_source_region_provenance. Ensure 0030 is applied.';
 END IF;
END $$;

-- =========================================================================
-- 1. Resolution value RECONCILED. The column CHECK from 0027 is found by its exact definition (the
--    resolution list, not the status/resolution consistency rule) — exactly one must match.
-- =========================================================================
DO $$
DECLARE v_names TEXT[];
BEGIN
  SELECT array_agg(conname) INTO v_names FROM pg_constraint
  WHERE conrelid = 'public.draft_review_items'::regclass AND contype = 'c'
    AND pg_get_constraintdef(oid) LIKE '%resolution = ANY%' AND pg_get_constraintdef(oid) NOT LIKE '%status%';
  IF coalesce(array_length(v_names, 1), 0) = 1 AND v_names[1] <> 'draft_review_items_resolution_v2' THEN
    EXECUTE format('ALTER TABLE public.draft_review_items DROP CONSTRAINT %I', v_names[1]);
  ELSIF coalesce(array_length(v_names, 1), 0) = 1 AND v_names[1] = 'draft_review_items_resolution_v2' THEN
    RETURN;   -- already applied
  ELSE
    RAISE EXCEPTION 'Expected exactly one resolution CHECK on draft_review_items, found %', coalesce(v_names::TEXT, 'none');
  END IF;
  ALTER TABLE public.draft_review_items ADD CONSTRAINT draft_review_items_resolution_v2 CHECK (resolution IS NULL OR resolution IN
    ('ACCEPTED_OCR','EDITED_OCR','TRANSCRIBED','MARKED_MISSING','RESOLVED','ACCEPTED_AS_IS','RECONCILED'));
END $$;

-- =========================================================================
-- 2. Is the item's defect still present in the stored Draft?  TRUE = present, FALSE = provably gone,
--    NULL = not decidable from the Draft (never closed automatically).
-- =========================================================================
CREATE OR REPLACE FUNCTION public.ksc_review_item_defect_present(p_item public.draft_review_items) RETURNS BOOLEAN
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_q UUID; v_reasons TEXT[]; v_n INT; v_markers TEXT; v_blank INT; v_distinct INT; v_glued INT; v_proposed INT; v_prop_blank INT; v_len INT;
BEGIN
  SELECT coalesce(array_agg(r), '{}') INTO v_reasons FROM jsonb_array_elements_text(p_item.machine_reasons) AS r;
  v_q := coalesce(p_item.draft_question_id, (SELECT draft_question_id FROM public.draft_options WHERE id = p_item.draft_option_id));
  IF v_q IS NULL THEN RETURN NULL; END IF;

  IF p_item.item_type = 'OPTION_EMPTY' THEN
    RETURN coalesce((SELECT btrim(coalesce(content, '')) = '' FROM public.draft_options WHERE id = p_item.draft_option_id), TRUE);

  ELSIF p_item.item_type = 'ANSWER_KEY' THEN
    IF NOT (v_reasons <@ ARRAY['KEY_POINTS_AT_EMPTY_OPTION','KEY_LETTER_HAS_NO_OPTION']) OR cardinality(v_reasons) = 0 THEN RETURN NULL; END IF;
    SELECT count(*) FILTER (WHERE is_proposed_correct), count(*) FILTER (WHERE is_proposed_correct AND btrim(coalesce(content, '')) = '')
      INTO v_proposed, v_prop_blank FROM public.draft_options WHERE draft_question_id = v_q;
    RETURN NOT (v_proposed = 1 AND v_prop_blank = 0);

  ELSIF p_item.item_type = 'OPTION_SET_ABNORMAL' THEN
    IF cardinality(v_reasons) = 0 OR EXISTS (SELECT 1 FROM unnest(v_reasons) r
         WHERE r !~ '^(FEWER_THAN_4_OPTIONS|MORE_THAN_4_OPTIONS|NO_OPTIONS|OPTION_COUNT_[0-9]+|DUPLICATE_OPTION_TEXT)') THEN
      RETURN NULL;   -- DUPLICATE_OPTION_MARKERS or anything unknown: teacher decides
    END IF;
    SELECT count(*), string_agg(marker, '' ORDER BY marker), count(*) FILTER (WHERE btrim(coalesce(content, '')) = ''),
           count(DISTINCT lower(btrim(content))) FILTER (WHERE btrim(coalesce(content, '')) <> ''),
           count(*) FILTER (WHERE content ~ '[^(A-Z][A-D]\)')
      INTO v_n, v_markers, v_blank, v_distinct, v_glued FROM public.draft_options WHERE draft_question_id = v_q;
    RETURN NOT (v_n = 4 AND v_markers IN ('ABCD', '1234') AND v_blank = 0 AND v_distinct = 4 AND v_glued = 0);

  ELSIF p_item.item_type = 'ENGLISH_STEM_MISSING' THEN
    SELECT length(btrim(coalesce(content, ''))) INTO v_len FROM public.draft_questions WHERE id = v_q;
    RETURN coalesce(v_len, 0) < 10;
  END IF;
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION public.ksc_review_item_defect_present(public.draft_review_items) FROM PUBLIC, anon, authenticated, service_role;

-- =========================================================================
-- 3. Close the question's items whose defect is gone — and reopen an item THIS mechanism closed if a
--    later edit brings the defect back (e.g. the option is blanked again). Items a teacher resolved,
--    accepted or deferred by hand are never reopened. Needs an accountable user; without one (a database
--    administrator's edit) nothing changes. Returns the number of items closed.
-- =========================================================================
CREATE OR REPLACE FUNCTION public.ksc_reconcile_question_review_items(p_question_id UUID, p_actor UUID) RETURNS INT
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE r public.draft_review_items; v_n INT := 0; v_present BOOLEAN; v_why TEXT;
BEGIN
  IF p_actor IS NULL OR p_question_id IS NULL THEN RETURN 0; END IF;
  FOR r IN
    SELECT i.* FROM public.draft_review_items i
    WHERE i.blocking AND (i.status IN ('OPEN','DEFERRED') OR (i.status = 'RESOLVED' AND i.resolution = 'RECONCILED'))
      AND i.item_type IN ('OPTION_EMPTY','ANSWER_KEY','OPTION_SET_ABNORMAL','ENGLISH_STEM_MISSING')
      AND (i.draft_question_id = p_question_id
           OR i.draft_option_id IN (SELECT id FROM public.draft_options WHERE draft_question_id = p_question_id))
    FOR UPDATE OF i
  LOOP
    v_present := public.ksc_review_item_defect_present(r);
    v_why := r.item_type || ': ' || coalesce((SELECT string_agg(x, ', ') FROM jsonb_array_elements_text(r.machine_reasons) x), '');
    IF r.status <> 'RESOLVED' AND v_present IS FALSE THEN
      UPDATE public.draft_review_items SET status = 'RESOLVED', resolution = 'RECONCILED', resolved_by = p_actor, resolved_at = NOW(), updated_at = NOW(),
        resolution_note = 'Closed automatically: the Draft no longer has this defect (' || v_why || ').'
      WHERE id = r.id;
      v_n := v_n + 1;
    ELSIF r.status = 'RESOLVED' AND v_present IS TRUE THEN
      UPDATE public.draft_review_items SET status = 'OPEN', resolution = NULL, resolved_by = NULL, resolved_at = NULL, updated_at = NOW(),
        resolution_note = 'Reopened automatically: a later edit brought the defect back (' || v_why || ').'
      WHERE id = r.id;
    END IF;
  END LOOP;
  RETURN v_n;
END $$;
REVOKE ALL ON FUNCTION public.ksc_reconcile_question_review_items(UUID, UUID) FROM PUBLIC, anon, authenticated, service_role;

-- =========================================================================
-- 4. At the moment of a teacher edit.
-- =========================================================================
CREATE OR REPLACE FUNCTION public.ksc_reconcile_after_draft_edit() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF TG_TABLE_NAME = 'draft_questions' THEN
    PERFORM public.ksc_reconcile_question_review_items(NEW.id, auth.uid());
  ELSIF TG_OP = 'DELETE' THEN
    PERFORM public.ksc_reconcile_question_review_items(OLD.draft_question_id, auth.uid());
  ELSE
    PERFORM public.ksc_reconcile_question_review_items(NEW.draft_question_id, auth.uid());
    IF TG_OP = 'UPDATE' AND OLD.draft_question_id IS DISTINCT FROM NEW.draft_question_id THEN
      PERFORM public.ksc_reconcile_question_review_items(OLD.draft_question_id, auth.uid());
    END IF;
  END IF;
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION public.ksc_reconcile_after_draft_edit() FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS reconcile_review_items_after_option_edit ON public.draft_options;
CREATE TRIGGER reconcile_review_items_after_option_edit
AFTER INSERT OR DELETE OR UPDATE OF content, marker, position, is_proposed_correct, draft_question_id ON public.draft_options
FOR EACH ROW EXECUTE FUNCTION public.ksc_reconcile_after_draft_edit();

DROP TRIGGER IF EXISTS reconcile_review_items_after_stem_edit ON public.draft_questions;
CREATE TRIGGER reconcile_review_items_after_stem_edit
AFTER UPDATE OF content ON public.draft_questions
FOR EACH ROW WHEN (OLD.content IS DISTINCT FROM NEW.content) EXECUTE FUNCTION public.ksc_reconcile_after_draft_edit();

-- =========================================================================
-- 5. Owner-callable catch-up for items left stale by earlier edits. Idempotent; closes only what
--    section 2 proves; returns how many items it closed.
-- =========================================================================
CREATE OR REPLACE FUNCTION public.ksc_reconcile_review_items(p_draft_paper_id UUID) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE v_uid UUID := auth.uid(); v_q UUID; v_n INT := 0;
BEGIN
  IF v_uid IS NULL OR NOT public.is_teacher() THEN RAISE EXCEPTION 'Teacher access required'; END IF;
  PERFORM 1 FROM public.draft_papers WHERE id = p_draft_paper_id AND created_by = v_uid FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Draft paper not found or unauthorized'; END IF;
  FOR v_q IN
    SELECT DISTINCT coalesce(i.draft_question_id, o.draft_question_id)
    FROM public.draft_review_items i LEFT JOIN public.draft_options o ON o.id = i.draft_option_id
    WHERE i.draft_paper_id = p_draft_paper_id AND i.blocking AND i.status IN ('OPEN','DEFERRED')
      AND i.item_type IN ('OPTION_EMPTY','ANSWER_KEY','OPTION_SET_ABNORMAL','ENGLISH_STEM_MISSING')
  LOOP
    v_n := v_n + public.ksc_reconcile_question_review_items(v_q, v_uid);
  END LOOP;
  RETURN jsonb_build_object('reconciled', v_n);
END $$;
REVOKE ALL ON FUNCTION public.ksc_reconcile_review_items(UUID) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.ksc_reconcile_review_items(UUID) TO authenticated;

COMMIT;
