-- KSC B4.7 — one-click automatic paper preparation: persisted lifecycle (NEW guarded forward migration; needs 0028)
--
-- The B4 pipeline runs in the teacher's browser (the SPA is the only compute tier) and writes
-- through the 0023-0028 writers. This migration makes its lifecycle durable and safe:
--   * each preparation is a draft_analysis_runs row with preparation_state
--     RUNNING -> PREPARED | FAILED | INTERRUPTED, the current stage, a heartbeat, teacher-safe
--     failure stage/code/message and per-stage timings;
--   * at most ONE running preparation per import (partial unique index + row lock): a double
--     click, a refresh or a second tab cannot start a competing run;
--   * a run whose browser went away (no heartbeat for 120 s) is marked INTERRUPTED when a new
--     run starts — never silently resumed, never silently completed;
--   * PREPARED is set only by ksc_complete_paper_preparation, and only when the Draft was written
--     by THIS run and its review items exist — the Draft can never "look prepared" after a
--     partial failure;
--   * starting is refused while the Draft holds teacher work (ksc_draft_has_teacher_work) — no
--     force retry exists;
--   * preparation columns change only through these RPCs (trigger), so a client cannot fake a
--     completed preparation with a direct UPDATE.
-- Nothing here confirms an answer or touches the Question Bank, publish, snapshots or attempts.
-- Migrations 0001-0028 are not edited.
BEGIN;

DO $$ BEGIN
 IF to_regclass('public.organizations') IS NOT NULL OR to_regprocedure('ksc_private.provision_student()') IS NULL
 THEN RAISE EXCEPTION 'Expected isolated KSC baseline'; END IF;
 IF to_regprocedure('public.ksc_revise_language_text(uuid,text,text,text,text)') IS NULL THEN
  RAISE EXCEPTION 'Missing B4.5R objects. Ensure 0028 is applied.';
 END IF;
END $$;

-- =========================================================================
-- 1. Lifecycle columns on the 0023 run log.
-- =========================================================================
ALTER TABLE public.draft_analysis_runs
  ADD COLUMN IF NOT EXISTS preparation_state TEXT,
  ADD COLUMN IF NOT EXISTS preparation_stage TEXT,
  ADD COLUMN IF NOT EXISTS stage_detail JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS stage_timings JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS heartbeat_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS prepared_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS failure_stage TEXT,
  ADD COLUMN IF NOT EXISTS failure_code TEXT,
  ADD COLUMN IF NOT EXISTS failure_message TEXT;

ALTER TABLE public.draft_analysis_runs DROP CONSTRAINT IF EXISTS draft_analysis_runs_preparation_state_valid;
ALTER TABLE public.draft_analysis_runs ADD CONSTRAINT draft_analysis_runs_preparation_state_valid
  CHECK (preparation_state IS NULL OR preparation_state IN ('RUNNING','PREPARED','FAILED','INTERRUPTED'));
ALTER TABLE public.draft_analysis_runs DROP CONSTRAINT IF EXISTS draft_analysis_runs_preparation_stage_valid;
ALTER TABLE public.draft_analysis_runs ADD CONSTRAINT draft_analysis_runs_preparation_stage_valid
  CHECK (preparation_stage IS NULL OR preparation_stage IN ('READING_PAPER','DETECTING_QUESTIONS','DETECTING_FIGURES',
    'READING_TELUGU','SAVING_DRAFT','PREPARING_REVIEW','COMPLETE'));
ALTER TABLE public.draft_analysis_runs DROP CONSTRAINT IF EXISTS draft_analysis_runs_prepared_consistent;
ALTER TABLE public.draft_analysis_runs ADD CONSTRAINT draft_analysis_runs_prepared_consistent
  CHECK (preparation_state IS DISTINCT FROM 'PREPARED' OR (prepared_at IS NOT NULL AND draft_paper_id IS NOT NULL AND status = 'SUCCEEDED'));

CREATE UNIQUE INDEX IF NOT EXISTS draft_analysis_runs_one_running_preparation
  ON public.draft_analysis_runs(source_import_id) WHERE preparation_state = 'RUNNING';

