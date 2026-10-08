-- KSC course delivery extension. Apply after 0011, only on the isolated KSC project.
DO $$ BEGIN
 IF to_regprocedure('public.ksc_create_test(jsonb)') IS NULL OR to_regclass('public.organizations') IS NOT NULL THEN RAISE EXCEPTION 'Expected KSC authoring baseline'; END IF;
END $$;
CREATE TABLE public.ksc_institutes(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),name text NOT NULL);
CREATE TABLE public.ksc_staff_memberships(institute_id uuid REFERENCES public.ksc_institutes(id),user_id uuid REFERENCES public.teacher_profiles(id),PRIMARY KEY(institute_id,user_id));
CREATE TABLE public.ksc_courses(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),institute_id uuid NOT NULL REFERENCES public.ksc_institutes(id),name text NOT NULL CHECK(btrim(name)<>''),description text NOT NULL DEFAULT '',created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE public.ksc_batches(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),course_id uuid NOT NULL REFERENCES public.ksc_courses(id),name text NOT NULL CHECK(btrim(name)<>''),created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE public.ksc_enrollments(batch_id uuid REFERENCES public.ksc_batches(id),student_id uuid REFERENCES public.student_profiles(id),created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(batch_id,student_id));
CREATE TABLE public.ksc_lessons(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),course_id uuid NOT NULL REFERENCES public.ksc_courses(id),title text NOT NULL CHECK(btrim(title)<>''),body text NOT NULL DEFAULT '',sort_order integer NOT NULL DEFAULT 0,is_published boolean NOT NULL DEFAULT false,updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE public.ksc_lesson_completions(lesson_id uuid REFERENCES public.ksc_lessons(id),student_id uuid REFERENCES public.student_profiles(id),completed_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(lesson_id,student_id));
INSERT INTO public.ksc_institutes(id,name) VALUES('00000000-0000-4000-8000-000000000001','AaryaRushi Education');
-- Existing global KSC teachers become staff only in this initial institute.
INSERT INTO public.ksc_staff_memberships SELECT '00000000-0000-4000-8000-000000000001',id FROM public.teacher_profiles;
CREATE FUNCTION public.ksc_manages_course(p_course uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT auth.uid() IS NOT NULL AND public.is_teacher() AND EXISTS(SELECT 1 FROM public.ksc_courses c JOIN public.ksc_staff_memberships m ON m.institute_id=c.institute_id WHERE c.id=p_course AND m.user_id=auth.uid());
$$;
CREATE FUNCTION public.ksc_learns_course(p_course uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT auth.uid() IS NOT NULL AND EXISTS(SELECT 1 FROM public.ksc_batches b JOIN public.ksc_enrollments e ON e.batch_id=b.id WHERE b.course_id=p_course AND e.student_id=auth.uid());
$$;
ALTER TABLE public.ksc_institutes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ksc_staff_memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ksc_courses ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ksc_batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ksc_enrollments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ksc_lessons ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ksc_lesson_completions ENABLE ROW LEVEL SECURITY;
CREATE POLICY own_staff_membership ON public.ksc_staff_memberships FOR SELECT TO authenticated USING(user_id=auth.uid());
CREATE POLICY staff_institute ON public.ksc_institutes FOR SELECT TO authenticated USING(EXISTS(SELECT 1 FROM public.ksc_staff_memberships m WHERE m.institute_id=id AND m.user_id=auth.uid()));
CREATE POLICY accessible_course ON public.ksc_courses FOR SELECT TO authenticated USING(public.ksc_manages_course(id) OR public.ksc_learns_course(id));
CREATE POLICY accessible_batch ON public.ksc_batches FOR SELECT TO authenticated USING(public.ksc_manages_course(course_id) OR EXISTS(SELECT 1 FROM public.ksc_enrollments e WHERE e.batch_id=id AND e.student_id=auth.uid()));
-- Avoid policy recursion by resolving the batch's course through an owner helper.
CREATE FUNCTION public.ksc_manages_batch(p_batch uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$ SELECT public.ksc_manages_course(course_id) FROM public.ksc_batches WHERE id=p_batch $$;
CREATE POLICY accessible_enrollment ON public.ksc_enrollments FOR SELECT TO authenticated USING(student_id=auth.uid() OR public.ksc_manages_batch(batch_id));
CREATE POLICY accessible_lesson ON public.ksc_lessons FOR SELECT TO authenticated USING(public.ksc_manages_course(course_id) OR (is_published AND public.ksc_learns_course(course_id)));
CREATE FUNCTION public.ksc_manages_lesson(p_lesson uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$ SELECT public.ksc_manages_course(course_id) FROM public.ksc_lessons WHERE id=p_lesson $$;
CREATE POLICY accessible_completion ON public.ksc_lesson_completions FOR SELECT TO authenticated USING(student_id=auth.uid() OR public.ksc_manages_lesson(lesson_id));
CREATE FUNCTION public.ksc_create_course(p_institute uuid,p_name text,p_description text) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE result uuid; BEGIN
 IF auth.uid() IS NULL OR NOT public.is_teacher() OR NOT EXISTS(SELECT 1 FROM public.ksc_staff_memberships WHERE institute_id=p_institute AND user_id=auth.uid()) THEN RAISE EXCEPTION 'Institute staff access required'; END IF;
 INSERT INTO public.ksc_courses(institute_id,name,description) VALUES(p_institute,btrim(p_name),coalesce(p_description,'')) RETURNING id INTO result; RETURN result;
END $$;
CREATE FUNCTION public.ksc_create_batch(p_course uuid,p_name text) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE result uuid; BEGIN
 IF NOT coalesce(public.ksc_manages_course(p_course),false) THEN RAISE EXCEPTION 'Course staff access required'; END IF;
 INSERT INTO public.ksc_batches(course_id,name) VALUES(p_course,btrim(p_name)) RETURNING id INTO result; RETURN result;
END $$;
CREATE FUNCTION public.ksc_enroll_student(p_batch uuid,p_email text,p_remove boolean DEFAULT false) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE learner uuid; BEGIN
 IF NOT coalesce(public.ksc_manages_batch(p_batch),false) THEN RAISE EXCEPTION 'Batch staff access required'; END IF;
 SELECT s.id INTO learner FROM public.student_profiles s JOIN auth.users u ON u.id=s.id WHERE lower(u.email)=lower(btrim(p_email)) AND u.email_confirmed_at IS NOT NULL;
 IF learner IS NULL THEN RAISE EXCEPTION 'No confirmed learner account matches this email'; END IF;
 IF p_remove THEN DELETE FROM public.ksc_enrollments WHERE batch_id=p_batch AND student_id=learner;
 ELSE INSERT INTO public.ksc_enrollments(batch_id,student_id) VALUES(p_batch,learner) ON CONFLICT DO NOTHING; END IF;
END $$;
CREATE FUNCTION public.ksc_save_lesson(p_id uuid,p_course uuid,p_title text,p_body text,p_order integer,p_published boolean) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE result uuid; BEGIN
 IF NOT coalesce(public.ksc_manages_course(p_course),false) THEN RAISE EXCEPTION 'Course staff access required'; END IF;
 IF p_published AND coalesce(btrim(p_body),'')='' THEN RAISE EXCEPTION 'Add lesson content before publishing'; END IF;
 IF p_id IS NULL THEN INSERT INTO public.ksc_lessons(course_id,title,body,sort_order,is_published) VALUES(p_course,btrim(p_title),coalesce(p_body,''),coalesce(p_order,0),coalesce(p_published,false)) RETURNING id INTO result;
 ELSE UPDATE public.ksc_lessons SET title=btrim(p_title),body=coalesce(p_body,''),sort_order=coalesce(p_order,0),is_published=coalesce(p_published,false),updated_at=now() WHERE id=p_id AND course_id=p_course RETURNING id INTO result;
 IF result IS NULL THEN RAISE EXCEPTION 'Lesson not found in this course'; END IF; END IF; RETURN result;
END $$;
CREATE FUNCTION public.ksc_complete_lesson(p_lesson uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE course uuid; BEGIN
 SELECT course_id INTO course FROM public.ksc_lessons WHERE id=p_lesson AND is_published FOR SHARE;
 IF course IS NULL OR NOT coalesce(public.ksc_learns_course(course),false) THEN RAISE EXCEPTION 'Published enrolled lesson required'; END IF;
 INSERT INTO public.ksc_lesson_completions(lesson_id,student_id) VALUES(p_lesson,auth.uid()) ON CONFLICT DO NOTHING;
END $$;
REVOKE ALL ON public.ksc_institutes,public.ksc_staff_memberships,public.ksc_courses,public.ksc_batches,public.ksc_enrollments,public.ksc_lessons,public.ksc_lesson_completions FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON public.ksc_institutes,public.ksc_staff_memberships,public.ksc_courses,public.ksc_batches,public.ksc_enrollments,public.ksc_lessons,public.ksc_lesson_completions TO authenticated;
DO $$ DECLARE f regprocedure; BEGIN
 FOR f IN SELECT p.oid::regprocedure FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname IN ('ksc_manages_course','ksc_learns_course','ksc_manages_batch','ksc_manages_lesson','ksc_create_course','ksc_create_batch','ksc_enroll_student','ksc_save_lesson','ksc_complete_lesson') LOOP
 EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,anon,authenticated,service_role',f); EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated',f);
 END LOOP;
END $$;
