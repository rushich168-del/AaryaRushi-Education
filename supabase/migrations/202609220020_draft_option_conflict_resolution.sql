-- KSC Draft options — explicit option-slot conflict resolution (NEW guarded forward migration)
--
-- A "slot conflict" is more than one draft_options row at the same (question, position).
-- Nothing here chooses between competing rows automatically. The teacher reviews every
-- competing row and explicitly picks the one to keep via ksc_resolve_option_slot_conflict.
-- Uniqueness (one row per position) is enforced separately by 0021, applied only after
-- all conflicts are resolved.
--
-- Also adds ksc_remove_draft_option (the only way to delete an option; it refuses the
-- confirmed answer, options with visuals, and conflicting slots) and revokes direct client
-- DELETE on draft_options so an ordinary Save can never delete option rows.
--
-- SAFETY: additive only. Migrations 0001-0019 are not edited. Question-owned media is never
-- read or written. No Question Bank, snapshot, publish, attempt, evaluation, legacy
-- candidate or storage object is touched. No constraint is added here.
BEGIN;

DO $$ BEGIN
 IF to_regclass('public.organizations') IS NOT NULL OR to_regprocedure('ksc_private.provision_student()') IS NULL
 THEN RAISE EXCEPTION 'Expected isolated KSC baseline'; END IF;
 IF to_regprocedure('public.is_teacher()') IS NULL THEN
  RAISE EXCEPTION 'Missing is_teacher function';
 END IF;
 IF to_regclass('public.draft_media') IS NULL OR to_regprocedure('public.ksc_draft_has_teacher_work(uuid)') IS NULL THEN
  RAISE EXCEPTION 'Missing P0-B2 objects. Ensure 0019 is applied.';
 END IF;
END $$;

-- =========================================================================
-- 1. Private audit of every removed option row (full original row). No client access.
-- =========================================================================
CREATE TABLE IF NOT EXISTS ksc_private.draft_option_repair_log (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    repaired_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    draft_question_id UUID NOT NULL,
    position INTEGER NOT NULL,
    kept_option_id UUID NOT NULL,
    removed_option JSONB NOT NULL,
    rule TEXT NOT NULL,
    resolved_by UUID            -- teacher who resolved it; NULL when repaired by a migration
);
REVOKE ALL ON ksc_private.draft_option_repair_log FROM PUBLIC, anon, authenticated, service_role;

-- =========================================================================
-- 2. Teacher-approved resolution of ONE conflicting slot.
--    p_expected_option_ids = exactly the rows the teacher reviewed (stale view -> refused).
--    p_keep_option_id      = the teacher's explicit choice (no origin/age preference).
--    State safeguards for every discarded row:
--      - confirmed answer on a discarded row (keeper not confirmed) -> refused
--      - proposed flag on a discarded row -> moved to the keeper (proposals are per slot),
--        recorded as a warning on the keeper
--      - visual on a discarded row -> refused unless p_move_visual and the keeper has none;
--        then moved to the keeper. Visuals on both -> refused.
--      - warnings merged into the keeper; label copied only if the keeper has none
--    Every discarded row is logged in full, then deleted.
-- =========================================================================
CREATE OR REPLACE FUNCTION public.ksc_resolve_option_slot_conflict(
    p_question_id UUID,
    p_position INTEGER,
    p_keep_option_id UUID,
    p_expected_option_ids UUID[],
    p_move_visual BOOLEAN DEFAULT false
) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
    v_ids UUID[];
    v_expected UUID[];
    v_keep RECORD;
    v_lose RECORD;
    v_keep_media INTEGER;
    v_removed INTEGER := 0;
    v_moved INTEGER := 0;
    v_moved_now INTEGER;
    v_proposed_moved BOOLEAN := false;
    v_warnings JSONB;
    v_label TEXT;
