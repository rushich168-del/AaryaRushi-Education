-- Forward-only KSC Test Portal extension, after 0012. Run transactionally.
DO $$ BEGIN
 IF to_regclass('public.ksc_courses') IS NULL OR to_regclass('public.organizations') IS NOT NULL
 OR to_regprocedure('public.ksc_create_test(jsonb)') IS NULL THEN RAISE EXCEPTION 'Expected isolated KSC LMS baseline'; END IF;
END $$;

CREATE TABLE public.program_categories (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text NOT NULL CHECK(btrim(name)<>''),
 slug text NOT NULL UNIQUE CHECK(btrim(slug)<>''), display_order integer NOT NULL DEFAULT 0,
 is_active boolean NOT NULL DEFAULT true
);
ALTER TABLE public.program_categories ENABLE ROW LEVEL SECURITY;
CREATE POLICY category_read ON public.program_categories FOR SELECT TO authenticated USING(is_active OR public.is_teacher());
CREATE POLICY category_staff ON public.program_categories FOR ALL TO authenticated USING(public.is_teacher()) WITH CHECK(public.is_teacher());
REVOKE ALL ON public.program_categories FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT,INSERT,UPDATE,DELETE ON public.program_categories TO authenticated;
ALTER TABLE public.exams ADD COLUMN category_id uuid REFERENCES public.program_categories(id) ON DELETE RESTRICT;
CREATE INDEX exams_category ON public.exams(category_id);

-- Membership remains the existing course/batch enrollment. These are curriculum links, not test entitlements.
CREATE TABLE public.ksc_course_tracks (
 course_id uuid REFERENCES public.ksc_courses(id) ON DELETE CASCADE,
 level_id uuid REFERENCES public.exam_levels(id) ON DELETE RESTRICT,
 PRIMARY KEY(course_id,level_id)
);
ALTER TABLE public.ksc_course_tracks ENABLE ROW LEVEL SECURITY;
CREATE POLICY course_track_read ON public.ksc_course_tracks FOR SELECT TO authenticated
 USING(public.ksc_manages_course(course_id) OR public.ksc_learns_course(course_id));
CREATE POLICY course_track_staff ON public.ksc_course_tracks FOR ALL TO authenticated
 USING(public.ksc_manages_course(course_id)) WITH CHECK(public.ksc_manages_course(course_id));
REVOKE ALL ON public.ksc_course_tracks FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT,INSERT,DELETE ON public.ksc_course_tracks TO authenticated;

ALTER TABLE public.tests ADD COLUMN level_id uuid REFERENCES public.exam_levels(id) ON DELETE RESTRICT,
 ADD COLUMN level_name text, ADD COLUMN category_name text, ADD COLUMN category_id uuid,
 ADD COLUMN test_kind text NOT NULL DEFAULT 'GENERAL'
 CHECK(test_kind IN ('GENERAL','FULL_MOCK','SUBJECT','CHAPTER','MODEL','PREVIOUS'));
CREATE INDEX tests_portal_context ON public.tests(exam_id,level_id,test_kind) WHERE is_published;