-- Preparation columns change only inside the RPCs below (transaction flag).
CREATE OR REPLACE FUNCTION public.ksc_guard_preparation_columns() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF coalesce(current_setting('ksc.preparation_rpc', true), '') = 'on' THEN RETURN NEW; END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.preparation_state IS NOT NULL OR NEW.preparation_stage IS NOT NULL OR NEW.prepared_at IS NOT NULL OR NEW.heartbeat_at IS NOT NULL
       OR NEW.failure_stage IS NOT NULL OR NEW.failure_code IS NOT NULL OR NEW.failure_message IS NOT NULL THEN
      RAISE EXCEPTION 'KSC_PREPARATION_RPC_ONLY';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.preparation_state IS DISTINCT FROM OLD.preparation_state OR NEW.preparation_stage IS DISTINCT FROM OLD.preparation_stage
     OR NEW.stage_detail IS DISTINCT FROM OLD.stage_detail OR NEW.stage_timings IS DISTINCT FROM OLD.stage_timings
     OR NEW.heartbeat_at IS DISTINCT FROM OLD.heartbeat_at OR NEW.prepared_at IS DISTINCT FROM OLD.prepared_at
     OR NEW.failure_stage IS DISTINCT FROM OLD.failure_stage OR NEW.failure_code IS DISTINCT FROM OLD.failure_code
     OR NEW.failure_message IS DISTINCT FROM OLD.failure_message THEN
    RAISE EXCEPTION 'KSC_PREPARATION_RPC_ONLY' USING HINT = 'Preparation state changes only through the preparation RPCs.';
  END IF;
  -- A preparation run is written only by the SECURITY DEFINER writers/RPCs (which run as the
  -- function owner). A direct client UPDATE (status, draft link, metrics, …) is refused, so a
  -- run cannot be made to look written or reviewed.
  IF OLD.preparation_state IS NOT NULL AND current_user IN ('authenticated', 'anon') THEN
    RAISE EXCEPTION 'KSC_PREPARATION_RPC_ONLY' USING HINT = 'Preparation runs change only through the preparation RPCs and writers.';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.ksc_guard_preparation_columns() FROM PUBLIC, anon, authenticated, service_role;
DROP TRIGGER IF EXISTS guard_preparation_columns ON public.draft_analysis_runs;
CREATE TRIGGER guard_preparation_columns BEFORE INSERT OR UPDATE ON public.draft_analysis_runs
FOR EACH ROW EXECUTE FUNCTION public.ksc_guard_preparation_columns();

-- =========================================================================
-- 2. Start: one running preparation per import; stale runs become INTERRUPTED; refused on
--    teacher work. The import row lock serialises concurrent starts (double click, two tabs).
-- =========================================================================
CREATE OR REPLACE FUNCTION public.ksc_start_paper_preparation(p_import_id UUID, p_engine TEXT, p_engine_version TEXT, p_client JSONB DEFAULT '{}'::jsonb)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE v_uid UUID := auth.uid(); v_run public.draft_analysis_runs; v_paper UUID; v_id UUID;
BEGIN
  IF v_uid IS NULL OR NOT public.is_teacher() THEN RAISE EXCEPTION 'Teacher access required'; END IF;
  IF coalesce(p_engine, '') = '' OR coalesce(p_engine_version, '') = '' THEN RAISE EXCEPTION 'p_engine and p_engine_version are required'; END IF;
  PERFORM 1 FROM public.test_imports WHERE id = p_import_id AND created_by = v_uid FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Import not found or unauthorized'; END IF;
  PERFORM set_config('ksc.preparation_rpc', 'on', true);

  SELECT * INTO v_run FROM public.draft_analysis_runs WHERE source_import_id = p_import_id AND preparation_state = 'RUNNING' FOR UPDATE;
  IF FOUND THEN
    IF v_run.heartbeat_at > NOW() - INTERVAL '120 seconds' THEN
      RAISE EXCEPTION 'KSC_PREPARATION_IN_PROGRESS' USING HINT = coalesce(v_run.preparation_stage, '');
    END IF;
    UPDATE public.draft_analysis_runs SET preparation_state = 'INTERRUPTED', failure_stage = preparation_stage, failure_code = 'INTERRUPTED',
      failure_message = 'Preparation stopped before finishing (the page was closed, refreshed or lost its connection).',
      status = CASE WHEN status = 'RUNNING' THEN 'FAILED' ELSE status END, failed_at = NOW()
    WHERE id = v_run.id;
  END IF;

  SELECT id INTO v_paper FROM public.draft_papers WHERE source_import_id = p_import_id;
  IF v_paper IS NOT NULL AND public.ksc_draft_has_teacher_work(v_paper) THEN
    RAISE EXCEPTION 'KSC_DRAFT_HAS_TEACHER_WORK' USING HINT = 'Automatic preparation cannot replace a Draft that contains teacher changes.';
  END IF;

  INSERT INTO public.draft_analysis_runs (source_import_id, engine, engine_version, pipeline_stage, metrics, created_by,
      preparation_state, preparation_stage, heartbeat_at, stage_timings)
  VALUES (p_import_id, p_engine, p_engine_version, 'B4.7', jsonb_build_object('client', coalesce(p_client, '{}'::jsonb)), v_uid,
      'RUNNING', 'READING_PAPER', NOW(), jsonb_build_object('READING_PAPER', jsonb_build_object('started_at', NOW())))
  RETURNING id INTO v_id;
  PERFORM set_config('ksc.preparation_rpc', 'off', true);
  RETURN jsonb_build_object('run_id', v_id, 'draft_paper_id', v_paper);