BEGIN
    IF auth.uid() IS NULL OR NOT public.is_teacher() THEN
        RAISE EXCEPTION 'Teacher access required';
    END IF;

    PERFORM 1 FROM public.draft_questions q
    JOIN public.draft_papers p ON p.id = q.draft_paper_id
    WHERE q.id = p_question_id AND p.created_by = auth.uid()
    FOR UPDATE OF q;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Draft question not found or unauthorized';
    END IF;

    SELECT array_agg(id ORDER BY id) INTO v_ids FROM (
        SELECT id FROM public.draft_options
        WHERE draft_question_id = p_question_id AND position = p_position
        FOR UPDATE
    ) s;
    IF v_ids IS NULL OR cardinality(v_ids) < 2 THEN
        RAISE EXCEPTION 'KSC_NO_CONFLICT_AT_SLOT' USING HINT = 'This option slot has no competing rows.';
    END IF;

    SELECT array_agg(x ORDER BY x) INTO v_expected FROM (SELECT DISTINCT unnest(p_expected_option_ids) AS x) e;
    IF v_expected IS DISTINCT FROM v_ids OR p_keep_option_id IS NULL OR NOT (p_keep_option_id = ANY (v_ids)) THEN
        RAISE EXCEPTION 'KSC_CONFLICT_CHANGED' USING HINT = 'The competing options changed. Reload and review again.';
    END IF;

    SELECT * INTO v_keep FROM public.draft_options WHERE id = p_keep_option_id;
    SELECT count(*) INTO v_keep_media FROM public.draft_media WHERE draft_option_id = p_keep_option_id;

    -- Validate every discarded row before changing anything.
    FOR v_lose IN
        SELECT o.id, o.is_confirmed_correct,
               (SELECT count(*) FROM public.draft_media m WHERE m.draft_option_id = o.id) AS media_count
        FROM public.draft_options o
        WHERE o.draft_question_id = p_question_id AND o.position = p_position AND o.id <> p_keep_option_id
    LOOP
        IF v_lose.is_confirmed_correct AND NOT v_keep.is_confirmed_correct THEN
            RAISE EXCEPTION 'KSC_CONFLICT_CONFIRMED_ON_DISCARDED_ROW'
              USING HINT = 'Keep the confirmed option, or unconfirm the answer first.';
        END IF;
        IF v_lose.media_count > 0 THEN
            IF v_keep_media > 0 THEN
                RAISE EXCEPTION 'KSC_CONFLICT_VISUAL_ON_BOTH_ROWS'
                  USING HINT = 'Both options have visuals. Remove one visual first.';
            END IF;
            IF NOT p_move_visual THEN
                RAISE EXCEPTION 'KSC_CONFLICT_VISUAL_ON_DISCARDED_ROW'
                  USING HINT = 'Choose to move the visual to the kept option, or keep the option that has it.';
            END IF;
        END IF;
    END LOOP;

    v_warnings := coalesce(v_keep.warnings, '[]'::jsonb);
    v_label := v_keep.label;

    FOR v_lose IN
        SELECT o.* FROM public.draft_options o
        WHERE o.draft_question_id = p_question_id AND o.position = p_position AND o.id <> p_keep_option_id
    LOOP
        INSERT INTO ksc_private.draft_option_repair_log
            (draft_question_id, position, kept_option_id, removed_option, rule, resolved_by)
        VALUES (p_question_id, p_position, p_keep_option_id, to_jsonb(v_lose), 'TEACHER_RESOLVED_CONFLICT', auth.uid());

        UPDATE public.draft_media SET draft_option_id = p_keep_option_id WHERE draft_option_id = v_lose.id;
        GET DIAGNOSTICS v_moved_now = ROW_COUNT;
        v_moved := v_moved + v_moved_now;

        IF v_lose.is_proposed_correct AND NOT v_keep.is_proposed_correct THEN
            v_proposed_moved := true;
        END IF;
        SELECT coalesce(jsonb_agg(DISTINCT w), '[]'::jsonb) INTO v_warnings
        FROM (SELECT jsonb_array_elements(v_warnings) AS w
              UNION SELECT jsonb_array_elements(coalesce(v_lose.warnings, '[]'::jsonb))) u;
        IF v_label IS NULL THEN v_label := v_lose.label; END IF;

        DELETE FROM public.draft_options WHERE id = v_lose.id;
        v_removed := v_removed + 1;
    END LOOP;

    IF v_proposed_moved THEN
        v_warnings := v_warnings || '["PROPOSED_FLAG_MOVED_FROM_RESOLVED_DUPLICATE"]'::jsonb;
    END IF;

    UPDATE public.draft_options
    SET is_proposed_correct = is_proposed_correct OR v_proposed_moved,
        warnings = v_warnings,
        label = v_label
    WHERE id = p_keep_option_id;

    UPDATE public.draft_questions
    SET teacher_review_status = CASE WHEN teacher_review_status = 'CONFIRMED' THEN 'CONFIRMED' ELSE 'EDITED' END
    WHERE id = p_question_id;

    RETURN jsonb_build_object('removed', v_removed, 'moved_visuals', v_moved, 'proposed_moved', v_proposed_moved,
                              'kept_option_id', p_keep_option_id);
