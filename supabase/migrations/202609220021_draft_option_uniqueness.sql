-- KSC Draft options — one-row-per-position invariant (NEW guarded forward migration).
-- Apply ONLY after every duplicate option slot has been resolved by the teacher with
-- ksc_resolve_option_slot_conflict (0020) and verified after F5.
--
-- 1. Removes any remaining duplicate draft_options rows ONLY when every removal is
--    provably safe (rules below). If any duplicate group is unsafe/ambiguous, the
--    migration FAILS with a report and changes nothing. Removed rows are copied in full
--    to ksc_private.draft_option_repair_log (created by 0020).
-- 2. Enforces UNIQUE (draft_question_id, position). The migration never succeeds without
--    this invariant, so every installation ends with the same schema.
--
-- SAFETY: additive only. Migrations 0001-0020 are not edited. No Question Bank, snapshot,
-- publish, attempt, evaluation, legacy candidate or storage object is touched.
BEGIN;

DO $$ BEGIN
 IF to_regclass('public.organizations') IS NOT NULL OR to_regprocedure('ksc_private.provision_student()') IS NULL
 THEN RAISE EXCEPTION 'Expected isolated KSC baseline'; END IF;
 IF to_regclass('ksc_private.draft_option_repair_log') IS NULL
    OR to_regprocedure('public.ksc_resolve_option_slot_conflict(uuid,integer,uuid,uuid[],boolean)') IS NULL THEN
  RAISE EXCEPTION 'Missing option conflict-resolution objects. Ensure 0020 is applied.';
 END IF;
END $$;

-- =========================================================================
-- 1. Safe duplicate repair (unchanged rules).
--    Keeper per (question, position): the confirmed row if any, else the row with a
--    visual, else the proposed row, else the earliest. Every OTHER row in the group
--    may be removed only if it:
--      - has the same normalized content (trimmed, whitespace collapsed) as the keeper
--      - is TEACHER-origin
--      - is not confirmed correct
--      - has no draft_media and no media_ref
--      - is not proposed-correct unless the keeper is too
--      - has the same label and warnings as the keeper
--    Otherwise the whole migration fails and nothing is changed.
-- =========================================================================
DO $$
DECLARE
    v_unsafe TEXT;
    v_removed INTEGER;
BEGIN
    IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'draft_options_one_row_per_position') THEN
        RETURN; -- already repaired and enforced
    END IF;

    CREATE TEMP TABLE _ksc_dup_rows ON COMMIT DROP AS
    WITH rows AS (
        SELECT o.id, o.draft_question_id, o.position, o.origin, o.label, o.media_ref, o.warnings,
               o.is_proposed_correct, o.is_confirmed_correct, o.created_at,
               regexp_replace(btrim(coalesce(o.content, '')), '\s+', ' ', 'g') AS norm,
               EXISTS (SELECT 1 FROM public.draft_media m WHERE m.draft_option_id = o.id) AS has_media,
               count(*) OVER (PARTITION BY o.draft_question_id, o.position) AS group_size
        FROM public.draft_options o
    ), dups AS (
        SELECT * FROM rows WHERE group_size > 1
    ), keepers AS (
        SELECT DISTINCT ON (draft_question_id, position) draft_question_id, position, id AS keeper_id
        FROM dups
        ORDER BY draft_question_id, position,
                 is_confirmed_correct DESC, has_media DESC, is_proposed_correct DESC, created_at ASC, id ASC
    )
    SELECT d.*, k.keeper_id
    FROM dups d JOIN keepers k USING (draft_question_id, position);

    SELECT string_agg(format('question %s position %s option %s: %s',
               r.draft_question_id, r.position, r.id, array_to_string(ARRAY[
                   CASE WHEN r.norm <> k.norm THEN 'content differs' END,
                   CASE WHEN r.origin <> 'TEACHER' THEN 'not teacher-origin' END,
                   CASE WHEN r.is_confirmed_correct THEN 'is confirmed correct' END,
                   CASE WHEN r.has_media OR r.media_ref IS NOT NULL THEN 'has an attached visual' END,
                   CASE WHEN r.is_proposed_correct AND NOT k.is_proposed_correct THEN 'only copy marked proposed' END,
                   CASE WHEN r.label IS DISTINCT FROM k.label THEN 'label differs' END,
                   CASE WHEN r.warnings IS DISTINCT FROM k.warnings THEN 'warnings differ' END
               ], ', ')), E'\n')
    INTO v_unsafe
    FROM _ksc_dup_rows r
    JOIN _ksc_dup_rows k ON k.id = r.keeper_id
    WHERE r.id <> r.keeper_id
      AND (r.norm <> k.norm OR r.origin <> 'TEACHER' OR r.is_confirmed_correct
           OR r.has_media OR r.media_ref IS NOT NULL
           OR (r.is_proposed_correct AND NOT k.is_proposed_correct)
           OR r.label IS DISTINCT FROM k.label OR r.warnings IS DISTINCT FROM k.warnings);

    IF v_unsafe IS NOT NULL THEN
        RAISE EXCEPTION USING
            MESSAGE = 'KSC_UNSAFE_DUPLICATE_OPTIONS: duplicate option slots need teacher review. No rows were changed.',
            DETAIL = v_unsafe,
            HINT = 'Resolve these option slots in the Preparation Workspace, then apply this migration again.';
    END IF;

    INSERT INTO ksc_private.draft_option_repair_log (draft_question_id, position, kept_option_id, removed_option, rule)
    SELECT r.draft_question_id, r.position, r.keeper_id, to_jsonb(o), 'IDENTICAL_TEACHER_DUPLICATE'
    FROM _ksc_dup_rows r JOIN public.draft_options o ON o.id = r.id
    WHERE r.id <> r.keeper_id;

    DELETE FROM public.draft_options o
    USING _ksc_dup_rows r
    WHERE o.id = r.id AND r.id <> r.keeper_id;
    GET DIAGNOSTICS v_removed = ROW_COUNT;
    RAISE NOTICE 'KSC draft option repair: removed % identical duplicate row(s); see ksc_private.draft_option_repair_log.', v_removed;
END $$;

-- =========================================================================
-- 2. The invariant. If duplicates somehow remain, this fails and rolls back.
-- =========================================================================
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'draft_options_one_row_per_position') THEN
  ALTER TABLE public.draft_options
   ADD CONSTRAINT draft_options_one_row_per_position UNIQUE (draft_question_id, position);
 END IF;
END $$;

COMMIT;