END $$;

-- The caller's own RUNNING preparation run, locked. A run taken over (INTERRUPTED) or finished is
-- refused, so a stale tab stops instead of writing over a newer run.
CREATE OR REPLACE FUNCTION public.ksc_preparation_run_for_update(p_run_id UUID) RETURNS public.draft_analysis_runs
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE r public.draft_analysis_runs;
BEGIN
  IF auth.uid() IS NULL OR NOT public.is_teacher() THEN RAISE EXCEPTION 'Teacher access required'; END IF;
  SELECT r2.* INTO r FROM public.draft_analysis_runs r2 JOIN public.test_imports i ON i.id = r2.source_import_id
  WHERE r2.id = p_run_id AND i.created_by = auth.uid() FOR UPDATE OF r2;
  IF NOT FOUND THEN RAISE EXCEPTION 'Preparation run not found or unauthorized'; END IF;
  IF r.preparation_state IS DISTINCT FROM 'RUNNING' THEN
    RAISE EXCEPTION 'KSC_PREPARATION_NOT_RUNNING' USING HINT = coalesce(r.preparation_state, 'NOT_A_PREPARATION');
  END IF;
  RETURN r;
END $$;
REVOKE ALL ON FUNCTION public.ksc_preparation_run_for_update(UUID) FROM PUBLIC, anon, authenticated, service_role;

-- =========================================================================
-- 3. Progress (stage + heartbeat + detail), failure, completion.
-- =========================================================================
CREATE OR REPLACE FUNCTION public.ksc_paper_preparation_progress(p_run_id UUID, p_stage TEXT, p_detail JSONB DEFAULT '{}'::jsonb)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE r public.draft_analysis_runs; v_timings JSONB;
BEGIN
  r := public.ksc_preparation_run_for_update(p_run_id);
  IF p_stage NOT IN ('READING_PAPER','DETECTING_QUESTIONS','DETECTING_FIGURES','READING_TELUGU','SAVING_DRAFT','PREPARING_REVIEW') THEN
    RAISE EXCEPTION 'KSC_PREPARATION_STAGE_INVALID';
  END IF;
  v_timings := r.stage_timings;
  IF p_stage IS DISTINCT FROM r.preparation_stage THEN
    IF r.preparation_stage IS NOT NULL THEN
      v_timings := jsonb_set(v_timings, ARRAY[r.preparation_stage], coalesce(v_timings->r.preparation_stage, '{}'::jsonb) || jsonb_build_object('finished_at', NOW()));
    END IF;
    v_timings := v_timings || jsonb_build_object(p_stage, jsonb_build_object('started_at', NOW()));
  END IF;
  PERFORM set_config('ksc.preparation_rpc', 'on', true);
  UPDATE public.draft_analysis_runs SET preparation_stage = p_stage, stage_detail = coalesce(p_detail, '{}'::jsonb), stage_timings = v_timings, heartbeat_at = NOW()
  WHERE id = r.id;
  PERFORM set_config('ksc.preparation_rpc', 'off', true);
  RETURN jsonb_build_object('stage', p_stage);
