-- LOCAL REVIEW PACKAGE: forward-only KSC staff access. Never run the clean installer.
BEGIN;
DO $$ BEGIN
 IF to_regclass('public.organizations') IS NOT NULL
 OR to_regclass('public.ksc_course_tracks') IS NULL
 OR to_regprocedure('ksc_private.provision_student()') IS NULL
 OR to_regprocedure('public.ksc_publish_printed_paper(uuid,integer,boolean)') IS NULL
 THEN RAISE EXCEPTION 'Expected isolated KSC baseline through printed-paper publishing'; END IF;
END $$;

CREATE TABLE public.ksc_staff_access(
 user_id uuid PRIMARY KEY REFERENCES auth.users(id), full_name text NOT NULL CHECK(btrim(full_name)<>''),
 role text NOT NULL CHECK(role IN('admin','teacher')),
 state text NOT NULL DEFAULT 'active' CHECK(state IN('active','suspended','pending')),
 password_change_required boolean NOT NULL DEFAULT true,
 temporary_expires_at timestamptz, password_operation_started_at timestamptz, version integer NOT NULL DEFAULT 1 CHECK(version>0),
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
-- Existing teacher records/work are preserved. Access needs deliberate reconciliation.
INSERT INTO public.ksc_staff_access(user_id,full_name,role,state,password_change_required)
 SELECT id,coalesce(nullif(btrim(full_name),''),'KSC staff'),'teacher','pending',false FROM public.teacher_profiles;
INSERT INTO public.ksc_staff_memberships(institute_id,user_id) SELECT '00000000-0000-4000-8000-000000000001',id FROM public.teacher_profiles ON CONFLICT DO NOTHING;
CREATE TABLE public.ksc_teacher_courses(
 user_id uuid REFERENCES public.ksc_staff_access(user_id), course_id uuid REFERENCES public.ksc_courses(id),
 PRIMARY KEY(user_id,course_id)
);
CREATE TABLE public.ksc_teacher_batches(
 user_id uuid REFERENCES public.ksc_staff_access(user_id), batch_id uuid REFERENCES public.ksc_batches(id),
 PRIMARY KEY(user_id,batch_id)
);
CREATE TABLE public.ksc_staff_audit(
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, actor_id uuid REFERENCES auth.users(id),
 target_id uuid REFERENCES auth.users(id), action text NOT NULL, detail jsonb NOT NULL DEFAULT '{}',
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE ksc_private.staff_operations(
 request_id uuid PRIMARY KEY, actor_id uuid NOT NULL REFERENCES auth.users(id),
 email text NOT NULL, full_name text NOT NULL, courses uuid[] NOT NULL, batches uuid[] NOT NULL,
 target_id uuid REFERENCES auth.users(id), state text NOT NULL DEFAULT 'prepared' CHECK(state IN('prepared','complete')),
 created_at timestamptz NOT NULL DEFAULT now(), operation_started_at timestamptz NOT NULL DEFAULT now()
);
-- A narrow wrapper may enable legacy publication only within its own transaction.
-- Unlike a GUC/localStorage flag this table cannot be written by API roles.
CREATE TABLE ksc_private.staff_authoring_context(
 transaction_id bigint NOT NULL, user_id uuid NOT NULL, PRIMARY KEY(transaction_id,user_id)
);
CREATE TABLE public.ksc_staff_papers(
 paper_id uuid PRIMARY KEY REFERENCES public.printed_papers(id), course_id uuid NOT NULL REFERENCES public.ksc_courses(id)
);
CREATE TABLE public.ksc_staff_tests(
 test_id uuid PRIMARY KEY REFERENCES public.tests(id), course_id uuid NOT NULL REFERENCES public.ksc_courses(id)
);
REVOKE ALL ON ALL TABLES IN SCHEMA ksc_private FROM PUBLIC,anon,authenticated,service_role;
ALTER TABLE public.ksc_staff_access ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ksc_teacher_courses ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ksc_teacher_batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ksc_staff_audit ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ksc_staff_papers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ksc_staff_tests ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.ksc_staff_access,public.ksc_teacher_courses,public.ksc_teacher_batches,
 public.ksc_staff_audit,public.ksc_staff_papers,public.ksc_staff_tests FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION public.ksc_is_admin() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
 SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM public.ksc_staff_access WHERE user_id=auth.uid() AND role='admin'
 AND state='active' AND NOT password_change_required);
$$;
CREATE FUNCTION public.ksc_is_active_staff() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
 SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM public.ksc_staff_access WHERE user_id=auth.uid() AND state='active' AND NOT password_change_required);