END;
$$;
REVOKE ALL ON FUNCTION public.ksc_resolve_option_slot_conflict(UUID, INTEGER, UUID, UUID[], BOOLEAN) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.ksc_resolve_option_slot_conflict(UUID, INTEGER, UUID, UUID[], BOOLEAN) TO authenticated;

-- =========================================================================
-- 3. Explicit, guarded option removal. Ordinary Save can no longer delete options.
-- =========================================================================
CREATE OR REPLACE FUNCTION public.ksc_remove_draft_option(p_option_id UUID)
RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
    v_opt RECORD;
BEGIN
    IF auth.uid() IS NULL OR NOT public.is_teacher() THEN
        RAISE EXCEPTION 'Teacher access required';
    END IF;

    SELECT o.id, o.draft_question_id, o.position, o.is_confirmed_correct INTO v_opt
    FROM public.draft_options o
    JOIN public.draft_questions q ON q.id = o.draft_question_id
    JOIN public.draft_papers p ON p.id = q.draft_paper_id
    WHERE o.id = p_option_id AND p.created_by = auth.uid()
    FOR UPDATE OF o;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Draft option not found or unauthorized';
    END IF;

    IF EXISTS (SELECT 1 FROM public.draft_options
               WHERE draft_question_id = v_opt.draft_question_id AND position = v_opt.position AND id <> v_opt.id) THEN
        RAISE EXCEPTION 'KSC_OPTION_SLOT_CONFLICT' USING HINT = 'Resolve the option conflict for this slot first.';
    END IF;
    IF v_opt.is_confirmed_correct THEN
        RAISE EXCEPTION 'KSC_OPTION_IS_CONFIRMED' USING HINT = 'Unconfirm the answer before removing this option.';
    END IF;
    IF EXISTS (SELECT 1 FROM public.draft_media m WHERE m.draft_option_id = p_option_id) THEN
        RAISE EXCEPTION 'KSC_OPTION_HAS_MEDIA' USING HINT = 'Remove the visual attached to this option first.';
    END IF;

    DELETE FROM public.draft_options WHERE id = p_option_id;
    UPDATE public.draft_questions
    SET teacher_review_status = CASE WHEN teacher_review_status = 'CONFIRMED' THEN 'CONFIRMED' ELSE 'EDITED' END
    WHERE id = v_opt.draft_question_id;
    RETURN TRUE;
END;
$$;
REVOKE ALL ON FUNCTION public.ksc_remove_draft_option(UUID) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.ksc_remove_draft_option(UUID) TO authenticated;

-- Teachers keep SELECT/INSERT/UPDATE on their options (RLS unchanged); DELETE only via RPCs.
REVOKE DELETE ON public.draft_options FROM authenticated;

COMMIT;