END $$;

CREATE OR REPLACE FUNCTION public.ksc_fail_paper_preparation(p_run_id UUID, p_stage TEXT, p_code TEXT, p_message TEXT, p_detail JSONB DEFAULT NULL)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE r public.draft_analysis_runs;
BEGIN
  IF auth.uid() IS NULL OR NOT public.is_teacher() THEN RAISE EXCEPTION 'Teacher access required'; END IF;
  SELECT r2.* INTO r FROM public.draft_analysis_runs r2 JOIN public.test_imports i ON i.id = r2.source_import_id
  WHERE r2.id = p_run_id AND i.created_by = auth.uid() FOR UPDATE OF r2;
  IF NOT FOUND THEN RAISE EXCEPTION 'Preparation run not found or unauthorized'; END IF;
  IF r.preparation_state IS DISTINCT FROM 'RUNNING' THEN RETURN jsonb_build_object('recorded', false, 'state', r.preparation_state); END IF;
  PERFORM set_config('ksc.preparation_rpc', 'on', true);
  UPDATE public.draft_analysis_runs SET preparation_state = 'FAILED', failure_stage = coalesce(p_stage, preparation_stage),
    failure_code = left(coalesce(p_code, 'UNKNOWN'), 80), failure_message = left(coalesce(p_message, ''), 500),
    error_message = left(coalesce(p_message, ''), 2000), error_detail = p_detail,
    status = CASE WHEN status = 'RUNNING' THEN 'FAILED' ELSE status END, failed_at = NOW(), heartbeat_at = NOW()
  WHERE id = r.id;
  PERFORM set_config('ksc.preparation_rpc', 'off', true);
  RETURN jsonb_build_object('recorded', true, 'state', 'FAILED');
END $$;

-- PREPARED only when the Draft was written by THIS run (every question carries it) and this run's
-- review items were generated (ksc_replace_review_items records metrics.reviewItems).
CREATE OR REPLACE FUNCTION public.ksc_complete_paper_preparation(p_run_id UUID, p_summary JSONB DEFAULT '{}'::jsonb)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE r public.draft_analysis_runs; v_questions INT; v_foreign INT; v_items INT;
BEGIN
  r := public.ksc_preparation_run_for_update(p_run_id);
  IF r.status IS DISTINCT FROM 'SUCCEEDED' OR r.draft_paper_id IS NULL THEN RAISE EXCEPTION 'KSC_PREPARATION_DRAFT_NOT_WRITTEN'; END IF;
  SELECT count(*), count(*) FILTER (WHERE analysis_run_id IS DISTINCT FROM r.id) INTO v_questions, v_foreign
  FROM public.draft_questions WHERE draft_paper_id = r.draft_paper_id;
  IF v_questions = 0 OR v_foreign > 0 THEN RAISE EXCEPTION 'KSC_PREPARATION_DRAFT_NOT_FROM_RUN'; END IF;
  IF NOT (r.metrics ? 'reviewItems') THEN RAISE EXCEPTION 'KSC_PREPARATION_REVIEW_NOT_GENERATED'; END IF;
  SELECT count(*) INTO v_items FROM public.draft_review_items WHERE draft_paper_id = r.draft_paper_id AND origin_run_id = r.id;
  IF v_items IS DISTINCT FROM (r.metrics->>'reviewItems')::INT THEN RAISE EXCEPTION 'KSC_PREPARATION_REVIEW_NOT_GENERATED'; END IF;
  PERFORM set_config('ksc.preparation_rpc', 'on', true);
  UPDATE public.draft_analysis_runs SET preparation_state = 'PREPARED', preparation_stage = 'COMPLETE', prepared_at = NOW(), heartbeat_at = NOW(),
    stage_timings = CASE WHEN preparation_stage IS NOT NULL THEN jsonb_set(stage_timings, ARRAY[preparation_stage],
      coalesce(stage_timings->preparation_stage, '{}'::jsonb) || jsonb_build_object('finished_at', NOW())) ELSE stage_timings END,
    metrics = metrics || jsonb_build_object('preparation', coalesce(p_summary, '{}'::jsonb))
  WHERE id = r.id;
  PERFORM set_config('ksc.preparation_rpc', 'off', true);
  RETURN jsonb_build_object('state', 'PREPARED', 'draft_paper_id', r.draft_paper_id);
