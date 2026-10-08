-- KSC B4.8.3C — deduplicated math-image recovery (NEW guarded forward migration; needs 0031)
--
-- Automatic preparation locates maths printed as small bitmaps and records, per placement, the bitmap's
-- exact-pixel fingerprint ("px:" + 24 hex) and its anchor in the owner's English text (the text just
-- before and after it) in draft_questions.analysis_regions.notation. It never reads the bitmap.
-- This migration lets the OWNING teacher type the maths once per fingerprint and have it placed at every
-- placement she confirmed — atomically, validated, revisioned and audited:
--
--   ksc_math_representation_ok(text)      the ONLY maths accepted: one \( … \) span; digits, a decimal point,
--                                          single Latin letters, spaces, + - = ( ) , . %, \times \div \pi \pm
--                                          \circ, \frac{…}{…}, \sqrt{…}, ^{…}, _{…}; balanced braces. No other
--                                          command, no words, no HTML (a subset of what MathText/KaTeX renders).
--   ksc_math_place_at_anchor(…)           places a value at an anchor: exactly one match or refused. Never a
--                                          guessed position. Same rules as scripts/lib/math-image-recovery.mjs.
--   draft_math_image_resolutions          one row per (paper, fingerprint, revision); a correction adds a
--                                          revision and marks the previous one SUPERSEDED (never overwritten).
--   draft_math_image_placement_log        APPEND-ONLY: every write, conflict, refusal and Telugu hand-off, with
--                                          before/after text, target question/option, fingerprint, revision,
--                                          actor and time. No UPDATE; DELETE only with the paper.
--   ksc_resolve_math_image(…)             the only write path (owner teacher, prepared paper).
--
-- Safety rules enforced here, server-side:
--   * a fingerprint identifies a bitmap; it is NOT authorization: the caller names each placement she saw
--     (question + placement key) with the text she saw; every one must be this paper's evidence for this
--     fingerprint, or the whole call is refused;
--   * each write is checked against the CURRENT stored text: a placement whose text changed since the
--     teacher looked (STALE_VIEW), or since an earlier recovery wrote it (EDITED_SINCE_RECOVERY), is a
--     CONFLICT and is not written; other placements of the same fingerprint still apply (per-placement
--     outcome, one transaction, all logged);
--   * idempotent: repeating a call writes nothing new (ALREADY_APPLIED) and adds no revision;
--   * Telugu text (OCR) is never modified: Telugu placements are logged as TELUGU_REVIEW only;
--   * answers: the proposed/confirmed flags, markers and positions of every affected option and the
--     question confirmation columns are compared before/after; any difference aborts the call;
--   * review items: 0031's triggers close OPTION_EMPTY / ANSWER_KEY only if the new text removed the defect;
--     a NOTATION item (OPTION_SET_ABNORMAL / STRUCTURE) is closed only when every bitmap it names carries a
--     current teacher-verified value in the stored text AND its other reasons are ones 0031 proves gone
--     (DUPLICATE_OPTION_MARKERS and Telugu items stay open);
--   * teacher work: any recovery makes ksc_draft_has_teacher_work true, so re-preparation stays refused;
--   * evidence: analysis_regions (automatic evidence) can no longer be changed by a client role.
--
-- Migrations 0001-0031 are not edited. No Question Bank, snapshot, publish, attempt, evaluation,
-- storage-policy or bucket object is touched. Students and anonymous users get no access.
BEGIN;

DO $$ BEGIN
 IF to_regclass('public.organizations') IS NOT NULL OR to_regprocedure('ksc_private.provision_student()') IS NULL
 THEN RAISE EXCEPTION 'Expected isolated KSC baseline'; END IF;
 IF to_regprocedure('public.ksc_reconcile_review_items(uuid)') IS NULL
    OR NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.draft_review_items'::regclass AND conname = 'draft_review_items_resolution_v2') THEN
  RAISE EXCEPTION 'Missing B4.8.2 objects. Ensure 0031 is applied.';
 END IF;
END $$;

-- =========================================================================
-- 1. Restricted maths (server-side mirror of validateMathLatex).
-- =========================================================================
CREATE OR REPLACE FUNCTION public.ksc_math_representation_ok(p_value TEXT) RETURNS BOOLEAN
LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  m TEXT[]; body TEXT; i INT := 1; n INT; c TEXT; cmd TEXT;
  need INT := 0;            -- braced arguments expected next
  rest INT[] := '{}';       -- per open group: arguments still expected after it closes
  starts INT[] := '{}';     -- per open group: position of its first character
