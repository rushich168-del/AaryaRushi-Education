-- KSC P0-B2 — Source-faithful Draft visual preservation (NEW guarded forward migration)
--
-- Adds draft_media: one teacher-captured visual (an immutable PNG crop of the original
-- source PDF plus its normalized source region) owned by exactly ONE of:
--   a draft question, a draft option, or a draft (shared) material.
-- Redefines ksc_draft_has_teacher_work (from 0018) so that any draft_media row counts as
-- teacher work, which makes ksc_replace_draft_analysis refuse Retry over it.
--
-- SAFETY: additive only. Migrations 0001-0018 are not edited. No Question Bank, snapshot,
-- publish, attempt, evaluation, legacy candidate, or storage-policy object is touched.
-- The existing private bucket and its teacher-owner path policy (0014) are reused as-is.
BEGIN;

DO $$ BEGIN
 IF to_regclass('public.organizations') IS NOT NULL OR to_regprocedure('ksc_private.provision_student()') IS NULL
 THEN RAISE EXCEPTION 'Expected isolated KSC baseline'; END IF;
 IF to_regprocedure('public.is_teacher()') IS NULL THEN
  RAISE EXCEPTION 'Missing is_teacher function';
 END IF;
 IF to_regprocedure('public.ksc_draft_has_teacher_work(uuid)') IS NULL
    OR to_regprocedure('public.ksc_insert_draft_question(uuid,integer,text,text,text)') IS NULL THEN
  RAISE EXCEPTION 'Missing P0-B1 objects. Ensure 0018 is applied.';
 END IF;
 IF to_regprocedure('public.ksc_touch_test_import_updated_at()') IS NULL THEN
  RAISE EXCEPTION 'Missing updated_at helper from 0014.';
 END IF;
END $$;

-- =========================================================================
-- 1. draft_media
--    Region contract: normalized to the source page, top-left origin, 0..1,
--    independent of any display/render scale. The PNG is the immutable crop.
--    storage_path is a stable private object path, never a (signed) URL.
-- =========================================================================
CREATE TABLE IF NOT EXISTS public.draft_media (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    draft_paper_id UUID NOT NULL REFERENCES public.draft_papers(id) ON DELETE CASCADE,
    draft_question_id UUID REFERENCES public.draft_questions(id) ON DELETE CASCADE,
    draft_option_id UUID REFERENCES public.draft_options(id) ON DELETE CASCADE,
    draft_material_id UUID REFERENCES public.draft_materials(id) ON DELETE CASCADE,
    position INTEGER NOT NULL DEFAULT 0,
    media_kind TEXT NOT NULL
        CHECK (media_kind IN ('DIAGRAM','FIGURE','IMAGE','TABLE','CHART','MAP','TEXT_REGION','OTHER')),
    capture_method TEXT NOT NULL DEFAULT 'SOURCE_REGION'
        CHECK (capture_method IN ('SOURCE_REGION','TEACHER_UPLOAD')),
    storage_bucket TEXT NOT NULL DEFAULT 'ksc-source-documents'
        CHECK (storage_bucket = 'ksc-source-documents'),
    storage_path TEXT NOT NULL,
    mime_type TEXT NOT NULL DEFAULT 'image/png',
    width_px INTEGER CHECK (width_px IS NULL OR width_px > 0),
    height_px INTEGER CHECK (height_px IS NULL OR height_px > 0),
    source_import_id UUID REFERENCES public.test_imports(id) ON DELETE SET NULL,
    source_page INTEGER CHECK (source_page IS NULL OR source_page >= 1),
    region_x NUMERIC,
    region_y NUMERIC,
    region_w NUMERIC,
    region_h NUMERIC,
    page_width_pt NUMERIC CHECK (page_width_pt IS NULL OR page_width_pt > 0),
    page_height_pt NUMERIC CHECK (page_height_pt IS NULL OR page_height_pt > 0),
    render_scale NUMERIC CHECK (render_scale IS NULL OR render_scale > 0),
    caption TEXT,                    -- teacher-entered only; never generated
    warnings JSONB NOT NULL DEFAULT '[]'::jsonb,
    created_by UUID NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT DEFAULT auth.uid(),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),

    -- Exactly one owner.
    CONSTRAINT draft_media_exactly_one_owner
        CHECK (num_nonnulls(draft_question_id, draft_option_id, draft_material_id) = 1),
    -- Region is all-or-nothing and lies inside the page with positive area.
    CONSTRAINT draft_media_region_valid CHECK (
        (region_x IS NULL AND region_y IS NULL AND region_w IS NULL AND region_h IS NULL)
        OR (region_x >= 0 AND region_y >= 0 AND region_w > 0 AND region_h > 0
            AND region_x + region_w <= 1 AND region_y + region_h <= 1)
    ),
    -- A source-region capture must carry its provenance.
    CONSTRAINT draft_media_source_region_provenance CHECK (
        capture_method <> 'SOURCE_REGION'
        OR (source_page IS NOT NULL AND region_x IS NOT NULL
            AND page_width_pt IS NOT NULL AND page_height_pt IS NOT NULL)
    ),
    -- Stable private object path in the Draft media namespace; never a URL.
    CONSTRAINT draft_media_storage_path_shape CHECK (
        storage_path ~ '^imports/[0-9a-fA-F-]{36}/draft-media/[0-9a-fA-F-]{36}/[0-9a-fA-F-]{36}\.png$'
    )
);
CREATE INDEX IF NOT EXISTS idx_draft_media_paper    ON public.draft_media(draft_paper_id);
CREATE INDEX IF NOT EXISTS idx_draft_media_question ON public.draft_media(draft_question_id);
CREATE INDEX IF NOT EXISTS idx_draft_media_option   ON public.draft_media(draft_option_id);
CREATE INDEX IF NOT EXISTS idx_draft_media_material ON public.draft_media(draft_material_id);

