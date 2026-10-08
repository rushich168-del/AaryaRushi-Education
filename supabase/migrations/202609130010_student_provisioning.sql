-- KSC-only baseline 0001-0009 required. Never apply to the active Atlas project.
-- Profiles identify accounts; they do not grant enrollment or staff status.
DO $$ BEGIN
  IF to_regclass('public.organizations') IS NOT NULL
     OR to_regclass('public.profiles') IS NOT NULL THEN
    RAISE EXCEPTION 'Refusing provisioning on a mixed/Atlas database';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid='auth.users'::regclass
             AND NOT tgisinternal AND tgname <> 'ksc_student_created') THEN
    RAISE EXCEPTION 'Unreviewed auth.users trigger; inspect before provisioning';
  END IF;
END $$;

CREATE SCHEMA IF NOT EXISTS ksc_private;
REVOKE ALL ON SCHEMA ksc_private FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION ksc_private.provision_student()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  INSERT INTO public.student_profiles(id, full_name)
  VALUES (NEW.id, CASE
    WHEN jsonb_typeof(NEW.raw_user_meta_data->'full_name') = 'string'
    THEN left(NEW.raw_user_meta_data->>'full_name', 200)
    ELSE '' END)
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION ksc_private.provision_student()
FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS ksc_student_created ON auth.users;
CREATE TRIGGER ksc_student_created AFTER INSERT ON auth.users
FOR EACH ROW EXECUTE FUNCTION ksc_private.provision_student();

-- Idempotent reconciliation. Preserve existing names and all trusted staff rows.
INSERT INTO public.student_profiles(id, full_name)
SELECT u.id, CASE WHEN jsonb_typeof(u.raw_user_meta_data->'full_name') = 'string'
  THEN left(u.raw_user_meta_data->>'full_name', 200) ELSE '' END
FROM auth.users u
WHERE NOT EXISTS (SELECT 1 FROM public.teacher_profiles t WHERE t.id=u.id)
ON CONFLICT (id) DO NOTHING;

ALTER TABLE public.student_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.teacher_profiles ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.student_profiles, public.teacher_profiles
FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.student_profiles, public.teacher_profiles TO authenticated;
-- Existing baseline RLS determines which rows are visible. No client role writes.
