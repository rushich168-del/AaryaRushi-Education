-- KSC B4 pre-deploy fix — restore draft_media_source_region_provenance (NEW guarded forward migration; needs 0023)
--
-- 0023 widened draft_media's capture_method CHECK by dropping every CHECK constraint whose
-- definition mentions capture_method. That also dropped 0019's
--   draft_media_source_region_provenance: a SOURCE_REGION capture must carry its source page,
--   region and page size,
-- which 0023 never re-added. Nothing relied on its absence: every writer that creates
-- SOURCE_REGION rows (the teacher's region capture) already supplies that provenance, and the
-- automatic writers create AUTO_REGION rows only (guarded separately by 0024).
-- This restores the constraint exactly as 0019 defined it. Existing rows were created while it
-- was in force (or by the region-capture path that satisfies it), so validation succeeds; if any
-- row did not, this migration fails and rolls back as a whole without changing anything.
--
-- Migrations 0001-0029 are not edited. No data is modified. No Question Bank, snapshot, publish,
-- attempt, evaluation, storage-policy or bucket object is touched.
BEGIN;

DO $$ BEGIN
 IF to_regclass('public.organizations') IS NOT NULL OR to_regprocedure('ksc_private.provision_student()') IS NULL
 THEN RAISE EXCEPTION 'Expected isolated KSC baseline'; END IF;
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'draft_media_capture_method_v2') THEN
  RAISE EXCEPTION 'Missing AUTO_REGION capture method. Ensure 0023 is applied.';
 END IF;
END $$;

DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint
                WHERE conrelid = 'public.draft_media'::regclass AND conname = 'draft_media_source_region_provenance') THEN
  ALTER TABLE public.draft_media ADD CONSTRAINT draft_media_source_region_provenance CHECK (
    capture_method <> 'SOURCE_REGION'
    OR (source_page IS NOT NULL AND region_x IS NOT NULL
        AND page_width_pt IS NOT NULL AND page_height_pt IS NOT NULL)
  );
 END IF;
END $$;

COMMIT;
