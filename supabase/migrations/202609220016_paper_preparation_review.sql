BEGIN;
DO $$ BEGIN
 IF to_regclass('public.test_imports') IS NULL THEN RAISE EXCEPTION 'Requires 0014'; END IF;
 IF to_regclass('public.test_import_candidates') IS NULL THEN RAISE EXCEPTION 'Requires 0015'; END IF;
END $$;

ALTER TABLE public.test_imports ADD COLUMN expected_questions INTEGER;
ALTER TABLE public.test_import_candidates ADD COLUMN is_confirmed BOOLEAN NOT NULL DEFAULT false;

COMMIT;
