-- Enrollment stays admin-only; staff accounts are never silently enrolled as learners.
BEGIN;
CREATE OR REPLACE FUNCTION public.ksc_enroll_student(p_batch uuid,p_email text,p_remove boolean DEFAULT false) RETURNS void LANGUAGE plpgsql SECURITY DEFINER
 SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE learner uuid; BEGIN
 IF NOT public.ksc_is_admin() THEN RAISE EXCEPTION 'Administrator access required'; END IF;
 IF p_remove IS NULL OR NOT EXISTS(SELECT 1 FROM public.ksc_batches WHERE id=p_batch) THEN RAISE EXCEPTION 'Valid batch and enrollment action required'; END IF;
 SELECT s.id INTO learner FROM public.student_profiles s JOIN auth.users u ON u.id=s.id
 WHERE lower(u.email)=lower(btrim(p_email)) AND u.email_confirmed_at IS NOT NULL;
 IF learner IS NULL THEN RAISE EXCEPTION 'No confirmed learner account matches this email'; END IF;
 IF NOT p_remove AND EXISTS(SELECT 1 FROM public.ksc_staff_access WHERE user_id=learner AND role IN('admin','teacher','creator'))
 THEN RAISE EXCEPTION 'A staff account cannot be enrolled as a student'; END IF;
 IF p_remove THEN DELETE FROM public.ksc_enrollments WHERE batch_id=p_batch AND student_id=learner;
 ELSE INSERT INTO public.ksc_enrollments(batch_id,student_id) VALUES(p_batch,learner) ON CONFLICT DO NOTHING; END IF;
 INSERT INTO public.ksc_staff_audit(actor_id,target_id,action,detail) VALUES(auth.uid(),learner,
 CASE WHEN p_remove THEN 'student_enrollment_removed' ELSE 'student_enrolled' END,jsonb_build_object('batch_id',p_batch));
END $$;
NOTIFY pgrst, 'reload schema';
COMMIT;
