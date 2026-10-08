BEGIN;

-- Forward update for the installed KSC baseline
DO $$ BEGIN
 IF to_regclass('public.organizations') IS NOT NULL OR to_regprocedure('ksc_private.provision_student()') IS NULL
 THEN RAISE EXCEPTION 'Expected isolated KSC baseline'; END IF;
 IF to_regclass('public.test_imports') IS NULL THEN
  RAISE EXCEPTION 'Missing test_imports table. Ensure 0014 is applied.';
 END IF;
END $$;

-- 1. Shared Materials (Passages, Charts, Tables)
CREATE TABLE IF NOT EXISTS public.test_import_materials (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    import_id UUID NOT NULL REFERENCES public.test_imports(id) ON DELETE CASCADE,
    material_type TEXT NOT NULL CHECK(material_type IN ('PASSAGE', 'CHART', 'TABLE', 'DIAGRAM', 'OTHER')),
    content_text TEXT,
    source_page INTEGER,
    created_by UUID NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT DEFAULT auth.uid(),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (id, import_id)
);

-- 2. Question Candidates
CREATE TABLE IF NOT EXISTS public.test_import_candidates (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    import_id UUID NOT NULL REFERENCES public.test_imports(id) ON DELETE CASCADE,
    material_id UUID,
    question_number TEXT,
    question_text TEXT,
    options JSONB DEFAULT '[]'::jsonb,
    proposed_correct_index INTEGER CHECK(proposed_correct_index IS NULL OR (proposed_correct_index >= 0 AND proposed_correct_index <= 3)),
    source_page INTEGER,
    status TEXT NOT NULL DEFAULT 'NEEDS_REVIEW' CHECK(status IN ('READY', 'NEEDS_REVIEW', 'UNRESOLVED', 'FAILED', 'APPROVED')),
    warnings JSONB DEFAULT '[]'::jsonb,
    created_by UUID NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT DEFAULT auth.uid(),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    FOREIGN KEY (material_id, import_id) REFERENCES public.test_import_materials(id, import_id)
);

-- RLS & Security
ALTER TABLE public.test_import_materials ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.test_import_candidates ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Teachers manage own import materials" ON public.test_import_materials;
CREATE POLICY "Teachers manage own import materials" ON public.test_import_materials FOR ALL
TO authenticated
USING (
  public.is_teacher() 
  AND EXISTS (SELECT 1 FROM public.test_imports i WHERE i.id = test_import_materials.import_id AND i.created_by = auth.uid())
)
WITH CHECK (
  public.is_teacher() 
  AND EXISTS (SELECT 1 FROM public.test_imports i WHERE i.id = test_import_materials.import_id AND i.created_by = auth.uid())
);

DROP POLICY IF EXISTS "Teachers manage own import candidates" ON public.test_import_candidates;
CREATE POLICY "Teachers manage own import candidates" ON public.test_import_candidates FOR ALL
TO authenticated
USING (
  public.is_teacher() 
  AND EXISTS (SELECT 1 FROM public.test_imports i WHERE i.id = test_import_candidates.import_id AND i.created_by = auth.uid())
)
WITH CHECK (
  public.is_teacher() 
  AND EXISTS (SELECT 1 FROM public.test_imports i WHERE i.id = test_import_candidates.import_id AND i.created_by = auth.uid())
);

-- Triggers for updated_at
DROP TRIGGER IF EXISTS set_materials_updated_at ON public.test_import_materials;
CREATE TRIGGER set_materials_updated_at
BEFORE UPDATE ON public.test_import_materials
FOR EACH ROW EXECUTE FUNCTION public.ksc_touch_test_import_updated_at();

DROP TRIGGER IF EXISTS set_candidates_updated_at ON public.test_import_candidates;
CREATE TRIGGER set_candidates_updated_at
BEFORE UPDATE ON public.test_import_candidates
FOR EACH ROW EXECUTE FUNCTION public.ksc_touch_test_import_updated_at();

-- Atomic Analysis Replacement RPC
CREATE OR REPLACE FUNCTION public.ksc_replace_test_import_analysis(
    p_import_id UUID,
    p_materials JSONB,
    p_candidates JSONB
) RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
    v_import_exists BOOLEAN;
BEGIN
    -- 0: Validate JSON payload
    IF p_materials IS NULL OR jsonb_typeof(p_materials) != 'array' THEN
        RAISE EXCEPTION 'p_materials must be a JSON array';
    END IF;

    IF p_candidates IS NULL OR jsonb_typeof(p_candidates) != 'array' THEN
        RAISE EXCEPTION 'p_candidates must be a JSON array';
    END IF;

    -- 1 & 2: Verify auth and ownership
    IF auth.uid() IS NULL OR NOT public.is_teacher() THEN
        RAISE EXCEPTION 'Teacher access required';
    END IF;

    SELECT EXISTS (
        SELECT 1 FROM public.test_imports 
        WHERE id = p_import_id AND created_by = auth.uid()
    ) INTO v_import_exists;

    IF NOT v_import_exists THEN
        RAISE EXCEPTION 'Import not found or unauthorized';
    END IF;

    -- 4 & 5: Delete previous staging data for this import
    DELETE FROM public.test_import_candidates WHERE import_id = p_import_id;
    DELETE FROM public.test_import_materials WHERE import_id = p_import_id;

    -- 6: Insert new materials
    IF jsonb_array_length(p_materials) > 0 THEN
        INSERT INTO public.test_import_materials (id, import_id, material_type, content_text, source_page, created_by)
        SELECT 
            (m->>'id')::UUID,
            p_import_id,
            m->>'material_type',
            m->>'content_text',
            (m->>'source_page')::INTEGER,
            auth.uid()
        FROM jsonb_array_elements(p_materials) AS m;
    END IF;

    -- 7: Insert new candidates
    IF jsonb_array_length(p_candidates) > 0 THEN
        INSERT INTO public.test_import_candidates (id, import_id, material_id, question_number, question_text, options, proposed_correct_index, source_page, status, warnings, created_by)
        SELECT 
            COALESCE((c->>'id')::UUID, gen_random_uuid()),
            p_import_id,
            NULLIF(c->>'material_id', '')::UUID,
            c->>'question_number',
            c->>'question_text',
            COALESCE(c->'options', '[]'::jsonb),
            (c->>'proposed_correct_index')::INTEGER,
            (c->>'source_page')::INTEGER,
            COALESCE(c->>'status', 'NEEDS_REVIEW'),
            COALESCE(c->'warnings', '[]'::jsonb),
            auth.uid()
        FROM jsonb_array_elements(p_candidates) AS c;
    END IF;

    -- 8: Update parent import status
    UPDATE public.test_imports SET status = 'REVIEW_CANDIDATES', updated_at = NOW() WHERE id = p_import_id;

END;
$$;

-- Revoke unwanted permissions
REVOKE ALL ON FUNCTION public.ksc_replace_test_import_analysis(UUID, JSONB, JSONB) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.ksc_replace_test_import_analysis(UUID, JSONB, JSONB) TO authenticated;

REVOKE ALL ON public.test_import_materials FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.test_import_materials TO authenticated;

REVOKE ALL ON public.test_import_candidates FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.test_import_candidates TO authenticated;

COMMIT;