-- Syllabi are the existing track/subject association. Prevent cross-exam ancestry and reparenting.
CREATE FUNCTION public.ksc_guard_curriculum() RETURNS trigger LANGUAGE plpgsql
 SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF TG_TABLE_NAME='syllabi' THEN
  IF NOT EXISTS(SELECT 1 FROM public.exam_levels WHERE id=NEW.level_id AND exam_id=NEW.exam_id)
   OR NOT EXISTS(SELECT 1 FROM public.exam_subjects WHERE id=NEW.subject_id AND exam_id=NEW.exam_id)
  THEN RAISE EXCEPTION 'Syllabus track and subject must belong to the exam'; END IF;
 END IF;
 IF TG_OP='UPDATE' AND (
  (TG_TABLE_NAME IN ('exam_levels','exam_subjects') AND to_jsonb(NEW)->'exam_id' IS DISTINCT FROM to_jsonb(OLD)->'exam_id') OR
  (TG_TABLE_NAME='syllabi' AND (to_jsonb(NEW)-ARRAY['name','description','status','updated_at']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['name','description','status','updated_at'])) OR
  (TG_TABLE_NAME='chapters' AND to_jsonb(NEW)->'syllabus_id' IS DISTINCT FROM to_jsonb(OLD)->'syllabus_id') OR
  (TG_TABLE_NAME='topics' AND to_jsonb(NEW)->'chapter_id' IS DISTINCT FROM to_jsonb(OLD)->'chapter_id'))
 THEN RAISE EXCEPTION 'Create a new curriculum entry instead of reparenting existing content'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER portal_level_parent BEFORE UPDATE ON public.exam_levels FOR EACH ROW EXECUTE FUNCTION public.ksc_guard_curriculum();
CREATE TRIGGER portal_subject_parent BEFORE UPDATE ON public.exam_subjects FOR EACH ROW EXECUTE FUNCTION public.ksc_guard_curriculum();
CREATE TRIGGER portal_syllabus_parent BEFORE INSERT OR UPDATE ON public.syllabi FOR EACH ROW EXECUTE FUNCTION public.ksc_guard_curriculum();
CREATE TRIGGER portal_chapter_parent BEFORE UPDATE ON public.chapters FOR EACH ROW EXECUTE FUNCTION public.ksc_guard_curriculum();
CREATE TRIGGER portal_topic_parent BEFORE UPDATE ON public.topics FOR EACH ROW EXECUTE FUNCTION public.ksc_guard_curriculum();

-- Runs within the existing publisher transaction, after its source locks and before final publication.
-- Existing published rows are never backfilled; old unknown context stays NULL.
CREATE FUNCTION public.ksc_guard_test_context() RETURNS trigger LANGUAGE plpgsql
 SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE pat public.exam_patterns;
BEGIN
 IF TG_OP='UPDATE' AND OLD.is_published THEN RETURN NEW; END IF;
 SELECT * INTO pat FROM public.exam_patterns WHERE id=NEW.pattern_id;
 IF TG_OP='INSERT' THEN NEW.level_id:=pat.level_id; END IF;
 IF (NEW.level_id IS NOT NULL OR pat.level_id IS NOT NULL) AND (pat.exam_id IS DISTINCT FROM NEW.exam_id OR pat.level_id IS DISTINCT FROM NEW.level_id)
 THEN RAISE EXCEPTION 'Test track must match the selected pattern'; END IF;
 IF TG_OP='UPDATE' AND NEW.is_published AND NOT OLD.is_published THEN
  -- Untagged historical drafts retain compatibility, but new track tests must be complete.
  IF NEW.level_id IS NOT NULL THEN
   IF NOT EXISTS(SELECT 1 FROM public.exam_levels WHERE id=NEW.level_id AND exam_id=NEW.exam_id AND is_active)
   THEN RAISE EXCEPTION 'Active matching track required'; END IF;
   IF EXISTS(SELECT 1 FROM public.test_questions tq JOIN public.questions q ON q.id=tq.question_id
     WHERE tq.test_id=NEW.id AND q.level_id IS DISTINCT FROM NEW.level_id)
   THEN RAISE EXCEPTION 'Every question must match the test track'; END IF;
   IF NOT EXISTS(SELECT 1 FROM public.exam_pattern_sections WHERE pattern_id=NEW.pattern_id) OR EXISTS(
    SELECT 1 FROM public.exam_pattern_sections s WHERE s.pattern_id=NEW.pattern_id AND
     (s.question_count<=0 OR s.question_count IS DISTINCT FROM (SELECT count(*)::integer FROM public.test_questions tq WHERE tq.test_id=NEW.id AND tq.section_id=s.id)))
   THEN RAISE EXCEPTION 'Section question counts must match the pattern'; END IF;
  END IF;
  NEW.level_name:=(SELECT name FROM public.exam_levels WHERE id=NEW.level_id);
  SELECT e.category_id,c.name INTO NEW.category_id,NEW.category_name FROM public.exams e
    LEFT JOIN public.program_categories c ON c.id=e.category_id WHERE e.id=NEW.exam_id;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER portal_test_context BEFORE INSERT OR UPDATE ON public.tests FOR EACH ROW EXECUTE FUNCTION public.ksc_guard_test_context();
