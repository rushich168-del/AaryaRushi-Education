-- Forward update for the installed KSC baseline; never run against Atlas.
DO $$ BEGIN
 IF to_regclass('public.organizations') IS NOT NULL OR to_regprocedure('ksc_private.provision_student()') IS NULL
 THEN RAISE EXCEPTION 'Expected isolated KSC baseline'; END IF;
END $$;

-- Invoker functions retain table RLS. Each complete save is one transaction.
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
  INSERT INTO public.questions(exam_id,subject_id,content,explanation,difficulty,question_type,status,source_reference,created_by)
  VALUES((p_question->>'exam_id')::uuid,(p_question->>'subject_id')::uuid,p_question->>'content',p_question->>'explanation',
   coalesce(p_question->>'difficulty','MEDIUM'),'MCQ','DRAFT','MANUAL',auth.uid()) RETURNING * INTO q;
 ELSE
  SELECT * INTO q FROM public.questions WHERE id=p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Question not found'; END IF;
  -- This editor has no hierarchy controls: preserve tags and reject silent reparenting.
  IF (q.topic_id IS NOT NULL OR q.legacy_topic_id IS NOT NULL OR q.chapter_id IS NOT NULL OR q.syllabus_id IS NOT NULL)
    AND (q.exam_id IS DISTINCT FROM (p_question->>'exam_id')::uuid OR q.subject_id IS DISTINCT FROM (p_question->>'subject_id')::uuid)
  THEN RAISE EXCEPTION 'Tagged question cannot change exam or subject in this editor'; END IF;
  UPDATE public.questions SET exam_id=(p_question->>'exam_id')::uuid,subject_id=(p_question->>'subject_id')::uuid,
   content=p_question->>'content',explanation=p_question->>'explanation',difficulty=coalesce(p_question->>'difficulty','MEDIUM'),
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
 INSERT INTO public.exam_patterns(exam_id,name,description,total_duration_minutes,total_marks,status)
 VALUES((p_pattern->>'exam_id')::uuid,p_pattern->>'name',p_pattern->>'description',(p_pattern->>'total_duration_minutes')::integer,0,'DRAFT') RETURNING * INTO pat;
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
 INSERT INTO public.tests(exam_id,pattern_id,name,description,duration_minutes,total_marks,status,is_published,created_by,review_policy)
 VALUES(pat.exam_id,pat.id,p_test->>'name',p_test->>'description',pat.total_duration_minutes,pat.total_marks,'DRAFT',false,auth.uid(),
  coalesce(p_test->>'review_policy','AFTER_SUBMISSION')) RETURNING * INTO result;
 RETURN to_jsonb(result);
END $$;

REVOKE ALL ON FUNCTION public.ksc_save_question(uuid,jsonb,jsonb,integer),public.ksc_create_pattern(jsonb,jsonb),public.ksc_create_test(jsonb) FROM PUBLIC,anon,service_role;
GRANT EXECUTE ON FUNCTION public.ksc_save_question(uuid,jsonb,jsonb,integer),public.ksc_create_pattern(jsonb,jsonb),public.ksc_create_test(jsonb) TO authenticated;
