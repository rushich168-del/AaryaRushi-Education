-- Open Navodaya (JNV entrance) for student sign-up under School & Military Entrance (2026-10-07).
-- Data only: adds the Class VI and Class IX tracks, hides the placeholder "Default" track from sign-up
-- (it stays active for any existing history), and enables the program. Safe to run more than once.
BEGIN;
DO $$ DECLARE cat uuid; eid uuid; BEGIN
 IF to_regclass('public.ksc_signup_programs') IS NULL THEN RAISE EXCEPTION 'Expected KSC sign-up programs (0038/0039) baseline'; END IF;
 SELECT id INTO cat FROM public.program_categories WHERE slug='school-military';
 IF cat IS NULL THEN RAISE EXCEPTION 'School & Military Entrance category is missing'; END IF;
 SELECT id INTO eid FROM public.exams WHERE slug='navodaya' OR lower(name)='navodaya' ORDER BY (slug='navodaya') DESC LIMIT 1;
 IF eid IS NULL THEN
  INSERT INTO public.exams(name,slug,category_id,is_active) VALUES('Navodaya','navodaya',cat,true) RETURNING id INTO eid;
 ELSE
  UPDATE public.exams SET category_id=cat,is_active=true WHERE id=eid;
 END IF;
 INSERT INTO public.exam_levels(exam_id,name,display_order) VALUES(eid,'Class VI',1),(eid,'Class IX',2) ON CONFLICT(exam_id,name) DO NOTHING;
 UPDATE public.exam_levels SET is_active=true,is_signup_enabled=true WHERE exam_id=eid AND name IN('Class VI','Class IX');
 UPDATE public.exam_levels SET is_signup_enabled=false WHERE exam_id=eid AND name='Default';
 INSERT INTO public.ksc_signup_programs(exam_id,enabled) VALUES(eid,true) ON CONFLICT(exam_id) DO UPDATE SET enabled=true;
END $$;
COMMIT;
