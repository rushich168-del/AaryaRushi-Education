-- Local upgrade: reject publication of unresolved per-question review items.
-- The trigger runs inside the existing atomic publication transaction, so a
-- rejection also rolls back question-bank, pattern, test and snapshot writes.
BEGIN;
DO $$ BEGIN
 IF to_regclass('public.organizations') IS NOT NULL OR to_regclass('public.printed_papers') IS NULL
 THEN RAISE EXCEPTION 'Expected isolated KSC printed-paper baseline'; END IF;
END $$;
CREATE FUNCTION public.ksc_guard_printed_question_review()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE r record; expected integer;
BEGIN
 IF NEW.test_id IS NULL OR OLD.test_id IS NOT NULL THEN RETURN NEW; END IF;
 IF NEW.metadata->>'review_version' IS DISTINCT FROM '2' THEN RETURN NEW; END IF;
 expected := (NEW.metadata->>'expected_count')::integer;
 FOR r IN SELECT position,question FROM public.printed_paper_questions WHERE paper_id=NEW.id LOOP
  IF coalesce((r.question->>'number')::integer,0) NOT BETWEEN 1 AND expected OR (r.question->>'number')::integer<>r.position+1
  THEN RAISE EXCEPTION 'Question numbering needs review'; END IF;
  IF jsonb_typeof(r.question->'reviewReasons') IS DISTINCT FROM 'array'
  THEN RAISE EXCEPTION 'Question review information is missing. Reopen and save the paper.'; END IF;
  IF (jsonb_array_length(r.question->'reviewReasons')>0 OR r.question->>'edited'='true')
    AND r.question->>'reviewConfirmed' IS DISTINCT FROM 'true'
  THEN RAISE EXCEPTION 'Question % still needs teacher review',r.question->>'number'; END IF;
 END LOOP;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.ksc_guard_printed_question_review() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER printed_question_review_gate BEFORE UPDATE OF test_id ON public.printed_papers
 FOR EACH ROW EXECUTE FUNCTION public.ksc_guard_printed_question_review();
COMMIT;
