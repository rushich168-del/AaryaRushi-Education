-- Course fees set by administrators, Razorpay payments and automatic program enrollment after a verified payment.
-- Prices always come from this table; the browser never sends an amount.
-- Payment rows are written only by the edu-payments Edge Function (service role) after it has checked
-- the Razorpay signature. Students and admins can read; nobody writes payments directly.
BEGIN;
DO $$ BEGIN IF to_regclass('public.organizations') IS NOT NULL OR to_regclass('public.ksc_student_program_memberships') IS NULL THEN RAISE EXCEPTION 'KSC program baseline required'; END IF; END $$;

CREATE TABLE public.ksc_fee_plans (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 exam_id uuid NOT NULL REFERENCES public.exams(id) ON DELETE RESTRICT,
 level_id uuid REFERENCES public.exam_levels(id) ON DELETE RESTRICT, -- NULL = student picks any open track of the program
 title text NOT NULL CHECK (length(btrim(title)) BETWEEN 2 AND 120),
 description text NOT NULL DEFAULT '' CHECK (length(description) <= 600),
 features text[] NOT NULL DEFAULT '{}' CHECK (cardinality(features) <= 8),
 duration_label text NOT NULL DEFAULT '' CHECK (length(duration_label) <= 60),
 amount_paise integer NOT NULL CHECK (amount_paise BETWEEN 100 AND 50000000), -- ₹1 to ₹5,00,000
 original_amount_paise integer CHECK (original_amount_paise IS NULL OR original_amount_paise > amount_paise),
 currency text NOT NULL DEFAULT 'INR' CHECK (currency = 'INR'),
 is_active boolean NOT NULL DEFAULT true,
 is_featured boolean NOT NULL DEFAULT false,
 sort_order integer NOT NULL DEFAULT 100,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 updated_by uuid REFERENCES auth.users(id)
);
CREATE INDEX ksc_fee_plans_exam ON public.ksc_fee_plans(exam_id) WHERE is_active;

CREATE TABLE public.ksc_payments (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 user_id uuid NOT NULL REFERENCES public.student_profiles(id) ON DELETE RESTRICT,
 plan_id uuid NOT NULL REFERENCES public.ksc_fee_plans(id) ON DELETE RESTRICT,
 level_id uuid NOT NULL REFERENCES public.exam_levels(id) ON DELETE RESTRICT,
 plan_title text NOT NULL,              -- frozen at checkout
 amount_paise integer NOT NULL CHECK (amount_paise > 0),
 currency text NOT NULL DEFAULT 'INR',
 receipt text NOT NULL UNIQUE,
 status text NOT NULL DEFAULT 'created' CHECK (status IN ('created','paid','failed')),
 razorpay_order_id text UNIQUE,
 razorpay_payment_id text UNIQUE,
 failure_reason text,
 created_at timestamptz NOT NULL DEFAULT now(),
 paid_at timestamptz,
 enrolled_at timestamptz,
 CHECK (status <> 'paid' OR (razorpay_payment_id IS NOT NULL AND paid_at IS NOT NULL))
);
CREATE INDEX ksc_payments_user ON public.ksc_payments(user_id, created_at DESC);

ALTER TABLE public.ksc_fee_plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ksc_payments ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.ksc_fee_plans, public.ksc_payments FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.ksc_payments TO authenticated;
CREATE POLICY own_or_admin_payments ON public.ksc_payments FOR SELECT TO authenticated USING (user_id = auth.uid() OR public.ksc_is_admin());

CREATE OR REPLACE FUNCTION ksc_private.track_label(n text) RETURNS text LANGUAGE sql IMMUTABLE AS $$ SELECT CASE WHEN n='Default' THEN 'General preparation' ELSE n END $$;