-- =========================================================================
-- 2. Integrity guard (independent of RLS): the owner must belong to the SAME draft
--    paper. Also records the paper's source import when not supplied.
-- =========================================================================
CREATE OR REPLACE FUNCTION public.ksc_guard_draft_media_owner() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
    v_owner_paper UUID;
BEGIN
    -- Owner count is reported precisely by draft_media_exactly_one_owner.
    IF num_nonnulls(NEW.draft_question_id, NEW.draft_option_id, NEW.draft_material_id) <> 1 THEN
        RETURN NEW;
    END IF;

    IF NEW.draft_question_id IS NOT NULL THEN
        SELECT draft_paper_id INTO v_owner_paper FROM public.draft_questions WHERE id = NEW.draft_question_id;
    ELSIF NEW.draft_option_id IS NOT NULL THEN
        SELECT q.draft_paper_id INTO v_owner_paper
        FROM public.draft_options o JOIN public.draft_questions q ON q.id = o.draft_question_id
        WHERE o.id = NEW.draft_option_id;
    ELSIF NEW.draft_material_id IS NOT NULL THEN
        SELECT draft_paper_id INTO v_owner_paper FROM public.draft_materials WHERE id = NEW.draft_material_id;
    END IF;

    IF v_owner_paper IS DISTINCT FROM NEW.draft_paper_id THEN
        RAISE EXCEPTION 'Media owner must belong to the same draft paper';
    END IF;

    IF NEW.source_import_id IS NULL THEN
        SELECT source_import_id INTO NEW.source_import_id FROM public.draft_papers WHERE id = NEW.draft_paper_id;
    END IF;
    RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.ksc_guard_draft_media_owner() FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS guard_draft_media_owner ON public.draft_media;
CREATE TRIGGER guard_draft_media_owner BEFORE INSERT OR UPDATE ON public.draft_media
FOR EACH ROW EXECUTE FUNCTION public.ksc_guard_draft_media_owner();

DROP TRIGGER IF EXISTS set_draft_media_updated_at ON public.draft_media;
CREATE TRIGGER set_draft_media_updated_at BEFORE UPDATE ON public.draft_media
FOR EACH ROW EXECUTE FUNCTION public.ksc_touch_test_import_updated_at();

-- =========================================================================
-- 3. RLS — teacher + paper owner (0017 pattern). The storage path must sit in the
--    caller's own Draft media namespace for this paper. No student/anon access.
-- =========================================================================
ALTER TABLE public.draft_media ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Teachers manage own draft media" ON public.draft_media;
CREATE POLICY "Teachers manage own draft media" ON public.draft_media FOR ALL
TO authenticated
USING (public.is_teacher() AND EXISTS (
  SELECT 1 FROM public.draft_papers p WHERE p.id = draft_media.draft_paper_id AND p.created_by = auth.uid()))
WITH CHECK (public.is_teacher()
  AND EXISTS (SELECT 1 FROM public.draft_papers p WHERE p.id = draft_media.draft_paper_id AND p.created_by = auth.uid())
  AND draft_media.storage_path LIKE 'imports/' || auth.uid()::text || '/draft-media/' || draft_media.draft_paper_id::text || '/%');

REVOKE ALL ON public.draft_media FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.draft_media TO authenticated;

-- =========================================================================
-- 4. Retry safety: any attached visual is teacher work. Otherwise identical to 0018.
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
  );
$$;
REVOKE ALL ON FUNCTION public.ksc_draft_has_teacher_work(UUID) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.ksc_draft_has_teacher_work(UUID) TO authenticated;

COMMIT;
