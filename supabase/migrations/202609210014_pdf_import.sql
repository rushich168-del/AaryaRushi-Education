BEGIN;

-- Forward update for the installed KSC baseline; never run against Atlas.
DO $$ BEGIN
 IF to_regclass('public.organizations') IS NOT NULL OR to_regprocedure('ksc_private.provision_student()') IS NULL
 THEN RAISE EXCEPTION 'Expected isolated KSC baseline'; END IF;
 IF to_regprocedure('public.is_teacher()') IS NULL THEN
  RAISE EXCEPTION 'Missing is_teacher function';
 END IF;
END $$;

-- 1. Create secure storage bucket for KSC source documents
INSERT INTO storage.buckets (id, name, public) 
VALUES ('ksc-source-documents', 'ksc-source-documents', false) 
ON CONFLICT (id) DO NOTHING;

-- Revoke all by default
DROP POLICY IF EXISTS "Teachers can manage source documents" ON storage.objects;
DROP POLICY IF EXISTS "Teachers can manage own source documents" ON storage.objects;
CREATE POLICY "Teachers can manage own source documents" ON storage.objects FOR ALL
TO authenticated
USING (
  bucket_id = 'ksc-source-documents' 
  AND public.is_teacher()
  AND name LIKE 'imports/' || auth.uid() || '/%'
)
WITH CHECK (
  bucket_id = 'ksc-source-documents' 
  AND public.is_teacher()
  AND name LIKE 'imports/' || auth.uid() || '/%'
);

-- 2. Create the test_imports table
CREATE TABLE IF NOT EXISTS public.test_imports (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    exam_id UUID NOT NULL REFERENCES public.exams(id) ON DELETE RESTRICT,
    level_id UUID REFERENCES public.exam_levels(id) ON DELETE RESTRICT,
    test_kind TEXT NOT NULL CHECK(test_kind IN ('GENERAL','FULL_MOCK','SUBJECT','CHAPTER','MODEL','PREVIOUS')),
    test_name TEXT NOT NULL,
    duration_minutes INTEGER CHECK(duration_minutes IS NULL OR duration_minutes > 0),
    storage_path TEXT NOT NULL,
    filename TEXT NOT NULL,
    file_size_bytes BIGINT,
    status TEXT NOT NULL DEFAULT 'UPLOADED',
    created_by UUID NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT DEFAULT auth.uid(),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Protect test_imports via RLS
ALTER TABLE public.test_imports ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Teachers can manage test imports" ON public.test_imports;
DROP POLICY IF EXISTS "Teachers can manage own test imports" ON public.test_imports;
CREATE POLICY "Teachers can manage own test imports" ON public.test_imports FOR ALL
TO authenticated
USING (public.is_teacher() AND created_by = auth.uid())
WITH CHECK (public.is_teacher() AND created_by = auth.uid());

-- Evaluator and general users should not have triggers or permissions beyond RLS
REVOKE ALL ON public.test_imports FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.test_imports TO authenticated;

-- Add updated_at trigger
CREATE OR REPLACE FUNCTION public.ksc_touch_test_import_updated_at() RETURNS trigger LANGUAGE plpgsql
 SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 NEW.updated_at = NOW();
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.ksc_touch_test_import_updated_at() FROM PUBLIC,anon,authenticated,service_role;

DROP TRIGGER IF EXISTS set_test_imports_updated_at ON public.test_imports;
CREATE TRIGGER set_test_imports_updated_at
BEFORE UPDATE ON public.test_imports
FOR EACH ROW
EXECUTE FUNCTION public.ksc_touch_test_import_updated_at();

-- Add track/exam context guard
CREATE OR REPLACE FUNCTION public.ksc_guard_test_import_context() RETURNS trigger LANGUAGE plpgsql
 SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF NEW.level_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.exam_levels WHERE id=NEW.level_id AND exam_id=NEW.exam_id) THEN
  RAISE EXCEPTION 'Track must belong to the selected program';
 END IF;
 RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS portal_test_import_context ON public.test_imports;
CREATE TRIGGER portal_test_import_context 
BEFORE INSERT OR UPDATE ON public.test_imports 
FOR EACH ROW EXECUTE FUNCTION public.ksc_guard_test_import_context();
REVOKE ALL ON FUNCTION public.ksc_guard_test_import_context() FROM PUBLIC,anon,authenticated,service_role;

COMMIT;
