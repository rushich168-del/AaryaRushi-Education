-- Fix remaining old insecure policies

DROP POLICY IF EXISTS "Students can read own attempts" ON public.test_attempts;
DROP POLICY IF EXISTS "Students can insert own attempts" ON public.test_attempts;
DROP POLICY IF EXISTS "Students can update own attempts" ON public.test_attempts;
DROP POLICY IF EXISTS "Teachers can view all attempts" ON public.test_attempts;

DROP POLICY IF EXISTS "Students can manage own answers" ON public.attempt_answers;
DROP POLICY IF EXISTS "Teachers can view all answers" ON public.attempt_answers;