-- Public price list: active plans of programs open for sign-up.
CREATE OR REPLACE FUNCTION public.ksc_public_fee_plans() RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER
 SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT coalesce(jsonb_agg(jsonb_build_object(
  'id',f.id,'title',f.title,'description',f.description,'features',to_jsonb(f.features),'duration_label',f.duration_label,
  'amount_paise',f.amount_paise,'original_amount_paise',f.original_amount_paise,'currency',f.currency,'is_featured',f.is_featured,
  'program_id',e.id,'program_slug',e.slug,'program',e.name,'category',coalesce(c.name,'Other programs'),
  'level_id',f.level_id,'track',(SELECT ksc_private.track_label(l.name) FROM public.exam_levels l WHERE l.id=f.level_id),
  'tracks',CASE WHEN f.level_id IS NULL THEN (SELECT coalesce(jsonb_agg(jsonb_build_object('id',l.id,'name',ksc_private.track_label(l.name)) ORDER BY l.display_order,l.name),'[]')
            FROM public.exam_levels l WHERE l.exam_id=e.id AND l.is_active AND l.is_signup_enabled) ELSE '[]'::jsonb END
 ) ORDER BY f.is_featured DESC, coalesce(c.display_order,999), f.sort_order, e.name, f.amount_paise),'[]')
 FROM public.ksc_fee_plans f JOIN public.exams e ON e.id=f.exam_id
 JOIN public.ksc_signup_programs s ON s.exam_id=e.id AND s.enabled
 LEFT JOIN public.program_categories c ON c.id=e.category_id
 WHERE f.is_active AND e.is_active AND coalesce(c.is_active,true)
 AND (f.level_id IS NULL OR EXISTS(SELECT 1 FROM public.exam_levels l WHERE l.id=f.level_id AND l.is_active AND l.is_signup_enabled));
$$;

CREATE OR REPLACE FUNCTION ksc_private.require_admin() RETURNS uuid LANGUAGE plpgsql STABLE SECURITY DEFINER
 SET search_path=pg_catalog,public,pg_temp AS $$ BEGIN
 IF NOT public.ksc_is_admin() THEN RAISE EXCEPTION 'Administrator access required'; END IF; RETURN auth.uid(); END $$;

CREATE OR REPLACE FUNCTION public.ksc_admin_fee_plans() RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
 SET search_path=pg_catalog,public,pg_temp AS $$ BEGIN
 PERFORM ksc_private.require_admin();
 RETURN jsonb_build_object(
  'plans',(SELECT coalesce(jsonb_agg(jsonb_build_object('id',f.id,'exam_id',f.exam_id,'program',e.name,'level_id',f.level_id,
    'track',(SELECT ksc_private.track_label(l.name) FROM public.exam_levels l WHERE l.id=f.level_id),
    'title',f.title,'description',f.description,'features',to_jsonb(f.features),'duration_label',f.duration_label,'amount_paise',f.amount_paise,
    'original_amount_paise',f.original_amount_paise,'is_active',f.is_active,'is_featured',f.is_featured,'sort_order',f.sort_order,'updated_at',f.updated_at,
    'paid_count',(SELECT count(*) FROM public.ksc_payments p WHERE p.plan_id=f.id AND p.status='paid')) ORDER BY e.name,f.sort_order,f.title),'[]')
   FROM public.ksc_fee_plans f JOIN public.exams e ON e.id=f.exam_id),
  'programs',(SELECT coalesce(jsonb_agg(jsonb_build_object('id',e.id,'name',e.name,'open',coalesce(s.enabled,false),
    'tracks',(SELECT coalesce(jsonb_agg(jsonb_build_object('id',l.id,'name',ksc_private.track_label(l.name)) ORDER BY l.display_order,l.name),'[]') FROM public.exam_levels l WHERE l.exam_id=e.id AND l.is_active AND l.is_signup_enabled))
    ORDER BY coalesce(s.enabled,false) DESC,e.name),'[]')
   FROM public.exams e LEFT JOIN public.ksc_signup_programs s ON s.exam_id=e.id WHERE e.is_active));
