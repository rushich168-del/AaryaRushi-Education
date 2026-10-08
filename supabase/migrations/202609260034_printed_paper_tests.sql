-- Printed-source paper delivery. Additive; existing draft/OCR records are untouched.
BEGIN;
DO $$ BEGIN
 IF to_regclass('public.organizations') IS NOT NULL OR to_regprocedure('public.ksc_create_test(jsonb)') IS NULL
 THEN RAISE EXCEPTION 'Expected isolated KSC authoring baseline'; END IF;
END $$;

CREATE TABLE public.printed_papers (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), created_by uuid NOT NULL DEFAULT auth.uid() REFERENCES auth.users(id),
 metadata jsonb NOT NULL, revision integer NOT NULL DEFAULT 1, test_id uuid REFERENCES public.tests(id),
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.printed_paper_questions (
 paper_id uuid NOT NULL REFERENCES public.printed_papers(id) ON DELETE CASCADE,
 position integer NOT NULL CHECK(position BETWEEN 0 AND 499), question jsonb NOT NULL,
 PRIMARY KEY(paper_id,position)
);
ALTER TABLE public.printed_papers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.printed_paper_questions ENABLE ROW LEVEL SECURITY;
CREATE POLICY printed_papers_owner ON public.printed_papers FOR SELECT TO authenticated
 USING(public.is_teacher() AND created_by=auth.uid());
CREATE POLICY printed_questions_owner ON public.printed_paper_questions FOR SELECT TO authenticated
 USING(EXISTS(SELECT 1 FROM public.printed_papers p WHERE p.id=paper_id AND p.created_by=auth.uid()) AND public.is_teacher());
REVOKE ALL ON public.printed_papers,public.printed_paper_questions FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON public.printed_papers,public.printed_paper_questions TO authenticated;

CREATE FUNCTION public.ksc_save_printed_paper(p_id uuid,p_metadata jsonb,p_questions jsonb,p_revision integer)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE p public.printed_papers; q jsonb;
BEGIN
 IF auth.uid() IS NULL OR NOT public.is_teacher() THEN RAISE EXCEPTION 'Teacher access required'; END IF;
 IF p_id IS NULL THEN
  IF p_metadata IS NULL THEN RAISE EXCEPTION 'Paper details required'; END IF;
  INSERT INTO public.printed_papers(metadata,created_by) VALUES(p_metadata,auth.uid()) RETURNING * INTO p;
 ELSE
  SELECT * INTO p FROM public.printed_papers WHERE id=p_id AND created_by=auth.uid() FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Paper not found'; END IF;
  IF p.test_id IS NOT NULL THEN RAISE EXCEPTION 'Published papers cannot be changed'; END IF;
  IF p_revision IS DISTINCT FROM p.revision THEN RAISE EXCEPTION 'Paper changed in another tab. Reopen it before saving.'; END IF;
 END IF;
 IF p_metadata IS NOT NULL THEN
  IF jsonb_typeof(p_metadata) IS DISTINCT FROM 'object' OR octet_length(p_metadata::text)>10000
   OR coalesce((p_metadata->>'expected_count')::integer,0) NOT BETWEEN 1 AND 500
  THEN RAISE EXCEPTION 'Invalid paper details'; END IF;
  UPDATE public.printed_papers SET metadata=p_metadata WHERE id=p.id;
 END IF;
 IF p_questions IS NOT NULL THEN
  IF jsonb_typeof(p_questions) IS DISTINCT FROM 'array' OR jsonb_array_length(p_questions)>20 THEN RAISE EXCEPTION 'Save up to 20 questions at once'; END IF;
  FOR q IN SELECT value FROM jsonb_array_elements(p_questions) LOOP
   IF octet_length(q::text)>4000000 OR jsonb_typeof(q) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'Question is too large'; END IF;
   INSERT INTO public.printed_paper_questions(paper_id,position,question) VALUES(p.id,(q->>'position')::integer,q)
    ON CONFLICT(paper_id,position) DO UPDATE SET question=excluded.question;
  END LOOP;
 END IF;
 UPDATE public.printed_papers SET revision=revision+1,updated_at=now() WHERE id=p.id RETURNING * INTO p;
 RETURN to_jsonb(p);
END $$;

CREATE FUNCTION public.ksc_publish_printed_paper(p_id uuid,p_revision integer,p_reviewed boolean)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE p public.printed_papers; m jsonb; r record; q jsonb; body jsonb; block jsonb;
 pat jsonb; t jsonb; bank jsonb; section_id uuid; expected integer; position integer:=0;
