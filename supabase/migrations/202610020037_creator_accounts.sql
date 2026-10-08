-- Local forward upgrade; requires reviewed KSC 0036. Not applied remotely.
BEGIN;
DO $$ BEGIN
 IF to_regclass('public.organizations') IS NOT NULL OR to_regclass('public.ksc_staff_access') IS NULL
 THEN RAISE EXCEPTION 'Expected isolated KSC staff baseline 0036'; END IF;
END $$;
ALTER TABLE public.ksc_staff_access DROP CONSTRAINT ksc_staff_access_role_check;
ALTER TABLE public.ksc_staff_access ADD CONSTRAINT ksc_staff_access_role_check CHECK(role IN('admin','teacher','creator'));
ALTER TABLE ksc_private.staff_operations ADD COLUMN role text NOT NULL DEFAULT 'teacher' CHECK(role IN('teacher','creator')),
 ADD COLUMN exams uuid[] NOT NULL DEFAULT '{}';
CREATE TABLE public.ksc_creator_exams(
 user_id uuid NOT NULL REFERENCES public.ksc_staff_access(user_id), exam_id uuid NOT NULL REFERENCES public.exams(id),
 PRIMARY KEY(user_id,exam_id)
);
ALTER TABLE public.ksc_creator_exams ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.ksc_creator_exams FROM PUBLIC,anon,authenticated,service_role;
CREATE POLICY creator_assignment_read ON public.ksc_creator_exams FOR SELECT TO authenticated
 USING(public.ksc_is_admin() OR (user_id=auth.uid() AND EXISTS(SELECT 1 FROM public.ksc_staff_access s
 WHERE s.user_id=auth.uid() AND s.role='creator' AND s.state='active' AND NOT s.password_change_required)));
GRANT SELECT ON public.ksc_creator_exams TO authenticated;
-- Legacy academic helpers deliberately exclude creators, even with stray teacher assignments.
CREATE OR REPLACE FUNCTION public.ksc_is_active_staff() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
 SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM public.ksc_staff_access WHERE user_id=auth.uid() AND role IN('teacher','admin')
 AND state='active' AND NOT password_change_required);
$$;
CREATE FUNCTION ksc_private.validate_creator_exams(p_exams uuid[],p_required boolean DEFAULT false) RETURNS void LANGUAGE plpgsql
 SET search_path=pg_catalog,public,pg_temp AS $$ BEGIN
 IF p_exams IS NULL OR cardinality(p_exams)>100 OR (p_required AND cardinality(p_exams)=0)
 OR EXISTS(SELECT 1 FROM unnest(p_exams) x WHERE x IS NULL OR NOT EXISTS(SELECT 1 FROM public.exams WHERE id=x))
 THEN RAISE EXCEPTION 'Choose valid assigned exams'; END IF;
END $$;
CREATE FUNCTION public.ksc_creator_setup() RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
 SET search_path=pg_catalog,public,pg_temp AS $$ BEGIN
 PERFORM ksc_private.require_admin(auth.uid());
 RETURN coalesce((SELECT jsonb_agg(jsonb_build_object('id',id,'name',name) ORDER BY name) FROM public.exams),'[]');
END $$;
CREATE FUNCTION public.ksc_my_creator_exams() RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
 SET search_path=pg_catalog,public,pg_temp AS $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.ksc_staff_access WHERE user_id=auth.uid() AND role='creator'
 AND state='active' AND NOT password_change_required) THEN RAISE EXCEPTION 'Active creator access required'; END IF;
 RETURN coalesce((SELECT jsonb_agg(jsonb_build_object('id',e.id,'name',e.name) ORDER BY e.name)
 FROM public.exams e JOIN public.ksc_creator_exams a ON a.exam_id=e.id WHERE a.user_id=auth.uid()),'[]');
