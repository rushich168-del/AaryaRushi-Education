-- KSC B4 pre-deploy — quarantine legacy-PDF-glyph text in existing draft_materials
-- (NEW guarded forward migration; needs 0022; must run BEFORE 0023 — its name sorts between them)
--
-- Why: the P0 prototype analyzer stored a "Directions:" block's raw PDF text layer as
-- draft_materials.content_text, including the legacy-font Telugu, which is private-use glyph codes
-- (U+E000-U+F8FF), not text. 0026 adds CHECK draft_materials_no_legacy_glyphs, which such rows fail.
--
-- What this does, for ONLY the rows whose content_text matches [U+E000-U+F8FF, U+FFFD]:
--   1. archives the exact original text, every material column, the linked question ids/numbers,
--      per-code-point evidence and a SHA-256 of the UTF-8 text in public.draft_material_legacy_text_archive
--      (immutable; readable only by the owning teacher; no client writes; no anon access);
--   2. clears that row's content_text (NULL) and appends one warning string starting with
--      LEGACY_GLYPH_TEXT_ARCHIVED — nothing else changes: not the id, type, pages, links, media,
--      created_by, created_at or updated_at (the updated_at trigger is paused for this single
--      statement, so the automatic row does not start to look like a teacher edit).
-- It REFUSES (and changes nothing) if any matching row was edited after creation, or was not
-- written by its paper's owner — those need a person's decision, not a migration.
-- Nothing is deleted. No question, option, link, media, language row or teacher work is touched.
-- Idempotent: a second run finds no matching rows and changes nothing.
-- Migrations 0001-0030 are not edited. No Question Bank, snapshot, publish, attempt, evaluation,
-- storage-policy or bucket object is touched.
BEGIN;

DO $$ BEGIN
 IF to_regclass('public.organizations') IS NOT NULL OR to_regprocedure('ksc_private.provision_student()') IS NULL
 THEN RAISE EXCEPTION 'Expected isolated KSC baseline'; END IF;
 IF to_regclass('public.draft_question_texts') IS NULL OR to_regclass('public.draft_materials') IS NULL THEN
  RAISE EXCEPTION 'Missing P0-B3 objects. Ensure 0022 is applied.';
 END IF;
 IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'set_draft_materials_updated_at'
                AND tgrelid = 'public.draft_materials'::regclass AND NOT tgisinternal) THEN
  RAISE EXCEPTION 'KSC_QUARANTINE_PRECONDITION' USING HINT = 'draft_materials updated_at trigger (0017) not found.';
 END IF;
END $$;

-- =========================================================================
-- 1. Archive (immutable record of what was removed from the live row).
-- =========================================================================
CREATE TABLE IF NOT EXISTS public.draft_material_legacy_text_archive (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    draft_material_id UUID NOT NULL,          -- plain copies: the archive never cascades away
    draft_paper_id UUID NOT NULL,
    owner_id UUID NOT NULL,                   -- the paper's owner (draft_papers.created_by)
    source_import_id UUID,
    original_content_text TEXT NOT NULL,
    original_sha256 TEXT NOT NULL CHECK (original_sha256 ~ '^[0-9a-f]{64}$'),
    original_char_count INTEGER NOT NULL,
    private_use_char_count INTEGER NOT NULL,
    replacement_char_count INTEGER NOT NULL,
    telugu_unicode_char_count INTEGER NOT NULL,
    offending_code_points JSONB NOT NULL,     -- [{ "code_point": "U+F0A1", "count": 12 }, ...]
    original_warnings JSONB NOT NULL,
    material_type TEXT,
    language TEXT,
    media_ref TEXT,
    source_page_start INTEGER,
    source_page_end INTEGER,
    extraction_confidence NUMERIC,
    material_created_by UUID,
    material_created_at TIMESTAMPTZ,
    material_updated_at TIMESTAMPTZ,
    linked_question_ids JSONB NOT NULL,
    linked_question_numbers JSONB NOT NULL,
    reason TEXT NOT NULL,
    archived_by_migration TEXT NOT NULL,
    archived_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT draft_material_legacy_text_archive_one_per_material UNIQUE (draft_material_id),
    CONSTRAINT draft_material_legacy_text_archive_sha_matches CHECK (
      original_sha256 = encode(sha256(convert_to(original_content_text, 'UTF8')), 'hex'))
);
CREATE INDEX IF NOT EXISTS idx_draft_material_legacy_text_archive_paper ON public.draft_material_legacy_text_archive(draft_paper_id);