END $$;

-- Create (p_plan->>'id' empty) or update a plan. Changing a price never alters past payments (they keep their own amount).
CREATE OR REPLACE FUNCTION public.ksc_save_fee_plan(p_plan jsonb) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER
 SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE uid uuid:=ksc_private.require_admin(); pid uuid; ex uuid:=(p_plan->>'exam_id')::uuid; lv uuid:=nullif(p_plan->>'level_id','')::uuid;
 feats text[]:=coalesce(ARRAY(SELECT btrim(x) FROM jsonb_array_elements_text(coalesce(p_plan->'features','[]')) x WHERE btrim(x)<>''),'{}');
BEGIN
 IF ex IS NULL OR NOT EXISTS(SELECT 1 FROM public.exams WHERE id=ex AND is_active) THEN RAISE EXCEPTION 'Choose an active program'; END IF;
 IF lv IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.exam_levels WHERE id=lv AND exam_id=ex AND is_active) THEN RAISE EXCEPTION 'The class/track does not belong to this program'; END IF;
 IF nullif(p_plan->>'id','') IS NULL THEN
  INSERT INTO public.ksc_fee_plans(exam_id,level_id,title,description,features,duration_label,amount_paise,original_amount_paise,is_active,is_featured,sort_order,updated_by)
  VALUES(ex,lv,btrim(p_plan->>'title'),coalesce(p_plan->>'description',''),feats,coalesce(p_plan->>'duration_label',''),(p_plan->>'amount_paise')::int,
   nullif(p_plan->>'original_amount_paise','')::int,coalesce((p_plan->>'is_active')::boolean,true),coalesce((p_plan->>'is_featured')::boolean,false),coalesce((p_plan->>'sort_order')::int,100),uid)
  RETURNING id INTO pid;
 ELSE
  UPDATE public.ksc_fee_plans SET exam_id=ex,level_id=lv,title=btrim(p_plan->>'title'),description=coalesce(p_plan->>'description',''),features=feats,
   duration_label=coalesce(p_plan->>'duration_label',''),amount_paise=(p_plan->>'amount_paise')::int,original_amount_paise=nullif(p_plan->>'original_amount_paise','')::int,
   is_active=coalesce((p_plan->>'is_active')::boolean,true),is_featured=coalesce((p_plan->>'is_featured')::boolean,false),sort_order=coalesce((p_plan->>'sort_order')::int,100),
   updated_at=now(),updated_by=uid WHERE id=(p_plan->>'id')::uuid RETURNING id INTO pid;
  IF pid IS NULL THEN RAISE EXCEPTION 'Fee plan not found'; END IF;
 END IF;
 RETURN pid;
END $$;

CREATE OR REPLACE FUNCTION public.ksc_admin_payments(p_limit integer DEFAULT 200) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
 SET search_path=pg_catalog,public,pg_temp AS $$ BEGIN
 PERFORM ksc_private.require_admin();
 RETURN (SELECT coalesce(jsonb_agg(r ORDER BY (r->>'created_at') DESC),'[]') FROM (
  SELECT jsonb_build_object('id',p.id,'student',coalesce(nullif(sp.full_name,''),u.email),'email',u.email,'plan',p.plan_title,'program',e.name,'track',ksc_private.track_label(l.name),
   'amount_paise',p.amount_paise,'status',p.status,'receipt',p.receipt,'razorpay_payment_id',p.razorpay_payment_id,'created_at',p.created_at,'paid_at',p.paid_at,'enrolled',p.enrolled_at IS NOT NULL) r
  FROM public.ksc_payments p JOIN auth.users u ON u.id=p.user_id LEFT JOIN public.student_profiles sp ON sp.id=p.user_id
  JOIN public.exam_levels l ON l.id=p.level_id JOIN public.exams e ON e.id=l.exam_id
  ORDER BY p.created_at DESC LIMIT greatest(1,least(coalesce(p_limit,200),1000))) q);
