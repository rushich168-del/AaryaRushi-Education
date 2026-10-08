-- LOCAL TEST ONLY. Never execute against Supabase/remote databases.
DO $$ BEGIN
 IF current_database() !~ '^ksc_contract_(clean|upgrade)_[a-f0-9]{32}$'
 OR host(inet_server_addr()) IS DISTINCT FROM '127.0.0.1' OR inet_server_port()<>54322
 OR replace(current_setting('data_directory'),chr(92),'/') IS DISTINCT FROM 'C:/KST/.local_pg'
 OR (SELECT system_identifier::text FROM pg_control_system())<>'7684311220310446404'
 THEN RAISE EXCEPTION 'Not the allowlisted disposable database'; END IF;
END $$;
CREATE SCHEMA auth;
CREATE TABLE auth.users(id uuid PRIMARY KEY,email text,role text);
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
 SELECT NULLIF(current_setting('request.jwt.claim.sub',true),'')::uuid;
$$;
DO $$ DECLARE n text; BEGIN
 FOREACH n IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
  IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname=n) THEN
   EXECUTE format('CREATE ROLE %I NOLOGIN NOSUPERUSER NOBYPASSRLS',n);
  END IF;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname=n AND (rolsuper OR rolbypassrls))
   OR EXISTS(SELECT 1 FROM pg_auth_members m JOIN pg_roles r ON r.oid=m.member WHERE r.rolname=n)
  THEN RAISE EXCEPTION 'Unsafe pre-existing test role %; refusing to alter cluster roles',n; END IF;
 END LOOP;
END $$;
GRANT USAGE ON SCHEMA public,auth TO anon,authenticated,service_role;
-- Model API object grants; RLS and explicit function revokes must supply the boundary.
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon,authenticated,service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO anon,authenticated,service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon,authenticated,service_role;