END $$;
CREATE FUNCTION public.ksc_creator_assign(p_user uuid,p_exams uuid[],p_version integer) RETURNS void LANGUAGE plpgsql SECURITY DEFINER
 SET search_path=pg_catalog,public,pg_temp AS $$ BEGIN
 PERFORM ksc_private.require_admin(auth.uid());
 PERFORM 1 FROM public.ksc_staff_access WHERE user_id=p_user AND role='creator' AND version=p_version FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Account changed. Refresh and try again'; END IF;
 PERFORM ksc_private.validate_creator_exams(p_exams);
 DELETE FROM public.ksc_creator_exams WHERE user_id=p_user;
 INSERT INTO public.ksc_creator_exams SELECT p_user,x FROM (SELECT DISTINCT unnest(p_exams) x) q;
 UPDATE public.ksc_staff_access SET version=version+1,updated_at=now() WHERE user_id=p_user;
 INSERT INTO public.ksc_staff_audit(actor_id,target_id,action,detail) VALUES(auth.uid(),p_user,'creator_exams_changed',jsonb_build_object('exams',p_exams));
END $$;
CREATE OR REPLACE FUNCTION public.ksc_staff_begin_create(p_actor uuid,p_request uuid,p_email text,p_name text,p_courses uuid[],p_batches uuid[]) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
 SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE o ksc_private.staff_operations;
BEGIN
 PERFORM ksc_private.require_admin(p_actor);
 IF p_request IS NULL OR p_email IS NULL OR p_name IS NULL OR btrim(p_name)='' OR length(p_name)>120 OR p_email<>lower(btrim(p_email))
 OR length(p_email)>254 OR p_email NOT LIKE '%_@_%._%' THEN RAISE EXCEPTION 'Enter a valid name and email'; END IF;
 PERFORM ksc_private.validate_assignments(p_courses,p_batches);
 INSERT INTO ksc_private.staff_operations(request_id,actor_id,email,full_name,courses,batches)
 VALUES(p_request,p_actor,p_email,btrim(p_name),p_courses,p_batches) ON CONFLICT DO NOTHING RETURNING * INTO o;
 IF FOUND THEN RETURN jsonb_build_object('state',o.state,'target_id',o.target_id); END IF;
 SELECT * INTO o FROM ksc_private.staff_operations WHERE request_id=p_request FOR UPDATE;
 IF o.role<>'teacher' OR o.actor_id<>p_actor OR o.email<>p_email OR o.full_name<>btrim(p_name) OR o.courses<>p_courses OR o.batches<>p_batches
 THEN RAISE EXCEPTION 'Request changed. Start a new account operation'; END IF;
 IF o.state='prepared' THEN
 IF o.operation_started_at>now()-interval '2 minutes' THEN RAISE EXCEPTION 'Account creation is already running. Wait two minutes before retrying'; END IF;
 UPDATE ksc_private.staff_operations SET operation_started_at=now() WHERE request_id=p_request;
 END IF;
 RETURN jsonb_build_object('state',o.state,'target_id',o.target_id);
END $$;
CREATE OR REPLACE FUNCTION public.ksc_creator_begin_create(p_actor uuid,p_request uuid,p_email text,p_name text,p_exams uuid[]) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
 SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE o ksc_private.staff_operations;
BEGIN
 PERFORM ksc_private.require_admin(p_actor);
 IF p_request IS NULL OR p_email IS NULL OR p_name IS NULL OR btrim(p_name)='' OR length(p_name)>120 OR p_email<>lower(btrim(p_email))
 OR length(p_email)>254 OR p_email NOT LIKE '%_@_%._%' THEN RAISE EXCEPTION 'Enter a valid name and email'; END IF;
 PERFORM ksc_private.validate_creator_exams(p_exams,true);
 INSERT INTO ksc_private.staff_operations(request_id,actor_id,email,full_name,courses,batches,role,exams)
 VALUES(p_request,p_actor,p_email,btrim(p_name),'{}','{}','creator',p_exams) ON CONFLICT DO NOTHING RETURNING * INTO o;
 IF FOUND THEN RETURN jsonb_build_object('state',o.state,'target_id',o.target_id); END IF;
 SELECT * INTO o FROM ksc_private.staff_operations WHERE request_id=p_request FOR UPDATE;
 IF o.actor_id<>p_actor OR o.email<>p_email OR o.full_name<>btrim(p_name) OR o.role<>'creator' OR o.exams<>p_exams
 THEN RAISE EXCEPTION 'Request changed. Start a new account operation'; END IF;
 IF o.state='prepared' THEN
 IF o.operation_started_at>now()-interval '2 minutes' THEN RAISE EXCEPTION 'Account creation is already running. Wait two minutes before retrying'; END IF;
 UPDATE ksc_private.staff_operations SET operation_started_at=now() WHERE request_id=p_request;
 END IF;
 RETURN jsonb_build_object('state',o.state,'target_id',o.target_id);