REVOKE ALL ON FUNCTION public.ksc_guard_curriculum(),public.ksc_guard_test_context() FROM PUBLIC,anon,authenticated,service_role;

-- Product catalogue only: no official patterns, counts, durations, eligibility or claims.
INSERT INTO public.program_categories(name,slug,display_order) VALUES
 ('School & Military Entrance','school-military',1),('Engineering & Medical Entrance','engineering-medical',2),('Government Exams','government',3);
DO $$ DECLARE r record; eid uuid; BEGIN
 FOR r IN SELECT * FROM (VALUES
 ('school-military','navodaya','Navodaya',ARRAY['Default']),
 ('school-military','sainik-school','Sainik',ARRAY['Class VI','Class IX']),
 ('school-military','rms','RMS',ARRAY['Class VI','Class IX']),
 ('school-military','rimc','RIMC',ARRAY['Class VIII']),
 ('engineering-medical','eamcet','EAMCET',ARRAY['Engineering','Agriculture/Pharmacy']),
 ('engineering-medical','neet','NEET',ARRAY['UG']),
 ('engineering-medical','jee-main','JEE Main',ARRAY['Default']),
 ('government','dsc','DSC',ARRAY['Default']),
 ('government','si-constable','SI & Constable',ARRAY['Default']),
 ('government','ssc-rrb','SSC/RRB',ARRAY['Default']),
 ('government','group-ii','Group-II',ARRAY['Default'])
 ) AS seed(category,slug,name,tracks) LOOP
  SELECT id INTO eid FROM public.exams WHERE slug=r.slug OR lower(name)=lower(r.name) ORDER BY (slug=r.slug) DESC LIMIT 1;
  IF eid IS NULL THEN INSERT INTO public.exams(name,slug,category_id) VALUES(r.name,r.slug,(SELECT id FROM public.program_categories WHERE slug=r.category)) RETURNING id INTO eid;
  ELSE UPDATE public.exams SET category_id=(SELECT id FROM public.program_categories WHERE slug=r.category) WHERE id=eid AND category_id IS NULL; END IF;
  INSERT INTO public.exam_levels(exam_id,name,display_order) SELECT eid,t.name,t.ord::integer FROM unnest(r.tracks) WITH ORDINALITY AS t(name,ord) ON CONFLICT(exam_id,name) DO NOTHING;
 END LOOP;
END $$;