END $$;

CREATE OR REPLACE FUNCTION public.ksc_my_payments() RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER
 SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT coalesce(jsonb_agg(jsonb_build_object('id',p.id,'plan',p.plan_title,'program',e.name,'track',ksc_private.track_label(l.name),'amount_paise',p.amount_paise,
  'status',p.status,'receipt',p.receipt,'razorpay_payment_id',p.razorpay_payment_id,'created_at',p.created_at,'paid_at',p.paid_at,'enrolled',p.enrolled_at IS NOT NULL) ORDER BY p.created_at DESC),'[]')
 FROM public.ksc_payments p JOIN public.exam_levels l ON l.id=p.level_id JOIN public.exams e ON e.id=l.exam_id
 WHERE p.user_id=auth.uid() AND p.status<>'created';
$$;

-- ===== Server-only (service role, called by the edu-payments Edge Function) =====

-- Validates the student, plan and track, freezes the server price and returns what Razorpay needs.
CREATE OR REPLACE FUNCTION public.ksc_payment_begin(p_user uuid, p_plan uuid, p_level uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
 SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE f public.ksc_fee_plans; lv uuid; pay public.ksc_payments; recent integer;
BEGIN
 IF p_user IS NULL OR NOT EXISTS(SELECT 1 FROM public.student_profiles WHERE id=p_user)
  OR EXISTS(SELECT 1 FROM public.ksc_staff_access WHERE user_id=p_user) OR EXISTS(SELECT 1 FROM public.teacher_profiles WHERE id=p_user)
  THEN RAISE EXCEPTION 'Sign in with a student account to pay'; END IF;
 SELECT * INTO f FROM public.ksc_fee_plans WHERE id=p_plan AND is_active;
 IF f.id IS NULL OR NOT EXISTS(SELECT 1 FROM public.ksc_signup_programs WHERE exam_id=f.exam_id AND enabled) THEN RAISE EXCEPTION 'This course is not open for enrollment'; END IF;
 lv:=coalesce(f.level_id,p_level);
 IF lv IS NULL OR (f.level_id IS NOT NULL AND p_level IS NOT NULL AND p_level<>f.level_id)
  OR NOT EXISTS(SELECT 1 FROM public.exam_levels WHERE id=lv AND exam_id=f.exam_id AND is_active AND is_signup_enabled)
  THEN RAISE EXCEPTION 'Choose your class/track for this course'; END IF;
 SELECT count(*) INTO recent FROM public.ksc_payments WHERE user_id=p_user AND created_at>now()-interval '10 minutes';
 IF recent>=10 THEN RAISE EXCEPTION 'Too many payment attempts. Please wait a few minutes.'; END IF;
 INSERT INTO public.ksc_payments(user_id,plan_id,level_id,plan_title,amount_paise,currency,receipt)
 VALUES(p_user,f.id,lv,f.title,f.amount_paise,f.currency,'KSC-'||to_char(now() AT TIME ZONE 'Asia/Kolkata','YYMMDD')||'-'||upper(substr(replace(gen_random_uuid()::text,'-',''),1,8)))
 RETURNING * INTO pay;
 RETURN jsonb_build_object('payment_id',pay.id,'receipt',pay.receipt,'amount_paise',pay.amount_paise,'currency',pay.currency,'title',pay.plan_title);
END $$;

CREATE OR REPLACE FUNCTION public.ksc_payment_attach_order(p_payment uuid, p_order text) RETURNS void LANGUAGE plpgsql SECURITY DEFINER
 SET search_path=pg_catalog,public,pg_temp AS $$ BEGIN
 UPDATE public.ksc_payments SET razorpay_order_id=p_order WHERE id=p_payment AND status='created' AND razorpay_order_id IS NULL;
 IF NOT FOUND THEN RAISE EXCEPTION 'Payment not found'; END IF;
END $$;

-- Called only after the signature was verified. Idempotent: verify callback and webhook may both arrive.
-- p_user, when given, must own the order (browser verify path); the webhook passes NULL.
CREATE OR REPLACE FUNCTION public.ksc_payment_mark_paid(p_order text, p_payment_id text, p_user uuid DEFAULT NULL, p_amount_paise integer DEFAULT NULL) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
 SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE pay public.ksc_payments; BEGIN
 SELECT * INTO pay FROM public.ksc_payments WHERE razorpay_order_id=p_order FOR UPDATE;
 IF pay.id IS NULL OR (p_user IS NOT NULL AND pay.user_id<>p_user) THEN RAISE EXCEPTION 'Payment not found'; END IF;
 IF p_amount_paise IS NOT NULL AND p_amount_paise<>pay.amount_paise THEN RAISE EXCEPTION 'Paid amount does not match the course fee'; END IF;
 IF pay.status='paid' THEN
  IF pay.razorpay_payment_id<>p_payment_id THEN RAISE EXCEPTION 'Order already paid with a different payment'; END IF;
 ELSE
  UPDATE public.ksc_payments SET status='paid',razorpay_payment_id=p_payment_id,paid_at=now(),failure_reason=NULL WHERE id=pay.id RETURNING * INTO pay;
 END IF;
 IF pay.enrolled_at IS NULL THEN
  -- Automatic enrollment: the paid program/track joins the student's programs and becomes the selected one if none is set.
  INSERT INTO public.ksc_student_program_memberships(user_id,level_id) VALUES(pay.user_id,pay.level_id) ON CONFLICT DO NOTHING;
  INSERT INTO public.ksc_student_program_preferences(user_id,level_id) VALUES(pay.user_id,pay.level_id) ON CONFLICT (user_id) DO NOTHING;
  UPDATE public.ksc_payments SET enrolled_at=now() WHERE id=pay.id RETURNING * INTO pay;
 END IF;
 RETURN jsonb_build_object('payment_id',pay.id,'receipt',pay.receipt,'status',pay.status,'amount_paise',pay.amount_paise,'title',pay.plan_title,
  'level_id',pay.level_id,'paid_at',pay.paid_at,'razorpay_payment_id',pay.razorpay_payment_id,'enrolled',true);
END $$;

CREATE OR REPLACE FUNCTION public.ksc_payment_mark_failed(p_order text, p_reason text) RETURNS void LANGUAGE sql SECURITY DEFINER
 SET search_path=pg_catalog,public,pg_temp AS $$
 UPDATE public.ksc_payments SET status='failed',failure_reason=left(coalesce(p_reason,'Payment failed'),300) WHERE razorpay_order_id=p_order AND status='created';
$$;

REVOKE ALL ON FUNCTION public.ksc_public_fee_plans(),public.ksc_admin_fee_plans(),public.ksc_save_fee_plan(jsonb),public.ksc_admin_payments(integer),public.ksc_my_payments(),
 public.ksc_payment_begin(uuid,uuid,uuid),public.ksc_payment_attach_order(uuid,text),public.ksc_payment_mark_paid(text,text,uuid,integer),public.ksc_payment_mark_failed(text,text),
 ksc_private.require_admin(),ksc_private.track_label(text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.ksc_public_fee_plans() TO anon,authenticated;
GRANT EXECUTE ON FUNCTION public.ksc_admin_fee_plans(),public.ksc_save_fee_plan(jsonb),public.ksc_admin_payments(integer),public.ksc_my_payments() TO authenticated;
GRANT EXECUTE ON FUNCTION public.ksc_payment_begin(uuid,uuid,uuid),public.ksc_payment_attach_order(uuid,text),public.ksc_payment_mark_paid(text,text,uuid,integer),public.ksc_payment_mark_failed(text,text) TO service_role;

NOTIFY pgrst, 'reload schema';
COMMIT;