END $$;
CREATE OR REPLACE FUNCTION public.ksc_staff_complete_create(p_actor uuid,p_request uuid,p_target uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
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
 IF o.role='creator' THEN
 PERFORM ksc_private.validate_creator_exams(o.exams,true);
 INSERT INTO public.ksc_staff_access(user_id,full_name,role,password_change_required,temporary_expires_at)
 VALUES(p_target,o.full_name,'creator',true,now()+interval '24 hours');
 INSERT INTO public.ksc_creator_exams SELECT p_target,x FROM (SELECT DISTINCT unnest(o.exams) x) q;
 INSERT INTO public.ksc_staff_audit(actor_id,target_id,action,detail) VALUES(p_actor,p_target,'creator_created',jsonb_build_object('exams',o.exams));
 ELSE
 PERFORM ksc_private.validate_assignments(o.courses,o.batches);
 INSERT INTO public.teacher_profiles(id,full_name,role) VALUES(p_target,o.full_name,'teacher') ON CONFLICT(id) DO NOTHING;
 INSERT INTO public.ksc_staff_access(user_id,full_name,role,password_change_required,temporary_expires_at)
 VALUES(p_target,o.full_name,'teacher',true,now()+interval '24 hours');
 INSERT INTO public.ksc_staff_memberships(institute_id,user_id) VALUES('00000000-0000-4000-8000-000000000001',p_target) ON CONFLICT DO NOTHING;
 INSERT INTO public.ksc_teacher_courses SELECT p_target,c FROM (SELECT DISTINCT unnest(o.courses) c) q;
 INSERT INTO public.ksc_teacher_batches SELECT p_target,b FROM (SELECT DISTINCT unnest(o.batches) b) q;
 INSERT INTO public.ksc_staff_audit(actor_id,target_id,action) VALUES(p_actor,p_target,'teacher_created');
 END IF;
 UPDATE ksc_private.staff_operations SET state='complete',target_id=p_target WHERE request_id=p_request;
 RETURN jsonb_build_object('id',p_target,'created',true);
END $$;
CREATE OR REPLACE FUNCTION public.ksc_staff_list() RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
 SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 PERFORM ksc_private.require_admin(auth.uid());
 RETURN coalesce((SELECT jsonb_agg(jsonb_build_object('id',s.user_id,'name',s.full_name,'email',u.email,
 'role',s.role,'state',s.state,'password_change_required',s.password_change_required,'version',s.version,
 'exams',(SELECT coalesce(jsonb_agg(exam_id),'[]') FROM public.ksc_creator_exams WHERE user_id=s.user_id),
 'courses',(SELECT coalesce(jsonb_agg(course_id),'[]') FROM public.ksc_teacher_courses WHERE user_id=s.user_id),
 'batches',(SELECT coalesce(jsonb_agg(batch_id),'[]') FROM public.ksc_teacher_batches WHERE user_id=s.user_id))
 ORDER BY lower(s.full_name)) FROM public.ksc_staff_access s JOIN auth.users u ON u.id=s.user_id),'[]');
END $$;
CREATE OR REPLACE FUNCTION public.ksc_staff_set_state(p_user uuid,p_state text,p_version integer) RETURNS void LANGUAGE plpgsql SECURITY DEFINER
 SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE s public.ksc_staff_access;
BEGIN
 -- Serialize admin-state changes and protect the last active administrator.
 PERFORM pg_advisory_xact_lock(736036);
 PERFORM ksc_private.require_admin(auth.uid());
 SELECT * INTO s FROM public.ksc_staff_access WHERE user_id=p_user FOR UPDATE;
 IF NOT FOUND OR s.version<>p_version THEN RAISE EXCEPTION 'Account changed. Refresh and try again'; END IF;
 IF p_state NOT IN('active','suspended') OR p_user=auth.uid() OR s.role='admin' THEN
 RAISE EXCEPTION 'Only another staff account can be suspended or restored here'; END IF;
 UPDATE public.ksc_staff_access SET state=p_state,version=version+1,updated_at=now() WHERE user_id=p_user;
 INSERT INTO public.ksc_staff_audit(actor_id,target_id,action) VALUES(auth.uid(),p_user,'state_'||p_state);
END $$;
CREATE OR REPLACE FUNCTION public.ksc_staff_password_gate(p_actor uuid,p_target uuid,p_reset boolean,p_version integer DEFAULT NULL) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
 SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE s public.ksc_staff_access; BEGIN
 IF p_reset THEN PERFORM ksc_private.require_admin(p_actor); ELSE
 IF p_actor IS DISTINCT FROM p_target THEN RAISE EXCEPTION 'Own account required'; END IF; END IF;
 SELECT * INTO s FROM public.ksc_staff_access WHERE user_id=p_target FOR UPDATE;
 IF NOT FOUND OR s.state<>'active' THEN RAISE EXCEPTION 'Active staff account required'; END IF;
 IF s.password_operation_started_at > now()-interval '2 minutes' THEN RAISE EXCEPTION 'A password operation is already running. Wait two minutes before retrying'; END IF;
 IF p_reset THEN
 IF s.role NOT IN('teacher','creator') OR s.user_id=p_actor OR s.version IS DISTINCT FROM p_version THEN RAISE EXCEPTION 'Account changed. Refresh first'; END IF;
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
CREATE OR REPLACE FUNCTION public.ksc_staff_password_release(p_actor uuid,p_target uuid,p_version integer) RETURNS void LANGUAGE plpgsql SECURITY DEFINER
 SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 PERFORM ksc_private.require_admin(p_actor);
 UPDATE public.ksc_staff_access SET password_operation_started_at=NULL WHERE user_id=p_target AND version=p_version AND role IN('teacher','creator');
 IF NOT FOUND THEN RAISE EXCEPTION 'Account changed. Refresh and retry'; END IF;
 INSERT INTO public.ksc_staff_audit(actor_id,target_id,action) VALUES(p_actor,p_target,'temporary_password_issued');
END $$;
CREATE OR REPLACE FUNCTION public.ksc_creator_grant_existing(p_user uuid,p_email text,p_name text,p_exams uuid[]) RETURNS void LANGUAGE plpgsql SECURITY DEFINER
 SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 PERFORM ksc_private.require_admin(auth.uid());
 PERFORM ksc_private.validate_creator_exams(p_exams,true);
 PERFORM 1 FROM auth.users WHERE id=p_user AND lower(email)=lower(btrim(p_email)) AND email_confirmed_at IS NOT NULL FOR UPDATE;
 IF NOT FOUND OR EXISTS(SELECT 1 FROM public.ksc_staff_access WHERE user_id=p_user) OR p_name IS NULL OR length(btrim(p_name))>120 OR btrim(p_name)=''
 OR EXISTS(SELECT 1 FROM auth.users WHERE id=p_user AND raw_app_meta_data ? 'ksc_staff_request') THEN
 RAISE EXCEPTION 'Use a confirmed existing account without staff access'; END IF;
 INSERT INTO public.ksc_staff_access(user_id,full_name,role,password_change_required) VALUES(p_user,btrim(p_name),'creator',false);
 INSERT INTO public.ksc_creator_exams SELECT p_user,x FROM (SELECT DISTINCT unnest(p_exams) x) q;
 INSERT INTO public.ksc_staff_audit(actor_id,target_id,action,detail) VALUES(auth.uid(),p_user,'existing_creator_granted',jsonb_build_object('exams',p_exams));
END $$;
REVOKE ALL ON FUNCTION ksc_private.validate_creator_exams(uuid[],boolean) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.ksc_creator_begin_create(uuid,uuid,text,text,uuid[]) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.ksc_creator_begin_create(uuid,uuid,text,text,uuid[]) TO service_role;
REVOKE ALL ON FUNCTION public.ksc_creator_setup(),public.ksc_my_creator_exams(),public.ksc_creator_assign(uuid,uuid[],integer),public.ksc_creator_grant_existing(uuid,text,text,uuid[]) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.ksc_creator_setup(),public.ksc_my_creator_exams(),public.ksc_creator_assign(uuid,uuid[],integer),public.ksc_creator_grant_existing(uuid,text,text,uuid[]) TO authenticated;
COMMIT;