BEGIN
  IF p_value IS NULL THEN RETURN FALSE; END IF;
  m := regexp_match(btrim(p_value), '^\\\((.*)\\\)$');
  IF m IS NULL THEN RETURN FALSE; END IF;
  body := m[1];
  IF strpos(body, '\(') > 0 OR strpos(body, '\)') > 0 OR btrim(body) = '' OR length(body) > 200 THEN RETURN FALSE; END IF;
  n := length(body);
  WHILE i <= n LOOP
    c := substr(body, i, 1);
    IF need > 0 THEN
      IF c = ' ' THEN i := i + 1; CONTINUE; END IF;
      IF c <> '{' THEN RETURN FALSE; END IF;                         -- an argument needs braces
      rest := rest || (need - 1); starts := starts || (i + 1); need := 0; i := i + 1; CONTINUE;
    END IF;
    IF c = '{' THEN RETURN FALSE; END IF;                              -- a bare brace
    IF c = '}' THEN
      IF cardinality(rest) = 0 THEN RETURN FALSE; END IF;
      IF btrim(substr(body, starts[cardinality(starts)], i - starts[cardinality(starts)])) = '' THEN RETURN FALSE; END IF;
      need := rest[cardinality(rest)];
      rest := rest[1:cardinality(rest) - 1]; starts := starts[1:cardinality(starts) - 1];
      i := i + 1; CONTINUE;
    END IF;
    IF c = '\' THEN
      cmd := substring(substr(body, i + 1) FROM '^([a-zA-Z]+)');
      IF cmd IS NULL THEN
        IF substr(body, i + 1, 1) IN ('%', ',') THEN i := i + 2; CONTINUE; END IF;
        RETURN FALSE;
      END IF;
      IF cmd NOT IN ('frac', 'sqrt', 'times', 'div', 'pi', 'pm', 'circ') THEN RETURN FALSE; END IF;
      need := CASE cmd WHEN 'frac' THEN 2 WHEN 'sqrt' THEN 1 ELSE 0 END;
      i := i + 1 + length(cmd); CONTINUE;
    END IF;
    IF c IN ('^', '_') THEN need := 1; i := i + 1; CONTINUE; END IF;
    IF c !~ '^[0-9A-Za-z .+=(),%-]$' THEN RETURN FALSE; END IF;
    IF c ~ '^[A-Za-z]$' AND substr(body, i + 1, 1) ~ '^[A-Za-z]$' THEN RETURN FALSE; END IF;   -- single letters only
    i := i + 1;
  END LOOP;
  RETURN need = 0 AND cardinality(rest) = 0;
END $$;
REVOKE ALL ON FUNCTION public.ksc_math_representation_ok(TEXT) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.ksc_math_representation_ok(TEXT) TO authenticated;

-- =========================================================================
-- 2. Placement at an anchor (server-side mirror of placeAtAnchor). {ok, content} or {ok:false, why}.
-- =========================================================================
CREATE OR REPLACE FUNCTION public.ksc_math_place_at_anchor(p_content TEXT, p_anchor JSONB, p_value TEXT) RETURNS JSONB
LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_before TEXT; v_after TEXT; v_pat TEXT; v_hits INT; v_end INT; v_gap TEXT; v_left TEXT; v_right TEXT; v_text TEXT := coalesce(p_content, '');
BEGIN
  IF NOT public.ksc_math_representation_ok(p_value) THEN RETURN jsonb_build_object('ok', false, 'why', 'INVALID_VALUE'); END IF;
  IF p_anchor IS NULL OR jsonb_typeof(p_anchor) <> 'object' THEN RETURN jsonb_build_object('ok', false, 'why', 'NO_ANCHOR'); END IF;
  v_before := coalesce(p_anchor->>'before', ''); v_after := coalesce(p_anchor->>'after', '');
  IF v_text ~ '^\s*$' THEN
    IF v_before = '' AND v_after = '' THEN RETURN jsonb_build_object('ok', true, 'content', p_value); END IF;
    RETURN jsonb_build_object('ok', false, 'why', 'OWNER_TEXT_MISSING');
  END IF;
  v_pat := CASE WHEN v_before = '' THEN '^' ELSE replace(regexp_replace(v_before, '([.^$*+?()\[\]{}|\\])', '\\\1', 'g'), ' ', '\s+') END
        || '(\s*)'
        || CASE WHEN v_after = '' THEN '$' ELSE '(?=' || replace(regexp_replace(v_after, '([.^$*+?()\[\]{}|\\])', '\\\1', 'g'), ' ', '\s+') || ')' END;
  v_hits := regexp_count(v_text, v_pat);
  IF v_hits <> 1 THEN RETURN jsonb_build_object('ok', false, 'why', CASE WHEN v_hits = 0 THEN 'ANCHOR_NOT_FOUND' ELSE 'ANCHOR_AMBIGUOUS' END); END IF;
  v_end := regexp_instr(v_text, v_pat, 1, 1, 1);                 -- first character after the match
  v_gap := (regexp_match(v_text, v_pat))[1];
  v_left := substr(v_text, 1, v_end - 1 - length(v_gap));
  v_right := substr(v_text, v_end);
  RETURN jsonb_build_object('ok', true, 'content',
    v_left || CASE WHEN v_left = '' OR v_left ~ '\d$' THEN '' ELSE ' ' END
    || p_value || CASE WHEN v_right = '' OR v_right ~ '^[%.,)]' THEN '' ELSE ' ' END || v_right);