ALTER TABLE public.draft_material_legacy_text_archive ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Teachers read own legacy material text archive" ON public.draft_material_legacy_text_archive;
CREATE POLICY "Teachers read own legacy material text archive" ON public.draft_material_legacy_text_archive
FOR SELECT TO authenticated USING (public.is_teacher() AND owner_id = auth.uid());
REVOKE ALL ON public.draft_material_legacy_text_archive FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.draft_material_legacy_text_archive TO authenticated;

-- Archive rows are write-once: no UPDATE or DELETE, by anyone short of dropping this trigger.
CREATE OR REPLACE FUNCTION public.ksc_guard_material_legacy_archive() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  RAISE EXCEPTION 'KSC_LEGACY_ARCHIVE_IMMUTABLE' USING HINT = 'Archived legacy material text is a permanent record.';
END $$;
REVOKE ALL ON FUNCTION public.ksc_guard_material_legacy_archive() FROM PUBLIC, anon, authenticated, service_role;
DROP TRIGGER IF EXISTS guard_material_legacy_archive ON public.draft_material_legacy_text_archive;
CREATE TRIGGER guard_material_legacy_archive BEFORE UPDATE OR DELETE ON public.draft_material_legacy_text_archive
FOR EACH ROW EXECUTE FUNCTION public.ksc_guard_material_legacy_archive();

-- =========================================================================
-- 2. Refuse anything that is not untouched automatic extraction.
-- =========================================================================
DO $$
DECLARE v_bad TEXT;
BEGIN
  SELECT string_agg(m.id::text, ', ') INTO v_bad
  FROM public.draft_materials m JOIN public.draft_papers p ON p.id = m.draft_paper_id
  WHERE m.content_text ~ '[-�]'
    AND (m.updated_at IS DISTINCT FROM m.created_at OR m.created_by IS DISTINCT FROM p.created_by);
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'KSC_QUARANTINE_REFUSED: legacy-glyph material(s) % were edited after creation or not written by the paper owner', v_bad
      USING HINT = 'Nothing was changed. These rows need a manual decision.';
  END IF;
END $$;

-- =========================================================================
-- 3. Archive, then clear only the offending value (updated_at preserved), then prove it.
-- =========================================================================
DO $$
DECLARE
  v_marker CONSTANT TEXT := 'LEGACY_GLYPH_TEXT_ARCHIVED';
  v_migration CONSTANT TEXT := '202609222350_draft_material_legacy_glyph_quarantine';
  v_targets UUID[];
  v_n INT;
  v_bad INT;