-- Extend existing atomic invoker RPCs, preserving signatures and RLS.
CREATE OR REPLACE FUNCTION public.ksc_save_question(p_id uuid, p_question jsonb, p_options jsonb, p_correct_index integer)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE q public.questions; option_id uuid; chosen uuid; opt jsonb; position integer:=0;
BEGIN
 IF auth.uid() IS NULL OR NOT public.is_teacher() THEN RAISE EXCEPTION 'Teacher access required'; END IF;
 IF jsonb_typeof(p_options) IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'Options must be an array'; END IF;
 IF jsonb_array_length(p_options)<2 OR jsonb_array_length(p_options)>10 OR p_correct_index IS NULL
 OR p_correct_index<0 OR p_correct_index>=jsonb_array_length(p_options)
 OR coalesce(btrim(p_question->>'content'),'')='' THEN RAISE EXCEPTION 'Question, options and correct answer are required'; END IF;
 IF NOT EXISTS (SELECT 1 FROM public.exam_subjects WHERE id=(p_question->>'subject_id')::uuid AND exam_id=(p_question->>'exam_id')::uuid)
 THEN RAISE EXCEPTION 'Subject must belong to the selected exam'; END IF;
 IF coalesce(p_question->>'difficulty','MEDIUM') NOT IN ('EASY','MEDIUM','HARD') THEN RAISE EXCEPTION 'Invalid difficulty'; END IF;
 IF p_id IS NULL THEN
  INSERT INTO public.questions(exam_id,subject_id,content,explanation,difficulty,question_type,status,source_reference,created_by,level_id,syllabus_id,chapter_id,topic_id)
  VALUES((p_question->>'exam_id')::uuid,(p_question->>'subject_id')::uuid,p_question->>'content',p_question->>'explanation',
   coalesce(p_question->>'difficulty','MEDIUM'),'MCQ','DRAFT','MANUAL',auth.uid(),(p_question->>'level_id')::uuid,(p_question->>'syllabus_id')::uuid,(p_question->>'chapter_id')::uuid,(p_question->>'topic_id')::uuid) RETURNING * INTO q;
 ELSE
  SELECT * INTO q FROM public.questions WHERE id=p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Question not found'; END IF;
  -- This editor has no hierarchy controls: preserve tags and reject silent reparenting.
  IF NOT (p_question ? 'level_id') AND (q.topic_id IS NOT NULL OR q.legacy_topic_id IS NOT NULL OR q.chapter_id IS NOT NULL OR q.syllabus_id IS NOT NULL)
    AND (q.exam_id IS DISTINCT FROM (p_question->>'exam_id')::uuid OR q.subject_id IS DISTINCT FROM (p_question->>'subject_id')::uuid)
  THEN RAISE EXCEPTION 'Tagged question cannot change exam or subject in this editor'; END IF;
  UPDATE public.questions SET exam_id=(p_question->>'exam_id')::uuid,subject_id=(p_question->>'subject_id')::uuid,
   content=p_question->>'content',explanation=p_question->>'explanation',difficulty=coalesce(p_question->>'difficulty','MEDIUM'),
   level_id=CASE WHEN p_question ? 'level_id' THEN (p_question->>'level_id')::uuid ELSE q.level_id END,
   syllabus_id=CASE WHEN p_question ? 'syllabus_id' THEN (p_question->>'syllabus_id')::uuid ELSE q.syllabus_id END,
   chapter_id=CASE WHEN p_question ? 'chapter_id' THEN (p_question->>'chapter_id')::uuid ELSE q.chapter_id END,
   topic_id=CASE WHEN p_question ? 'topic_id' THEN (p_question->>'topic_id')::uuid ELSE q.topic_id END,
   question_type='MCQ',status='DRAFT',updated_at=now() WHERE id=p_id RETURNING * INTO q;
  DELETE FROM public.question_answer_keys WHERE question_id=q.id;
  DELETE FROM public.question_options WHERE question_id=q.id;
 END IF;
 FOR opt IN SELECT value FROM jsonb_array_elements(p_options) LOOP
  IF jsonb_typeof(opt)<>'string' OR btrim(opt#>>'{}')='' THEN RAISE EXCEPTION 'Every option must contain text'; END IF;
  INSERT INTO public.question_options(question_id,content,sort_order) VALUES(q.id,opt#>>'{}',position) RETURNING id INTO option_id;
  IF position=p_correct_index THEN chosen:=option_id; END IF;
  position:=position+1;
 END LOOP;
 INSERT INTO public.question_answer_keys(question_id,correct_option_id) VALUES(q.id,chosen);
 RETURN to_jsonb(q);
END $$;

CREATE OR REPLACE FUNCTION public.ksc_create_pattern(p_pattern jsonb,p_sections jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE pat public.exam_patterns; sec jsonb; position integer:=0; total integer:=0;
BEGIN
 IF auth.uid() IS NULL OR NOT public.is_teacher() THEN RAISE EXCEPTION 'Teacher access required'; END IF;
 IF jsonb_typeof(p_sections) IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'Sections required'; END IF;
 IF jsonb_array_length(p_sections)=0 OR coalesce(btrim(p_pattern->>'name'),'')=''
 OR coalesce((p_pattern->>'total_duration_minutes')::integer,0)<=0 THEN RAISE EXCEPTION 'Name, positive duration and sections required'; END IF;
 INSERT INTO public.exam_patterns(exam_id,name,description,total_duration_minutes,total_marks,status,level_id)
 VALUES((p_pattern->>'exam_id')::uuid,p_pattern->>'name',p_pattern->>'description',(p_pattern->>'total_duration_minutes')::integer,0,'DRAFT',(p_pattern->>'level_id')::uuid) RETURNING * INTO pat;
 FOR sec IN SELECT value FROM jsonb_array_elements(p_sections) LOOP
  IF NOT EXISTS (SELECT 1 FROM public.exam_subjects WHERE id=(sec->>'subject_id')::uuid AND exam_id=pat.exam_id)
  OR coalesce(btrim(sec->>'section_name'),'')='' OR coalesce((sec->>'question_count')::integer,0)<=0
  OR coalesce((sec->>'marks_per_question')::integer,0)<=0 OR coalesce((sec->>'negative_marks')::numeric,0)<0
  THEN RAISE EXCEPTION 'Invalid section or subject/exam relationship'; END IF;
  INSERT INTO public.exam_pattern_sections(pattern_id,subject_id,section_name,display_order,question_count,marks_per_question,negative_marks)
  VALUES(pat.id,(sec->>'subject_id')::uuid,sec->>'section_name',position,(sec->>'question_count')::integer,
   (sec->>'marks_per_question')::integer,coalesce((sec->>'negative_marks')::numeric,0));
  total:=total+(sec->>'question_count')::integer*(sec->>'marks_per_question')::integer; position:=position+1;
 END LOOP;
 UPDATE public.exam_patterns SET total_marks=total WHERE id=pat.id RETURNING * INTO pat;
 RETURN to_jsonb(pat);
END $$;

CREATE OR REPLACE FUNCTION public.ksc_create_test(p_test jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE pat public.exam_patterns; result public.tests;
BEGIN
 IF auth.uid() IS NULL OR NOT public.is_teacher() THEN RAISE EXCEPTION 'Teacher access required'; END IF;
 SELECT * INTO pat FROM public.exam_patterns WHERE id=(p_test->>'pattern_id')::uuid FOR SHARE;
 IF NOT FOUND OR pat.status IS DISTINCT FROM 'ACTIVE' OR pat.exam_id IS DISTINCT FROM (p_test->>'exam_id')::uuid
 OR coalesce(btrim(p_test->>'name'),'')='' OR coalesce(pat.total_duration_minutes,0)<=0 THEN RAISE EXCEPTION 'Choose an active pattern with duration and matching exam'; END IF;
 INSERT INTO public.tests(exam_id,pattern_id,name,description,duration_minutes,total_marks,status,is_published,created_by,review_policy,level_id,test_kind)
 VALUES(pat.exam_id,pat.id,p_test->>'name',p_test->>'description',pat.total_duration_minutes,pat.total_marks,'DRAFT',false,auth.uid(),
  coalesce(p_test->>'review_policy','AFTER_SUBMISSION'),pat.level_id,coalesce(p_test->>'test_kind','GENERAL')) RETURNING * INTO result;
 RETURN to_jsonb(result);
END $$;

REVOKE ALL ON FUNCTION public.ksc_save_question(uuid,jsonb,jsonb,integer),public.ksc_create_pattern(jsonb,jsonb),public.ksc_create_test(jsonb) FROM PUBLIC,anon,service_role;
GRANT EXECUTE ON FUNCTION public.ksc_save_question(uuid,jsonb,jsonb,integer),public.ksc_create_pattern(jsonb,jsonb),public.ksc_create_test(jsonb) TO authenticated;