END $$;
REVOKE ALL ON FUNCTION public.ksc_math_place_at_anchor(TEXT, JSONB, TEXT) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.ksc_math_place_at_anchor(TEXT, JSONB, TEXT) TO authenticated;

-- =========================================================================
-- 3. Resolutions (revisioned) and the append-only placement log.
-- =========================================================================
CREATE TABLE IF NOT EXISTS public.draft_math_image_resolutions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    draft_paper_id UUID NOT NULL REFERENCES public.draft_papers(id) ON DELETE CASCADE,
    fingerprint TEXT NOT NULL CHECK (fingerprint ~ '^px:[0-9a-f]{24}$'),
    revision INTEGER NOT NULL CHECK (revision >= 1),
    representation TEXT NOT NULL CHECK (public.ksc_math_representation_ok(representation)),
    teacher_input TEXT NOT NULL CHECK (length(btrim(teacher_input)) BETWEEN 1 AND 200),
    provenance TEXT NOT NULL DEFAULT 'TEACHER_ENTERED' CHECK (provenance = 'TEACHER_ENTERED'),
    verification_state TEXT NOT NULL DEFAULT 'TEACHER_VERIFIED' CHECK (verification_state IN ('TEACHER_VERIFIED', 'SUPERSEDED')),
    supersedes UUID REFERENCES public.draft_math_image_resolutions(id),
    note TEXT CHECK (note IS NULL OR length(note) <= 500),
    verified_by UUID NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
    verified_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    superseded_at TIMESTAMPTZ,
    CONSTRAINT draft_math_image_resolutions_one_revision UNIQUE (draft_paper_id, fingerprint, revision),
    CONSTRAINT draft_math_image_resolutions_superseded CHECK ((verification_state = 'SUPERSEDED') = (superseded_at IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS draft_math_image_resolutions_current
  ON public.draft_math_image_resolutions(draft_paper_id, fingerprint) WHERE verification_state = 'TEACHER_VERIFIED';

CREATE TABLE IF NOT EXISTS public.draft_math_image_placement_log (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    draft_paper_id UUID NOT NULL REFERENCES public.draft_papers(id) ON DELETE CASCADE,
    resolution_id UUID NOT NULL REFERENCES public.draft_math_image_resolutions(id) ON DELETE CASCADE,
    fingerprint TEXT NOT NULL,
    revision INTEGER NOT NULL,
    placement_key TEXT NOT NULL,                  -- page@x,y of the bitmap (its evidence box)
    side TEXT NOT NULL CHECK (side IN ('en', 'te')),
    draft_question_id UUID NOT NULL,              -- no FK: the audit outlives a later row removal
    source_question_number TEXT,
    draft_option_id UUID,
    target TEXT NOT NULL CHECK (target IN ('STEM', 'OPTION', 'TELUGU')),
    owner TEXT,
    anchor JSONB,
    outcome TEXT NOT NULL CHECK (outcome IN ('APPLIED', 'CONFLICT', 'REFUSED', 'TELUGU_REVIEW')),
    reason TEXT,
    base_content TEXT,                            -- the pre-recovery text the value was placed in
    content_before TEXT,                          -- the stored text immediately before this entry
    content_after TEXT,                           -- the stored text after it (= before unless APPLIED)
    actor UUID NOT NULL,
    logged_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_math_log_placement ON public.draft_math_image_placement_log(draft_paper_id, draft_question_id, placement_key, id);
CREATE INDEX IF NOT EXISTS idx_math_log_resolution ON public.draft_math_image_placement_log(resolution_id);

-- Revisions: only TEACHER_VERIFIED -> SUPERSEDED may change; rows go only with their paper.
CREATE OR REPLACE FUNCTION public.ksc_guard_math_resolution() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF EXISTS (SELECT 1 FROM public.draft_papers WHERE id = OLD.draft_paper_id) THEN RAISE EXCEPTION 'KSC_MATH_HISTORY_IMMUTABLE'; END IF;
    RETURN OLD;
  END IF;
  IF (to_jsonb(NEW) - 'verification_state' - 'superseded_at') IS DISTINCT FROM (to_jsonb(OLD) - 'verification_state' - 'superseded_at')
     OR NOT (OLD.verification_state = 'TEACHER_VERIFIED' AND NEW.verification_state = 'SUPERSEDED') THEN
    RAISE EXCEPTION 'KSC_MATH_HISTORY_IMMUTABLE' USING HINT = 'A correction adds a revision; earlier revisions are only marked SUPERSEDED.';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.ksc_guard_math_resolution() FROM PUBLIC, anon, authenticated, service_role;
DROP TRIGGER IF EXISTS guard_math_resolution ON public.draft_math_image_resolutions;
CREATE TRIGGER guard_math_resolution BEFORE UPDATE OR DELETE ON public.draft_math_image_resolutions
FOR EACH ROW EXECUTE FUNCTION public.ksc_guard_math_resolution();

CREATE OR REPLACE FUNCTION public.ksc_guard_math_log() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' AND NOT EXISTS (SELECT 1 FROM public.draft_papers WHERE id = OLD.draft_paper_id) THEN RETURN OLD; END IF;
  RAISE EXCEPTION 'KSC_MATH_LOG_APPEND_ONLY';
END $$;
REVOKE ALL ON FUNCTION public.ksc_guard_math_log() FROM PUBLIC, anon, authenticated, service_role;
DROP TRIGGER IF EXISTS guard_math_log ON public.draft_math_image_placement_log;
CREATE TRIGGER guard_math_log BEFORE UPDATE OR DELETE ON public.draft_math_image_placement_log
FOR EACH ROW EXECUTE FUNCTION public.ksc_guard_math_log();

ALTER TABLE public.draft_math_image_resolutions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.draft_math_image_placement_log ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Teachers read own math resolutions" ON public.draft_math_image_resolutions;
CREATE POLICY "Teachers read own math resolutions" ON public.draft_math_image_resolutions FOR SELECT TO authenticated
USING (public.is_teacher() AND EXISTS (SELECT 1 FROM public.draft_papers p WHERE p.id = draft_math_image_resolutions.draft_paper_id AND p.created_by = auth.uid()));
DROP POLICY IF EXISTS "Teachers read own math placement log" ON public.draft_math_image_placement_log;
CREATE POLICY "Teachers read own math placement log" ON public.draft_math_image_placement_log FOR SELECT TO authenticated
USING (public.is_teacher() AND EXISTS (SELECT 1 FROM public.draft_papers p WHERE p.id = draft_math_image_placement_log.draft_paper_id AND p.created_by = auth.uid()));
REVOKE ALL ON public.draft_math_image_resolutions FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON public.draft_math_image_placement_log FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.draft_math_image_resolutions TO authenticated;          -- writes only through section 5
GRANT SELECT ON public.draft_math_image_placement_log TO authenticated;

-- =========================================================================
-- 4. Automatic evidence is not client-editable (the recovery trusts its stored placements and anchors).
-- =========================================================================
CREATE OR REPLACE FUNCTION public.ksc_guard_analysis_evidence() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF NEW.analysis_regions IS DISTINCT FROM OLD.analysis_regions AND current_user IN ('authenticated', 'anon') THEN
    RAISE EXCEPTION 'KSC_ANALYSIS_EVIDENCE_READ_ONLY' USING HINT = 'analysis_regions is written only by automatic preparation.';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.ksc_guard_analysis_evidence() FROM PUBLIC, anon, authenticated, service_role;
DROP TRIGGER IF EXISTS guard_analysis_evidence ON public.draft_questions;
CREATE TRIGGER guard_analysis_evidence BEFORE UPDATE OF analysis_regions ON public.draft_questions
FOR EACH ROW EXECUTE FUNCTION public.ksc_guard_analysis_evidence();

-- =========================================================================
-- 5. The resolution RPC.
--    p_placements: [{ "question_id": uuid, "key": "page@x,y", "expected": "<the text the teacher saw>" }]
-- =========================================================================
CREATE OR REPLACE FUNCTION public.ksc_resolve_math_image(p_draft_paper_id UUID, p_fingerprint TEXT, p_input TEXT, p_representation TEXT,
    p_placements JSONB, p_note TEXT DEFAULT NULL)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_uid UUID := auth.uid();
  v_cur public.draft_math_image_resolutions;
  v_res public.draft_math_image_resolutions;
  v_reused BOOLEAN := FALSE;
  v_req JSONB; v_ev JSONB; v_q public.draft_questions; v_opt public.draft_options;
  v_key TEXT; v_expected TEXT; v_now_text TEXT; v_base TEXT; v_new TEXT; v_place JSONB;
  v_last public.draft_math_image_placement_log;
  v_last_t public.draft_math_image_placement_log;
  v_seen JSONB := '{}'::jsonb; v_tid TEXT; v_view_text TEXT;
  v_target TEXT; v_owner TEXT; v_outcome TEXT; v_reason TEXT;
  v_results JSONB := '[]'::jsonb;
  v_questions UUID[] := '{}';
  v_answers_before TEXT; v_answers_after TEXT;
  v_item public.draft_review_items; v_reasons TEXT[]; v_other TEXT[]; v_owners TEXT[]; v_ok BOOLEAN; v_closed INT := 0;
  v_probe public.draft_review_items;
BEGIN
  -- Who and what.
  IF v_uid IS NULL OR NOT public.is_teacher() THEN RAISE EXCEPTION 'Teacher access required'; END IF;
  PERFORM 1 FROM public.draft_papers WHERE id = p_draft_paper_id AND created_by = v_uid FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Draft paper not found or unauthorized'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.draft_analysis_runs WHERE draft_paper_id = p_draft_paper_id AND preparation_state = 'PREPARED') THEN
    RAISE EXCEPTION 'KSC_PAPER_NOT_PREPARED';
  END IF;
  IF p_fingerprint IS NULL OR p_fingerprint !~ '^px:[0-9a-f]{24}$' THEN RAISE EXCEPTION 'KSC_FINGERPRINT_INVALID'; END IF;
  IF NOT public.ksc_math_representation_ok(p_representation) THEN
    RAISE EXCEPTION 'KSC_MATH_REPRESENTATION_INVALID' USING HINT = 'Only fractions, roots, powers, digits and + - = × ÷ are accepted.';
  END IF;
  IF coalesce(btrim(p_input), '') = '' OR length(p_input) > 200 THEN RAISE EXCEPTION 'KSC_MATH_INPUT_INVALID'; END IF;
  IF jsonb_typeof(p_placements) IS DISTINCT FROM 'array' OR jsonb_array_length(p_placements) = 0 OR jsonb_array_length(p_placements) > 60 THEN
    RAISE EXCEPTION 'KSC_PLACEMENTS_REQUIRED';
  END IF;
  IF (SELECT count(DISTINCT (e->>'question_id') || '|' || (e->>'key')) FROM jsonb_array_elements(p_placements) e) <> jsonb_array_length(p_placements) THEN
    RAISE EXCEPTION 'KSC_PLACEMENTS_DUPLICATED';
  END IF;

  -- Every named placement must be THIS paper's evidence for THIS fingerprint (else nothing happens).
  FOR v_req IN SELECT * FROM jsonb_array_elements(p_placements) LOOP
    IF NOT EXISTS (
      SELECT 1 FROM public.draft_questions q, jsonb_array_elements(coalesce(q.analysis_regions->'notation', '[]'::jsonb)) e
      WHERE q.draft_paper_id = p_draft_paper_id AND q.id::TEXT = v_req->>'question_id' AND e->>'kind' = 'IMAGE' AND e->>'fp' = p_fingerprint
        AND (e->>'page') || '@' || (e->'box'->>'x') || ',' || (e->'box'->>'y') = v_req->>'key') THEN
      RAISE EXCEPTION 'KSC_PLACEMENT_NOT_OF_FINGERPRINT' USING DETAIL = coalesce(v_req->>'question_id', '?') || ' ' || coalesce(v_req->>'key', '?');
    END IF;
    v_questions := v_questions || (v_req->>'question_id')::UUID;
  END LOOP;

  -- Answer invariant snapshot (flags, markers, positions, question confirmation).
  SELECT string_agg(concat_ws('|', o.id, o.is_proposed_correct, o.is_confirmed_correct, o.marker, o.position, o.label), ',' ORDER BY o.id)
    || '#' || (SELECT string_agg(concat_ws('|', q.id, q.confirmed_by, q.confirmed_at), ',' ORDER BY q.id) FROM public.draft_questions q WHERE q.id = ANY (v_questions))
    INTO v_answers_before FROM public.draft_options o WHERE o.draft_question_id = ANY (v_questions);

  -- Revision: same value = the current revision (idempotent); a new value = a new revision.
  SELECT * INTO v_cur FROM public.draft_math_image_resolutions
  WHERE draft_paper_id = p_draft_paper_id AND fingerprint = p_fingerprint AND verification_state = 'TEACHER_VERIFIED' FOR UPDATE;
  IF FOUND AND v_cur.representation = p_representation THEN
    v_res := v_cur; v_reused := TRUE;
  ELSE
    IF v_cur.id IS NOT NULL THEN
      UPDATE public.draft_math_image_resolutions SET verification_state = 'SUPERSEDED', superseded_at = NOW() WHERE id = v_cur.id;
    END IF;
    INSERT INTO public.draft_math_image_resolutions (draft_paper_id, fingerprint, revision, representation, teacher_input, supersedes, note, verified_by)
    VALUES (p_draft_paper_id, p_fingerprint, coalesce(v_cur.revision, 0) + 1, p_representation, btrim(p_input), v_cur.id, p_note, v_uid)
    RETURNING * INTO v_res;
  END IF;

  -- Placements, one at a time (a field holding several requested placements is updated in turn).
  FOR v_req IN SELECT e FROM jsonb_array_elements(p_placements) e ORDER BY e->>'question_id', e->>'key' DESC LOOP
    v_key := v_req->>'key'; v_expected := v_req->>'expected';
    SELECT * INTO v_q FROM public.draft_questions WHERE id = (v_req->>'question_id')::UUID FOR UPDATE;
    SELECT e INTO v_ev FROM jsonb_array_elements(v_q.analysis_regions->'notation') e
    WHERE e->>'kind' = 'IMAGE' AND e->>'fp' = p_fingerprint AND (e->>'page') || '@' || (e->'box'->>'x') || ',' || (e->'box'->>'y') = v_key LIMIT 1;
    v_owner := v_ev->>'owner'; v_opt := NULL; v_reason := NULL; v_new := NULL;

    -- Telugu placements: never written automatically; handed to the Telugu review once per revision.
    IF v_ev->>'side' = 'te' THEN
      IF NOT EXISTS (SELECT 1 FROM public.draft_math_image_placement_log WHERE resolution_id = v_res.id AND draft_question_id = v_q.id
                       AND placement_key = v_key AND outcome = 'TELUGU_REVIEW') THEN
        INSERT INTO public.draft_math_image_placement_log (draft_paper_id, resolution_id, fingerprint, revision, placement_key, side, draft_question_id,
            source_question_number, target, owner, anchor, outcome, reason, actor)
        VALUES (p_draft_paper_id, v_res.id, p_fingerprint, v_res.revision, v_key, 'te', v_q.id, v_q.source_question_number, 'TELUGU', NULL, NULL,
            'TELUGU_REVIEW', 'TELUGU_TEXT_NOT_EDITED_AUTOMATICALLY', v_uid);
        v_outcome := 'TELUGU_REVIEW';
      ELSE v_outcome := 'ALREADY_HANDED_TO_TELUGU_REVIEW'; END IF;
      v_results := v_results || jsonb_build_object('question_id', v_q.id, 'key', v_key, 'side', 'te', 'outcome', v_outcome);
      CONTINUE;
    END IF;

    IF v_owner = 'stem' THEN v_target := 'STEM'; v_now_text := v_q.content;
    ELSE
      v_target := 'OPTION';
      SELECT * INTO v_opt FROM public.draft_options WHERE draft_question_id = v_q.id AND marker = v_owner FOR UPDATE;
      IF NOT FOUND OR (SELECT count(*) FROM public.draft_options WHERE draft_question_id = v_q.id AND marker = v_owner) <> 1 THEN
        v_outcome := 'REFUSED'; v_reason := 'OWNER_NOT_FOUND';
      END IF;
      v_now_text := v_opt.content;
    END IF;

    IF v_reason IS NULL THEN
      -- The text of this field as it was when this call started (what the teacher's view must match),
      -- even if an earlier placement in this call already wrote into the same field.
      v_tid := coalesce(v_opt.id, v_q.id)::TEXT;
      IF NOT v_seen ? v_tid THEN v_seen := v_seen || jsonb_build_object(v_tid, to_jsonb(v_now_text)); END IF;
      v_view_text := v_seen->>v_tid;
      -- This placement's latest recovery write, and the latest recovery write anywhere in this field.
      SELECT * INTO v_last FROM public.draft_math_image_placement_log
      WHERE draft_paper_id = p_draft_paper_id AND draft_question_id = v_q.id AND placement_key = v_key AND outcome = 'APPLIED'
      ORDER BY id DESC LIMIT 1;
      SELECT * INTO v_last_t FROM public.draft_math_image_placement_log
      WHERE draft_paper_id = p_draft_paper_id AND draft_question_id = v_q.id AND outcome = 'APPLIED'
        AND target = v_target AND draft_option_id IS NOT DISTINCT FROM v_opt.id
      ORDER BY id DESC LIMIT 1;
      IF v_last.id IS NOT NULL AND v_now_text IS DISTINCT FROM v_last_t.content_after THEN
        v_outcome := 'CONFLICT'; v_reason := 'EDITED_SINCE_RECOVERY';     -- changed after the recovery wrote it: never overwritten
      ELSIF v_last.id IS NOT NULL AND v_last.resolution_id = v_res.id THEN
        v_outcome := 'ALREADY_APPLIED';                                   -- idempotent repeat: nothing written or logged
      ELSIF v_view_text IS DISTINCT FROM v_expected THEN
        v_outcome := 'CONFLICT'; v_reason := 'STALE_VIEW';                -- changed since the teacher looked
      ELSIF v_last.id IS NOT NULL AND v_last_t.id <> v_last.id THEN
        v_outcome := 'CONFLICT'; v_reason := 'SEVERAL_VALUES_IN_FIELD';   -- a correction would disturb a later value: by hand
      ELSE
        v_base := CASE WHEN v_last.id IS NOT NULL THEN v_last.base_content ELSE v_now_text END;   -- a correction re-places from the original
        v_place := public.ksc_math_place_at_anchor(v_base, v_ev->'anchor', v_res.representation);
        IF (v_place->>'ok')::BOOLEAN THEN
          v_new := v_place->>'content'; v_outcome := 'APPLIED';
          IF v_target = 'STEM' THEN UPDATE public.draft_questions SET content = v_new WHERE id = v_q.id;
          ELSE UPDATE public.draft_options SET content = v_new WHERE id = v_opt.id; END IF;   -- 0031 triggers reconcile here
        ELSE v_outcome := 'REFUSED'; v_reason := v_place->>'why'; END IF;
      END IF;
    END IF;

    IF v_outcome <> 'ALREADY_APPLIED' THEN
      INSERT INTO public.draft_math_image_placement_log (draft_paper_id, resolution_id, fingerprint, revision, placement_key, side, draft_question_id,
          source_question_number, draft_option_id, target, owner, anchor, outcome, reason, base_content, content_before, content_after, actor)
      VALUES (p_draft_paper_id, v_res.id, p_fingerprint, v_res.revision, v_key, 'en', v_q.id, v_q.source_question_number, v_opt.id, v_target, v_owner,
          v_ev->'anchor', v_outcome, v_reason, CASE WHEN v_outcome = 'APPLIED' THEN v_base END, v_now_text, coalesce(v_new, v_now_text), v_uid);
    END IF;
    v_results := v_results || jsonb_build_object('question_id', v_q.id, 'question', v_q.source_question_number, 'key', v_key, 'side', 'en', 'owner', v_owner,
      'outcome', v_outcome, 'reason', v_reason, 'content', coalesce(v_new, v_now_text));
  END LOOP;

  -- Answers must be exactly as before.
  SELECT string_agg(concat_ws('|', o.id, o.is_proposed_correct, o.is_confirmed_correct, o.marker, o.position, o.label), ',' ORDER BY o.id)
    || '#' || (SELECT string_agg(concat_ws('|', q.id, q.confirmed_by, q.confirmed_at), ',' ORDER BY q.id) FROM public.draft_questions q WHERE q.id = ANY (v_questions))
    INTO v_answers_after FROM public.draft_options o WHERE o.draft_question_id = ANY (v_questions);
  IF v_answers_after IS DISTINCT FROM v_answers_before THEN RAISE EXCEPTION 'KSC_ANSWER_INVARIANT_VIOLATED'; END IF;

  -- NOTATION items of the affected questions: closed only when the stored Draft proves the maths is there.
  FOR v_item IN
    SELECT i.* FROM public.draft_review_items i
    WHERE i.draft_paper_id = p_draft_paper_id AND i.blocking AND i.status IN ('OPEN', 'DEFERRED')
      AND i.item_type IN ('OPTION_SET_ABNORMAL', 'STRUCTURE') AND i.draft_question_id = ANY (v_questions)
      AND i.machine_reasons::TEXT LIKE '%NOTATION_IMAGE_IN_%'
    FOR UPDATE
  LOOP
    SELECT coalesce(array_agg(r), '{}') INTO v_reasons FROM jsonb_array_elements_text(v_item.machine_reasons) r;
    v_other := ARRAY(SELECT r FROM unnest(v_reasons) r WHERE r !~ '^NOTATION_');
    IF EXISTS (SELECT 1 FROM unnest(v_reasons) r WHERE r ~ '^NOTATION_' AND r !~ '^NOTATION_IMAGE_IN_(OPTIONS\([A-D1-4,]+\)|STEM)$') THEN CONTINUE; END IF;
    IF v_item.item_type = 'STRUCTURE' AND cardinality(v_other) > 0 THEN CONTINUE; END IF;
    v_owners := ARRAY(SELECT unnest(string_to_array((regexp_match(r, '^NOTATION_IMAGE_IN_OPTIONS\(([^)]*)\)$'))[1], ',')) FROM unnest(v_reasons) r WHERE r ~ '^NOTATION_IMAGE_IN_OPTIONS')
             || CASE WHEN 'NOTATION_IMAGE_IN_STEM' = ANY (v_reasons) THEN ARRAY['stem'] ELSE '{}'::TEXT[] END;
    -- Every English bitmap of those owners: its latest APPLIED entry belongs to a CURRENT revision whose
    -- value is in the stored text now.
    SELECT bool_and(ok) INTO v_ok FROM (
      SELECT EXISTS (
        SELECT 1 FROM public.draft_math_image_placement_log l
        JOIN public.draft_math_image_resolutions r ON r.id = l.resolution_id AND r.verification_state = 'TEACHER_VERIFIED'
        WHERE l.id = (SELECT max(l2.id) FROM public.draft_math_image_placement_log l2 WHERE l2.draft_paper_id = p_draft_paper_id
                        AND l2.draft_question_id = q.id AND l2.placement_key = (e->>'page') || '@' || (e->'box'->>'x') || ',' || (e->'box'->>'y') AND l2.outcome = 'APPLIED')
          AND strpos(coalesce(CASE WHEN e->>'owner' = 'stem' THEN q.content
                     ELSE (SELECT o.content FROM public.draft_options o WHERE o.draft_question_id = q.id AND o.marker = e->>'owner') END, ''), r.representation) > 0
      ) AS ok
      FROM public.draft_questions q, jsonb_array_elements(q.analysis_regions->'notation') e
      WHERE q.id = v_item.draft_question_id AND e->>'kind' = 'IMAGE' AND e->>'side' = 'en' AND e->>'owner' = ANY (v_owners)
    ) s;
    IF NOT coalesce(v_ok, FALSE) THEN CONTINUE; END IF;
    IF cardinality(v_other) > 0 THEN
      v_probe := v_item; v_probe.machine_reasons := to_jsonb(v_other);
      IF public.ksc_review_item_defect_present(v_probe) IS DISTINCT FROM FALSE THEN CONTINUE; END IF;   -- 0031 must prove the rest gone
    END IF;
    UPDATE public.draft_review_items SET status = 'RESOLVED', resolution = 'RECONCILED', resolved_by = v_uid, resolved_at = NOW(), updated_at = NOW(),
      resolution_note = 'Closed by math recovery: every image named here now carries teacher-verified maths ('
        || array_to_string(v_reasons, ', ') || ').'
    WHERE id = v_item.id;
    v_closed := v_closed + 1;
  END LOOP;

  RETURN jsonb_build_object('resolution_id', v_res.id, 'fingerprint', p_fingerprint, 'revision', v_res.revision, 'reused', v_reused,
    'representation', v_res.representation, 'placements', v_results, 'closedNotationItems', v_closed);
END $$;
REVOKE ALL ON FUNCTION public.ksc_resolve_math_image(UUID, TEXT, TEXT, TEXT, JSONB, TEXT) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.ksc_resolve_math_image(UUID, TEXT, TEXT, TEXT, JSONB, TEXT) TO authenticated;

-- =========================================================================
-- 6. Retry safety = 0027 definition + any math recovery.
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
  ) OR EXISTS (
    SELECT 1 FROM public.draft_math_image_resolutions mr WHERE mr.draft_paper_id = p_draft_paper_id
  );
$$;
REVOKE ALL ON FUNCTION public.ksc_draft_has_teacher_work(UUID) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.ksc_draft_has_teacher_work(UUID) TO authenticated;

COMMIT;