$$;
-- Existing broad teacher policies/RPCs become ADMIN ONLY. A scoped paper wrapper
-- enables legacy internals after checking role, ownership, course and program.
CREATE OR REPLACE FUNCTION public.is_teacher() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
 SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT public.ksc_is_admin() OR (public.ksc_is_active_staff() AND EXISTS(
 SELECT 1 FROM ksc_private.staff_authoring_context WHERE user_id=auth.uid() AND transaction_id=txid_current()));
$$;
CREATE FUNCTION public.ksc_my_access() RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER
 SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT coalesce((SELECT jsonb_build_object('role',role,'state',state,'name',full_name,
 'password_change_required',password_change_required,
 'temporary_expired',password_change_required AND (temporary_expires_at IS NULL OR temporary_expires_at<=now()),
 'version',version) FROM public.ksc_staff_access WHERE user_id=auth.uid()),
 jsonb_build_object('role','student','state','active','password_change_required',false,'temporary_expired',false));
$$;
CREATE OR REPLACE FUNCTION public.ksc_manages_course(p_course uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
 SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT public.ksc_is_active_staff() AND (public.ksc_is_admin() OR EXISTS(
 SELECT 1 FROM public.ksc_teacher_courses WHERE user_id=auth.uid() AND course_id=p_course));
$$;
CREATE OR REPLACE FUNCTION public.ksc_manages_batch(p_batch uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
 SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT public.ksc_is_active_staff() AND (public.ksc_is_admin() OR EXISTS(
 SELECT 1 FROM public.ksc_teacher_batches a JOIN public.ksc_batches b ON b.id=a.batch_id
 JOIN public.ksc_teacher_courses c ON c.user_id=a.user_id AND c.course_id=b.course_id
 WHERE a.user_id=auth.uid() AND a.batch_id=p_batch));
$$;
CREATE FUNCTION public.ksc_teaches_student(p_student uuid,p_course uuid DEFAULT NULL) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
 SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT public.ksc_is_admin() OR (public.ksc_is_active_staff() AND EXISTS(
 SELECT 1 FROM public.ksc_enrollments e JOIN public.ksc_batches b ON b.id=e.batch_id
 WHERE e.student_id=p_student AND (p_course IS NULL OR b.course_id=p_course) AND public.ksc_manages_batch(b.id)));
$$;
DROP POLICY accessible_batch ON public.ksc_batches;
CREATE POLICY accessible_batch ON public.ksc_batches FOR SELECT TO authenticated
 USING(public.ksc_manages_batch(id) OR EXISTS(SELECT 1 FROM public.ksc_enrollments e WHERE e.batch_id=id AND e.student_id=auth.uid()));
DROP POLICY accessible_completion ON public.ksc_lesson_completions;
CREATE POLICY accessible_completion ON public.ksc_lesson_completions FOR SELECT TO authenticated
 USING(student_id=auth.uid() OR EXISTS(SELECT 1 FROM public.ksc_lessons l WHERE l.id=lesson_id AND public.ksc_teaches_student(student_id,l.course_id)));
CREATE POLICY assigned_student_profile ON public.student_profiles FOR SELECT TO authenticated USING(public.ksc_teaches_student(id));
CREATE POLICY staff_self ON public.ksc_staff_access FOR SELECT TO authenticated USING(user_id=auth.uid() OR public.ksc_is_admin());
CREATE POLICY course_assignment_read ON public.ksc_teacher_courses FOR SELECT TO authenticated USING(user_id=auth.uid() OR public.ksc_is_admin());
CREATE POLICY batch_assignment_read ON public.ksc_teacher_batches FOR SELECT TO authenticated USING(user_id=auth.uid() OR public.ksc_is_admin());
CREATE POLICY staff_audit_admin ON public.ksc_staff_audit FOR SELECT TO authenticated USING(public.ksc_is_admin());
GRANT SELECT ON public.ksc_staff_access,public.ksc_teacher_courses,public.ksc_teacher_batches,public.ksc_staff_audit TO authenticated;

-- Teachers edit assigned lessons; course/batch creation and enrollment stay admin-only.
CREATE OR REPLACE FUNCTION public.ksc_create_batch(p_course uuid,p_name text) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER
 SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE result uuid; BEGIN
 IF NOT public.ksc_is_admin() THEN RAISE EXCEPTION 'Administrator access required'; END IF;
 INSERT INTO public.ksc_batches(course_id,name) VALUES(p_course,btrim(p_name)) RETURNING id INTO result; RETURN result;
END $$;
CREATE OR REPLACE FUNCTION public.ksc_enroll_student(p_batch uuid,p_email text,p_remove boolean DEFAULT false) RETURNS void LANGUAGE plpgsql SECURITY DEFINER
 SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE learner uuid; BEGIN
 IF NOT public.ksc_is_admin() THEN RAISE EXCEPTION 'Administrator access required'; END IF;
 SELECT s.id INTO learner FROM public.student_profiles s JOIN auth.users u ON u.id=s.id
 WHERE lower(u.email)=lower(btrim(p_email)) AND u.email_confirmed_at IS NOT NULL;
 IF learner IS NULL THEN RAISE EXCEPTION 'No confirmed learner account matches this email'; END IF;
 IF p_remove THEN DELETE FROM public.ksc_enrollments WHERE batch_id=p_batch AND student_id=learner;
 ELSE INSERT INTO public.ksc_enrollments(batch_id,student_id) VALUES(p_batch,learner) ON CONFLICT DO NOTHING; END IF;
END $$;
-- Course-track mappings govern programs and are configured only by admin.
DROP POLICY course_track_staff ON public.ksc_course_tracks;
CREATE POLICY course_track_staff ON public.ksc_course_tracks FOR ALL TO authenticated
 USING(public.ksc_is_admin()) WITH CHECK(public.ksc_is_admin());

CREATE FUNCTION ksc_private.require_admin(p_actor uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER
 SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 PERFORM 1 FROM public.ksc_staff_access WHERE user_id=p_actor AND role='admin' AND state='active'
 AND NOT password_change_required FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Administrator access required'; END IF;
END $$;
CREATE FUNCTION ksc_private.validate_assignments(p_courses uuid[],p_batches uuid[]) RETURNS void LANGUAGE plpgsql
 SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF p_courses IS NULL OR p_batches IS NULL OR cardinality(p_courses)>100 OR cardinality(p_batches)>200
 OR EXISTS(SELECT 1 FROM unnest(p_courses) c WHERE c IS NULL OR NOT EXISTS(SELECT 1 FROM public.ksc_courses WHERE id=c))
 OR EXISTS(SELECT 1 FROM unnest(p_batches) x WHERE x IS NULL OR NOT EXISTS(
 SELECT 1 FROM public.ksc_batches WHERE id=x AND course_id=ANY(p_courses)))
 THEN RAISE EXCEPTION 'Choose valid courses and batches belonging to those courses'; END IF;
END $$;
CREATE FUNCTION public.ksc_staff_list() RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
 SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 PERFORM ksc_private.require_admin(auth.uid());
 RETURN coalesce((SELECT jsonb_agg(jsonb_build_object('id',s.user_id,'name',s.full_name,'email',u.email,
 'role',s.role,'state',s.state,'password_change_required',s.password_change_required,'version',s.version,
 'courses',(SELECT coalesce(jsonb_agg(course_id),'[]') FROM public.ksc_teacher_courses WHERE user_id=s.user_id),
 'batches',(SELECT coalesce(jsonb_agg(batch_id),'[]') FROM public.ksc_teacher_batches WHERE user_id=s.user_id))
 ORDER BY lower(s.full_name)) FROM public.ksc_staff_access s JOIN auth.users u ON u.id=s.user_id),'[]');
END $$;
CREATE FUNCTION public.ksc_staff_assign(p_user uuid,p_courses uuid[],p_batches uuid[],p_version integer) RETURNS void LANGUAGE plpgsql SECURITY DEFINER
 SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 PERFORM ksc_private.require_admin(auth.uid());
 PERFORM 1 FROM public.ksc_staff_access WHERE user_id=p_user AND role='teacher' AND version=p_version FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Teacher changed. Refresh and try again'; END IF;
 PERFORM ksc_private.validate_assignments(p_courses,p_batches);
 DELETE FROM public.ksc_teacher_batches WHERE user_id=p_user;
 DELETE FROM public.ksc_teacher_courses WHERE user_id=p_user;
 INSERT INTO public.ksc_teacher_courses SELECT p_user,c FROM (SELECT DISTINCT unnest(p_courses) c) q;
 INSERT INTO public.ksc_teacher_batches SELECT p_user,b FROM (SELECT DISTINCT unnest(p_batches) b) q;
 UPDATE public.ksc_staff_access SET version=version+1,updated_at=now() WHERE user_id=p_user;
 INSERT INTO public.ksc_staff_audit(actor_id,target_id,action,detail) VALUES(auth.uid(),p_user,'assignments_changed',
 jsonb_build_object('courses',p_courses,'batches',p_batches));
END $$;
CREATE FUNCTION public.ksc_staff_set_state(p_user uuid,p_state text,p_version integer) RETURNS void LANGUAGE plpgsql SECURITY DEFINER
 SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE s public.ksc_staff_access;
BEGIN
 -- Serialize admin-state changes and protect the last active administrator.
 PERFORM pg_advisory_xact_lock(736036);
 PERFORM ksc_private.require_admin(auth.uid());
 SELECT * INTO s FROM public.ksc_staff_access WHERE user_id=p_user FOR UPDATE;
 IF NOT FOUND OR s.version<>p_version THEN RAISE EXCEPTION 'Account changed. Refresh and try again'; END IF;
 IF p_state NOT IN('active','suspended') OR p_user=auth.uid() OR s.role='admin' THEN
 RAISE EXCEPTION 'Only another teacher account can be suspended or restored here'; END IF;
 UPDATE public.ksc_staff_access SET state=p_state,version=version+1,updated_at=now() WHERE user_id=p_user;
 INSERT INTO public.ksc_staff_audit(actor_id,target_id,action) VALUES(auth.uid(),p_user,'state_'||p_state);
END $$;

-- Service-only identity lifecycle: p_actor MUST be derived from a verified bearer token.
CREATE FUNCTION public.ksc_staff_begin_create(p_actor uuid,p_request uuid,p_email text,p_name text,p_courses uuid[],p_batches uuid[]) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
 SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE o ksc_private.staff_operations;
BEGIN
 PERFORM ksc_private.require_admin(p_actor);
 IF p_request IS NULL OR btrim(p_name)='' OR length(p_name)>120 OR p_email<>lower(btrim(p_email))
 OR length(p_email)>254 OR p_email NOT LIKE '%_@_%._%' THEN RAISE EXCEPTION 'Enter a valid name and email'; END IF;
 PERFORM ksc_private.validate_assignments(p_courses,p_batches);
 INSERT INTO ksc_private.staff_operations(request_id,actor_id,email,full_name,courses,batches)
 VALUES(p_request,p_actor,p_email,btrim(p_name),p_courses,p_batches) ON CONFLICT DO NOTHING RETURNING * INTO o;
 IF FOUND THEN RETURN jsonb_build_object('state',o.state,'target_id',o.target_id); END IF;
 SELECT * INTO o FROM ksc_private.staff_operations WHERE request_id=p_request FOR UPDATE;
 IF o.actor_id<>p_actor OR o.email<>p_email OR o.full_name<>btrim(p_name) OR o.courses<>p_courses OR o.batches<>p_batches
 THEN RAISE EXCEPTION 'Request changed. Start a new account operation'; END IF;
 IF o.state='prepared' THEN
 IF o.operation_started_at>now()-interval '2 minutes' THEN RAISE EXCEPTION 'Account creation is already running. Wait two minutes before retrying'; END IF;
 UPDATE ksc_private.staff_operations SET operation_started_at=now() WHERE request_id=p_request;
 END IF;
 RETURN jsonb_build_object('state',o.state,'target_id',o.target_id);
END $$;
CREATE FUNCTION public.ksc_staff_complete_create(p_actor uuid,p_request uuid,p_target uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
 SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE o ksc_private.staff_operations; account auth.users;
BEGIN
 PERFORM ksc_private.require_admin(p_actor);
 SELECT * INTO o FROM ksc_private.staff_operations WHERE request_id=p_request AND actor_id=p_actor FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Account operation not found'; END IF;
 IF o.state='complete' THEN RETURN jsonb_build_object('id',o.target_id,'created',true); END IF;
 SELECT * INTO account FROM auth.users WHERE id=p_target FOR UPDATE;
 IF NOT FOUND OR lower(account.email)<>o.email OR account.raw_app_meta_data->>'ksc_staff_request' IS DISTINCT FROM p_request::text
 THEN RAISE EXCEPTION 'Existing identity cannot be overwritten'; END IF;
 PERFORM ksc_private.validate_assignments(o.courses,o.batches);
 INSERT INTO public.teacher_profiles(id,full_name,role) VALUES(p_target,o.full_name,'teacher') ON CONFLICT(id) DO NOTHING;
 INSERT INTO public.ksc_staff_access(user_id,full_name,role,password_change_required,temporary_expires_at)
 VALUES(p_target,o.full_name,'teacher',true,now()+interval '24 hours');
 INSERT INTO public.ksc_staff_memberships(institute_id,user_id) VALUES('00000000-0000-4000-8000-000000000001',p_target) ON CONFLICT DO NOTHING;
 INSERT INTO public.ksc_teacher_courses SELECT p_target,c FROM (SELECT DISTINCT unnest(o.courses) c) q;
 INSERT INTO public.ksc_teacher_batches SELECT p_target,b FROM (SELECT DISTINCT unnest(o.batches) b) q;
 INSERT INTO public.ksc_staff_audit(actor_id,target_id,action) VALUES(p_actor,p_target,'teacher_created');
 UPDATE ksc_private.staff_operations SET state='complete',target_id=p_target WHERE request_id=p_request;
 RETURN jsonb_build_object('id',p_target,'created',true);
END $$;
CREATE FUNCTION public.ksc_staff_created_identity(p_actor uuid,p_request uuid) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER
 SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE result uuid; BEGIN
 PERFORM ksc_private.require_admin(p_actor);
 SELECT u.id INTO result FROM auth.users u JOIN ksc_private.staff_operations o ON o.email=lower(u.email)
 WHERE o.actor_id=p_actor AND o.request_id=p_request AND u.raw_app_meta_data->>'ksc_staff_request'=p_request::text;
 RETURN result;
END $$;
CREATE FUNCTION public.ksc_staff_password_gate(p_actor uuid,p_target uuid,p_reset boolean,p_version integer DEFAULT NULL) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
 SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE s public.ksc_staff_access; BEGIN
 IF p_reset THEN PERFORM ksc_private.require_admin(p_actor); ELSE
 IF p_actor IS DISTINCT FROM p_target THEN RAISE EXCEPTION 'Own account required'; END IF; END IF;
 SELECT * INTO s FROM public.ksc_staff_access WHERE user_id=p_target FOR UPDATE;
 IF NOT FOUND OR s.state<>'active' THEN RAISE EXCEPTION 'Active staff account required'; END IF;
 IF s.password_operation_started_at > now()-interval '2 minutes' THEN RAISE EXCEPTION 'A password operation is already running. Wait two minutes before retrying'; END IF;
 IF p_reset THEN
 IF s.role<>'teacher' OR s.user_id=p_actor OR s.version IS DISTINCT FROM p_version THEN RAISE EXCEPTION 'Teacher changed. Refresh first'; END IF;
 UPDATE public.ksc_staff_access SET password_change_required=true,temporary_expires_at=now()+interval '24 hours',
 password_operation_started_at=now(),version=version+1,updated_at=now() WHERE user_id=p_target RETURNING * INTO s;
 INSERT INTO public.ksc_staff_audit(actor_id,target_id,action) VALUES(p_actor,p_target,'temporary_password_requested');
 ELSE
 IF NOT s.password_change_required OR s.temporary_expires_at IS NULL OR s.temporary_expires_at<=now()
 THEN RAISE EXCEPTION 'Temporary access expired. Ask your administrator for a new password'; END IF;
 UPDATE public.ksc_staff_access SET password_operation_started_at=now(),version=version+1,updated_at=now() WHERE user_id=p_target RETURNING * INTO s;
 END IF;
 RETURN jsonb_build_object('version',s.version);
END $$;
CREATE FUNCTION public.ksc_staff_password_complete(p_actor uuid,p_version integer) RETURNS void LANGUAGE plpgsql SECURITY DEFINER
 SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 UPDATE public.ksc_staff_access SET password_change_required=false,temporary_expires_at=NULL,password_operation_started_at=NULL,version=version+1,updated_at=now()
 WHERE user_id=p_actor AND state='active' AND password_change_required AND version=p_version AND temporary_expires_at>now();
 IF NOT FOUND THEN RAISE EXCEPTION 'Account changed during password setup. Ask your administrator to reset access'; END IF;
 INSERT INTO public.ksc_staff_audit(actor_id,target_id,action) VALUES(p_actor,p_actor,'password_setup_complete');
END $$;
-- Explicit existing-account promotion does not reset credentials or student records.
CREATE FUNCTION public.ksc_staff_password_release(p_actor uuid,p_target uuid,p_version integer) RETURNS void LANGUAGE plpgsql SECURITY DEFINER
 SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 PERFORM ksc_private.require_admin(p_actor);
 UPDATE public.ksc_staff_access SET password_operation_started_at=NULL WHERE user_id=p_target AND version=p_version AND role='teacher';
 IF NOT FOUND THEN RAISE EXCEPTION 'Account changed. Refresh and retry'; END IF;
 INSERT INTO public.ksc_staff_audit(actor_id,target_id,action) VALUES(p_actor,p_target,'temporary_password_issued');
END $$;
CREATE FUNCTION public.ksc_staff_grant_existing(p_user uuid,p_email text,p_name text,p_courses uuid[],p_batches uuid[]) RETURNS void LANGUAGE plpgsql SECURITY DEFINER
 SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 PERFORM ksc_private.require_admin(auth.uid());
 PERFORM ksc_private.validate_assignments(p_courses,p_batches);
 PERFORM 1 FROM auth.users WHERE id=p_user AND lower(email)=lower(btrim(p_email)) AND email_confirmed_at IS NOT NULL FOR UPDATE;
 IF NOT FOUND OR EXISTS(SELECT 1 FROM public.ksc_staff_access WHERE user_id=p_user) OR btrim(p_name)=''
 OR EXISTS(SELECT 1 FROM auth.users WHERE id=p_user AND raw_app_meta_data ? 'ksc_staff_request') THEN
 RAISE EXCEPTION 'Use a confirmed existing account without staff access'; END IF;
 INSERT INTO public.teacher_profiles(id,full_name,role) VALUES(p_user,btrim(p_name),'teacher') ON CONFLICT DO NOTHING;
 INSERT INTO public.ksc_staff_access(user_id,full_name,role,password_change_required) VALUES(p_user,btrim(p_name),'teacher',false);
 INSERT INTO public.ksc_staff_memberships VALUES('00000000-0000-4000-8000-000000000001',p_user) ON CONFLICT DO NOTHING;
 INSERT INTO public.ksc_teacher_courses SELECT p_user,c FROM (SELECT DISTINCT unnest(p_courses) c) q;
 INSERT INTO public.ksc_teacher_batches SELECT p_user,b FROM (SELECT DISTINCT unnest(p_batches) b) q;
 INSERT INTO public.ksc_staff_audit(actor_id,target_id,action) VALUES(auth.uid(),p_user,'existing_teacher_granted');
END $$;

CREATE FUNCTION public.ksc_staff_lookup_existing(p_email text) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER
 SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE result uuid; BEGIN
 PERFORM ksc_private.require_admin(auth.uid());
 SELECT id INTO result FROM auth.users WHERE lower(email)=lower(btrim(p_email)) AND email_confirmed_at IS NOT NULL
 AND NOT (coalesce(raw_app_meta_data,'{}') ? 'ksc_staff_request');
 IF result IS NULL THEN RAISE EXCEPTION 'No confirmed existing account matches. Use Add teacher for a new account'; END IF;
 RETURN result;
END $$;
CREATE FUNCTION public.ksc_teaching_courses() RETURNS SETOF public.ksc_courses LANGUAGE sql STABLE SECURITY DEFINER
 SET search_path=pg_catalog,public,pg_temp AS $$ SELECT c.* FROM public.ksc_courses c WHERE public.ksc_manages_course(c.id) ORDER BY c.name $$;
-- Scoped printed-paper adapters preserve original review/score/publication internals.
CREATE FUNCTION ksc_private.require_author_course(p_course uuid,p_metadata jsonb) RETURNS void LANGUAGE plpgsql
 SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 PERFORM 1 FROM public.ksc_staff_access WHERE user_id=auth.uid() AND state='active' AND NOT password_change_required FOR SHARE;
 IF NOT FOUND OR NOT public.ksc_manages_course(p_course) THEN RAISE EXCEPTION 'Assigned course access required'; END IF;
 IF NOT public.ksc_is_admin() THEN
 PERFORM 1 FROM public.ksc_teacher_courses WHERE user_id=auth.uid() AND course_id=p_course FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Assigned course access required'; END IF;
 END IF;
 IF p_metadata IS NOT NULL AND p_metadata->>'exam_id' IS NOT NULL AND NOT EXISTS(
 SELECT 1 FROM public.ksc_course_tracks ct JOIN public.exam_levels l ON l.id=ct.level_id
 WHERE ct.course_id=p_course AND l.exam_id=(p_metadata->>'exam_id')::uuid
 AND (p_metadata->>'level_id' IS NULL OR l.id=(p_metadata->>'level_id')::uuid))
 THEN RAISE EXCEPTION 'Choose a program linked to your assigned course'; END IF;
END $$;
CREATE FUNCTION public.ksc_staff_paper_save(p_course uuid,p_id uuid,p_metadata jsonb,p_questions jsonb,p_revision integer) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
 SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE m jsonb; result jsonb; BEGIN
 IF p_id IS NOT NULL THEN
 SELECT p.metadata INTO m FROM public.printed_papers p JOIN public.ksc_staff_papers b ON b.paper_id=p.id
 WHERE p.id=p_id AND p.created_by=auth.uid() AND b.course_id=p_course FOR UPDATE OF p;
 IF NOT FOUND THEN RAISE EXCEPTION 'Paper is not available in this course'; END IF;
 END IF;
 PERFORM ksc_private.require_author_course(p_course,coalesce(p_metadata,m));
 INSERT INTO ksc_private.staff_authoring_context VALUES(txid_current(),auth.uid());
 result:=public.ksc_save_printed_paper(p_id,p_metadata,p_questions,p_revision);
 INSERT INTO public.ksc_staff_papers(paper_id,course_id) VALUES((result->>'id')::uuid,p_course) ON CONFLICT DO NOTHING;
 DELETE FROM ksc_private.staff_authoring_context WHERE transaction_id=txid_current() AND user_id=auth.uid();
 RETURN result;
END $$;
CREATE FUNCTION public.ksc_staff_paper_subject(p_course uuid,p_exam uuid) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER
 SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE result uuid; BEGIN
 IF p_exam IS NULL THEN RAISE EXCEPTION 'Select a program linked to your course'; END IF;
 PERFORM ksc_private.require_author_course(p_course,jsonb_build_object('exam_id',p_exam));
 PERFORM pg_advisory_xact_lock(hashtextextended(p_exam::text,736036));
 SELECT id INTO result FROM public.exam_subjects WHERE exam_id=p_exam AND lower(name)='general / mixed subjects' ORDER BY id LIMIT 1;
 IF result IS NULL THEN INSERT INTO public.exam_subjects(exam_id,name) VALUES(p_exam,'General / mixed subjects') RETURNING id INTO result; END IF;
 RETURN result;
END $$;
CREATE FUNCTION public.ksc_staff_paper_publish(p_course uuid,p_id uuid,p_revision integer,p_reviewed boolean) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER
 SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE m jsonb; result uuid; BEGIN
 SELECT p.metadata INTO m FROM public.printed_papers p JOIN public.ksc_staff_papers b ON b.paper_id=p.id
 WHERE p.id=p_id AND p.created_by=auth.uid() AND b.course_id=p_course FOR UPDATE OF p;
 IF NOT FOUND THEN RAISE EXCEPTION 'Paper is not available in this course'; END IF;
 PERFORM ksc_private.require_author_course(p_course,m);
 INSERT INTO ksc_private.staff_authoring_context VALUES(txid_current(),auth.uid());
 result:=public.ksc_publish_printed_paper(p_id,p_revision,p_reviewed);
 INSERT INTO public.ksc_staff_tests(test_id,course_id) VALUES(result,p_course) ON CONFLICT DO NOTHING;
 DELETE FROM ksc_private.staff_authoring_context WHERE transaction_id=txid_current() AND user_id=auth.uid();
 RETURN result;
END $$;
CREATE FUNCTION public.ksc_staff_paper_list(p_course uuid) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER
 SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT coalesce(jsonb_agg(to_jsonb(p) ORDER BY p.updated_at DESC),'[]') FROM
 (SELECT p.id,p.metadata,p.test_id,p.revision,p.updated_at FROM public.printed_papers p
 JOIN public.ksc_staff_papers b ON b.paper_id=p.id WHERE b.course_id=p_course AND p.created_by=auth.uid()
 AND public.ksc_manages_course(p_course) ORDER BY p.updated_at DESC LIMIT 20) p;
$$;
CREATE FUNCTION public.ksc_staff_paper_load(p_course uuid,p_id uuid) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
 SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE p public.printed_papers; BEGIN
 SELECT x.* INTO p FROM public.printed_papers x JOIN public.ksc_staff_papers b ON b.paper_id=x.id
 WHERE x.id=p_id AND b.course_id=p_course AND x.created_by=auth.uid() AND public.ksc_manages_course(p_course);
 IF NOT FOUND THEN RAISE EXCEPTION 'Paper is not available in this course'; END IF;
 RETURN jsonb_build_object('paper',to_jsonb(p),'questions',(SELECT coalesce(jsonb_agg(question ORDER BY position),'[]') FROM public.printed_paper_questions WHERE paper_id=p_id));
END $$;
CREATE FUNCTION public.ksc_teaching_results() RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER
 SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT coalesce(jsonb_agg(jsonb_build_object('id',a.id,'student',s.full_name,'test',t.name,'score',a.score,
 'total_marks',t.total_marks,'submitted_at',a.submitted_at) ORDER BY a.submitted_at DESC),'[]')
 FROM public.test_attempts a JOIN public.tests t ON t.id=a.test_id JOIN public.student_profiles s ON s.id=a.student_id
 JOIN public.ksc_staff_tests x ON x.test_id=t.id
 WHERE a.status IN('SUBMITTED','EXPIRED') AND public.ksc_manages_course(x.course_id) AND public.ksc_teaches_student(a.student_id,x.course_id);
$$;

REVOKE ALL ON ALL FUNCTIONS IN SCHEMA ksc_private FROM PUBLIC,anon,authenticated,service_role;
-- Explicit grant inventory: no privileged lifecycle RPC exposed to browsers.
DO $$ DECLARE f regprocedure; n text; BEGIN
 FOR f,n IN SELECT p.oid::regprocedure,p.proname FROM pg_proc p JOIN pg_namespace ns ON ns.oid=p.pronamespace
 WHERE ns.nspname='public' AND p.proname IN(
 'ksc_is_admin','ksc_is_active_staff','ksc_my_access','ksc_teaches_student','ksc_staff_list','ksc_staff_assign',
 'ksc_staff_set_state','ksc_staff_grant_existing','ksc_staff_lookup_existing','ksc_teaching_courses','ksc_staff_paper_subject','ksc_staff_paper_save','ksc_staff_paper_publish',
 'ksc_staff_paper_list','ksc_staff_paper_load','ksc_teaching_results','ksc_staff_begin_create','ksc_staff_complete_create',
 'ksc_staff_created_identity','ksc_staff_password_gate','ksc_staff_password_complete','ksc_staff_password_release')
 LOOP
 EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,anon,authenticated,service_role',f);
 IF n IN('ksc_staff_begin_create','ksc_staff_complete_create','ksc_staff_created_identity','ksc_staff_password_gate','ksc_staff_password_complete','ksc_staff_password_release')
 THEN EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role',f);
 ELSE EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated',f); END IF;
 END LOOP;
END $$;
-- is_teacher is also used by anonymous catalogue policies; helper returns false.
GRANT EXECUTE ON FUNCTION public.ksc_is_admin(),public.ksc_is_active_staff() TO anon;
CREATE TABLE ksc_private.staff_rate_windows(actor_id uuid PRIMARY KEY REFERENCES auth.users(id),window_start timestamptz NOT NULL,count integer NOT NULL);
REVOKE ALL ON ksc_private.staff_rate_windows FROM PUBLIC,anon,authenticated,service_role;
CREATE FUNCTION public.ksc_staff_rate_limit(p_actor uuid) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER
 SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE hits integer; BEGIN
 INSERT INTO ksc_private.staff_rate_windows VALUES(p_actor,date_trunc('minute',now()),1)
 ON CONFLICT(actor_id) DO UPDATE SET count=CASE WHEN staff_rate_windows.window_start=date_trunc('minute',now()) THEN staff_rate_windows.count+1 ELSE 1 END,
 window_start=date_trunc('minute',now()) RETURNING count INTO hits;
 RETURN hits<=10;
END $$;
REVOKE ALL ON FUNCTION public.ksc_staff_rate_limit(uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.ksc_staff_rate_limit(uuid) TO service_role;
COMMIT;