END $$;

-- =========================================================================
-- 4. Status, derived from persisted state (the UI never trusts its own memory of a run).
-- =========================================================================
CREATE OR REPLACE FUNCTION public.ksc_paper_preparation_status(p_import_id UUID)
RETURNS JSONB LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE r public.draft_analysis_runs; v_paper UUID; v_counts JSONB; v_teacher_work BOOLEAN := false;
BEGIN
  IF auth.uid() IS NULL OR NOT public.is_teacher() THEN RAISE EXCEPTION 'Teacher access required'; END IF;
  SELECT * INTO r FROM public.draft_analysis_runs WHERE source_import_id = p_import_id AND preparation_state IS NOT NULL
  ORDER BY started_at DESC, created_at DESC LIMIT 1;
  SELECT id INTO v_paper FROM public.draft_papers WHERE source_import_id = p_import_id;
  IF v_paper IS NOT NULL THEN
    v_teacher_work := public.ksc_draft_has_teacher_work(v_paper);
    SELECT jsonb_build_object('questions', count(*), 'ready', count(*) FILTER (WHERE readiness = 'READY'),
        'quick_check', count(*) FILTER (WHERE readiness = 'QUICK_CHECK'), 'manual_review', count(*) FILTER (WHERE readiness = 'MANUAL_REVIEW'),
        'open_blocking', (SELECT count(*) FROM public.draft_review_items WHERE draft_paper_id = v_paper AND blocking AND status <> 'RESOLVED'),
        'open_optional', (SELECT count(*) FROM public.draft_review_items WHERE draft_paper_id = v_paper AND NOT blocking AND status <> 'RESOLVED'))
      INTO v_counts FROM public.draft_question_readiness WHERE draft_paper_id = v_paper;
  END IF;
  RETURN jsonb_build_object(
    'state', CASE WHEN r.id IS NULL THEN 'UPLOADED'
                  WHEN r.preparation_state = 'RUNNING' AND r.heartbeat_at <= NOW() - INTERVAL '120 seconds' THEN 'INTERRUPTED'
                  ELSE r.preparation_state END,
    'run_id', r.id, 'stage', r.preparation_stage, 'stage_detail', r.stage_detail, 'stage_timings', r.stage_timings,
    'started_at', r.started_at, 'heartbeat_at', r.heartbeat_at, 'prepared_at', r.prepared_at,
    'seconds_since_heartbeat', CASE WHEN r.heartbeat_at IS NULL THEN NULL ELSE extract(epoch FROM NOW() - r.heartbeat_at)::INT END,
    'failure_stage', r.failure_stage, 'failure_code', r.failure_code, 'failure_message', r.failure_message,
    'draft_paper_id', CASE WHEN r.preparation_state = 'PREPARED' THEN r.draft_paper_id ELSE v_paper END,
    'draft_prepared_by_this_run', r.preparation_state = 'PREPARED',
    'teacher_work', v_teacher_work, 'counts', v_counts, 'summary', r.metrics->'preparation');
END $$;

REVOKE ALL ON FUNCTION public.ksc_start_paper_preparation(UUID, TEXT, TEXT, JSONB) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.ksc_paper_preparation_progress(UUID, TEXT, JSONB) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.ksc_fail_paper_preparation(UUID, TEXT, TEXT, TEXT, JSONB) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.ksc_complete_paper_preparation(UUID, JSONB) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.ksc_paper_preparation_status(UUID) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.ksc_start_paper_preparation(UUID, TEXT, TEXT, JSONB) TO authenticated;
GRANT EXECUTE ON FUNCTION public.ksc_paper_preparation_progress(UUID, TEXT, JSONB) TO authenticated;
GRANT EXECUTE ON FUNCTION public.ksc_fail_paper_preparation(UUID, TEXT, TEXT, TEXT, JSONB) TO authenticated;
GRANT EXECUTE ON FUNCTION public.ksc_complete_paper_preparation(UUID, JSONB) TO authenticated;
GRANT EXECUTE ON FUNCTION public.ksc_paper_preparation_status(UUID) TO authenticated;

COMMIT;