BEGIN
  SELECT coalesce(array_agg(id ORDER BY id), ARRAY[]::UUID[]) INTO v_targets
  FROM public.draft_materials WHERE content_text ~ '[-�]';
  IF cardinality(v_targets) = 0 THEN RETURN; END IF;   -- nothing (left) to quarantine

  INSERT INTO public.draft_material_legacy_text_archive (
      draft_material_id, draft_paper_id, owner_id, source_import_id,
      original_content_text, original_sha256, original_char_count, private_use_char_count,
      replacement_char_count, telugu_unicode_char_count, offending_code_points, original_warnings,
      material_type, language, media_ref, source_page_start, source_page_end, extraction_confidence,
      material_created_by, material_created_at, material_updated_at,
      linked_question_ids, linked_question_numbers, reason, archived_by_migration)
  SELECT m.id, m.draft_paper_id, p.created_by, p.source_import_id,
      m.content_text, encode(sha256(convert_to(m.content_text, 'UTF8')), 'hex'), length(m.content_text),
      length(m.content_text) - length(regexp_replace(m.content_text, '[-]', '', 'g')),
      length(m.content_text) - length(regexp_replace(m.content_text, '�', '', 'g')),
      length(m.content_text) - length(regexp_replace(m.content_text, '[ఀ-౿]', '', 'g')),
      (SELECT coalesce(jsonb_agg(jsonb_build_object('code_point', 'U+' || upper(lpad(to_hex(cp), 4, '0')), 'count', n) ORDER BY cp), '[]'::jsonb)
         FROM (SELECT ascii(r.m[1]) AS cp, count(*) AS n FROM regexp_matches(m.content_text, '[-�]', 'g') AS r(m) GROUP BY 1) s),
      coalesce(m.warnings, '[]'::jsonb),
      m.material_type, m.language, m.media_ref, m.source_page_start, m.source_page_end, m.extraction_confidence,
      m.created_by, m.created_at, m.updated_at,
      (SELECT coalesce(jsonb_agg(q.id ORDER BY q.position, q.id), '[]'::jsonb) FROM public.draft_questions q WHERE q.shared_material_id = m.id),
      (SELECT coalesce(jsonb_agg(q.source_question_number ORDER BY q.position, q.id), '[]'::jsonb) FROM public.draft_questions q WHERE q.shared_material_id = m.id),
      'Legacy PDF glyph codes (private-use characters, not text) stored by the P0 prototype analyzer; blocks 0026 draft_materials_no_legacy_glyphs.',
      v_migration
  FROM public.draft_materials m JOIN public.draft_papers p ON p.id = m.draft_paper_id
  WHERE m.id = ANY (v_targets);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n <> cardinality(v_targets) THEN RAISE EXCEPTION 'KSC_QUARANTINE_ARCHIVE_INCOMPLETE'; END IF;

  -- Only content_text and warnings change; the updated_at trigger is paused for this statement.
  ALTER TABLE public.draft_materials DISABLE TRIGGER set_draft_materials_updated_at;
  UPDATE public.draft_materials m
  SET content_text = NULL,
      warnings = coalesce(m.warnings, '[]'::jsonb) || jsonb_build_array(
        v_marker || ': the original text held ' || a.private_use_char_count || ' legacy PDF glyph code(s) (no Unicode Telugu) and was moved unchanged to '
        || 'draft_material_legacy_text_archive ' || a.id || ' (sha256 ' || a.original_sha256 || ') by migration ' || v_migration || '.')
  FROM public.draft_material_legacy_text_archive a
  WHERE a.draft_material_id = m.id AND m.id = ANY (v_targets);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  ALTER TABLE public.draft_materials ENABLE TRIGGER set_draft_materials_updated_at;
  IF v_n <> cardinality(v_targets) THEN RAISE EXCEPTION 'KSC_QUARANTINE_UPDATE_INCOMPLETE'; END IF;

  -- Post-conditions: every other column is exactly as archived; no offending text remains.
  SELECT count(*) INTO v_bad
  FROM public.draft_materials m JOIN public.draft_material_legacy_text_archive a ON a.draft_material_id = m.id
  WHERE m.id = ANY (v_targets) AND NOT (
        m.content_text IS NULL
    AND m.updated_at IS NOT DISTINCT FROM a.material_updated_at AND m.created_at IS NOT DISTINCT FROM a.material_created_at
    AND m.created_by IS NOT DISTINCT FROM a.material_created_by AND m.draft_paper_id = a.draft_paper_id
    AND m.material_type IS NOT DISTINCT FROM a.material_type AND m.language IS NOT DISTINCT FROM a.language
    AND m.media_ref IS NOT DISTINCT FROM a.media_ref AND m.source_page_start IS NOT DISTINCT FROM a.source_page_start
    AND m.source_page_end IS NOT DISTINCT FROM a.source_page_end AND m.extraction_confidence IS NOT DISTINCT FROM a.extraction_confidence
    AND m.warnings = a.original_warnings || jsonb_build_array(m.warnings -> -1)
    AND (m.warnings ->> -1) LIKE v_marker || ':%'
    AND (SELECT coalesce(jsonb_agg(q.id ORDER BY q.position, q.id), '[]'::jsonb) FROM public.draft_questions q WHERE q.shared_material_id = m.id) = a.linked_question_ids);
  IF v_bad > 0 THEN RAISE EXCEPTION 'KSC_QUARANTINE_POSTCONDITION_FAILED: % row(s)', v_bad; END IF;
  IF EXISTS (SELECT 1 FROM public.draft_materials WHERE content_text ~ '[-�]') THEN
    RAISE EXCEPTION 'KSC_QUARANTINE_POSTCONDITION_FAILED: legacy glyph text remains';
  END IF;
END $$;

COMMIT;