BEGIN
 IF auth.uid() IS NULL OR NOT public.is_teacher() THEN RAISE EXCEPTION 'Teacher access required'; END IF;
 SELECT * INTO p FROM public.printed_papers WHERE id=p_id AND created_by=auth.uid() FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Paper not found'; END IF;
 -- Safe retry after a lost response: one published test per paper.
 IF p.test_id IS NOT NULL THEN RETURN p.test_id; END IF;
 IF p_reviewed IS DISTINCT FROM true OR p_revision IS DISTINCT FROM p.revision THEN RAISE EXCEPTION 'Review the current paper and answer key before publishing'; END IF;
 m:=p.metadata; expected:=(m->>'expected_count')::integer;
 IF expected IS NULL OR expected NOT BETWEEN 1 AND 500 OR (SELECT count(*) FROM public.printed_paper_questions WHERE paper_id=p.id)<>expected
 THEN RAISE EXCEPTION 'Paper is not fully saved'; END IF;
 IF coalesce(btrim(m->>'name'),'')='' OR coalesce((m->>'duration_minutes')::integer,0) NOT BETWEEN 1 AND 1440
 OR coalesce((m->>'marks')::integer,0) NOT BETWEEN 1 AND 100 OR (m->>'negative_marks')::numeric IS NULL
 OR (m->>'negative_marks')::numeric<0 OR (m->>'negative_marks')::numeric>(m->>'marks')::integer
 OR NOT EXISTS(SELECT 1 FROM public.exam_subjects WHERE id=(m->>'subject_id')::uuid AND exam_id=(m->>'exam_id')::uuid)
 THEN RAISE EXCEPTION 'Check program, subject, duration and marking'; END IF;
 FOR r IN SELECT * FROM public.printed_paper_questions WHERE paper_id=p.id ORDER BY position LOOP
  q:=r.question;
  IF r.position<>position OR coalesce((q->>'number')::integer,0)<=0
   OR jsonb_typeof(q->'options') IS DISTINCT FROM 'array' OR jsonb_array_length(q->'options')<>4
   OR (q->>'correct')::integer IS NULL OR (q->>'correct')::integer NOT BETWEEN 0 AND 3
   OR left(q->>'content',15) IS DISTINCT FROM 'KSC_PRINTED_V1:'
  THEN RAISE EXCEPTION 'Question % needs a valid answer and printed content',position+1; END IF;
  body:=substring(q->>'content' FROM 16)::jsonb;
  IF jsonb_typeof(body->'blocks') IS DISTINCT FROM 'array' OR jsonb_array_length(body->'blocks') NOT BETWEEN 1 AND 300
  THEN RAISE EXCEPTION 'Invalid printed question'; END IF;
  FOR block IN SELECT value FROM jsonb_array_elements(body->'blocks') LOOP
   IF block->>'type'='image' THEN
    IF coalesce(block->>'src','') !~ '^data:image/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$' THEN RAISE EXCEPTION 'Invalid image'; END IF;
   ELSIF block->>'type'='text' THEN
    IF jsonb_typeof(block->'text') IS DISTINCT FROM 'string' THEN RAISE EXCEPTION 'Invalid text'; END IF;
   ELSE RAISE EXCEPTION 'Unsupported printed content'; END IF;
  END LOOP;
  position:=position+1;
 END LOOP;
 IF (SELECT count(DISTINCT (question->>'number')::integer) FROM public.printed_paper_questions WHERE paper_id=p.id)<>expected
 THEN RAISE EXCEPTION 'Duplicate question numbers'; END IF;
 pat:=public.ksc_create_pattern(jsonb_build_object('exam_id',m->>'exam_id','level_id',m->>'level_id','name',m->>'name','total_duration_minutes',m->>'duration_minutes'),
  jsonb_build_array(jsonb_build_object('subject_id',m->>'subject_id','section_name','Question paper','question_count',expected,'marks_per_question',m->>'marks','negative_marks',m->>'negative_marks')));
 UPDATE public.exam_patterns SET status='ACTIVE' WHERE id=(pat->>'id')::uuid;
 SELECT id INTO section_id FROM public.exam_pattern_sections WHERE pattern_id=(pat->>'id')::uuid;
 t:=public.ksc_create_test(jsonb_build_object('exam_id',m->>'exam_id','pattern_id',pat->>'id','name',m->>'name','test_kind','MODEL','review_policy','AFTER_SUBMISSION'));
 FOR r IN SELECT * FROM public.printed_paper_questions WHERE paper_id=p.id ORDER BY position LOOP
  q:=r.question;
  bank:=public.ksc_save_question(NULL,jsonb_build_object('exam_id',m->>'exam_id','subject_id',m->>'subject_id','level_id',m->>'level_id','content',q->>'content'),q->'options',(q->>'correct')::integer);
  UPDATE public.questions SET status='APPROVED',source_reference='Printed paper '||p.id||', question '||(q->>'number') WHERE id=(bank->>'id')::uuid;
  INSERT INTO public.test_questions(test_id,question_id,section_id,sort_order) VALUES((t->>'id')::uuid,(bank->>'id')::uuid,section_id,r.position);
 END LOOP;
 PERFORM public.publish_test((t->>'id')::uuid);
 UPDATE public.printed_papers SET test_id=(t->>'id')::uuid,updated_at=now() WHERE id=p.id;
 RETURN (t->>'id')::uuid;
END $$;
REVOKE ALL ON FUNCTION public.ksc_save_printed_paper(uuid,jsonb,jsonb,integer),public.ksc_publish_printed_paper(uuid,integer,boolean) FROM PUBLIC,anon,service_role;
GRANT EXECUTE ON FUNCTION public.ksc_save_printed_paper(uuid,jsonb,jsonb,integer),public.ksc_publish_printed_paper(uuid,integer,boolean) TO authenticated;
COMMIT;
