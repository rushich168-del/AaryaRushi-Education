// Produces a reviewable forward migration; never connects to a database.
import {readFileSync,writeFileSync} from 'node:fs'
const base=readFileSync('supabase/migrations/202610020038_student_program_onboarding.sql','utf8')
const fn=name=>{const start=base.indexOf('CREATE FUNCTION public.'+name+'(');const body=base.indexOf('AS $$',start);return base.slice(start,base.indexOf('$$;',body+5)+3).replace('CREATE FUNCTION','CREATE OR REPLACE FUNCTION')}
let catalogue=fn('ksc_signup_catalogue').replaceAll('AND l.is_active','AND l.is_active AND l.is_signup_enabled')
let state=fn('ksc_student_program_state').replace('AND s.enabled AND e.is_active AND l.is_active','AND s.enabled AND e.is_active AND l.is_active AND l.is_signup_enabled')
let setter=fn('ksc_set_student_program').replace('WHERE exam_id=exam AND enabled)','WHERE exam_id=exam AND enabled AND EXISTS(SELECT 1 FROM public.exam_levels WHERE id=p_level AND is_signup_enabled))')
let settings=fn('ksc_signup_program_settings').replace('AND l.is_active','AND l.is_active AND l.is_signup_enabled')
let availability=fn('ksc_set_signup_program').replace('AND l.is_active','AND l.is_active AND l.is_signup_enabled')
const sql=`-- User-confirmed programme expansion. Preserve old IDs, tests, enrollments and results.
BEGIN;
DO $$ BEGIN IF to_regclass('public.organizations') IS NOT NULL OR to_regclass('public.ksc_student_program_preferences') IS NULL THEN RAISE EXCEPTION 'Verified KSC baseline38 required'; END IF; END $$;
ALTER TABLE public.exam_levels ADD COLUMN is_signup_enabled boolean NOT NULL DEFAULT true;
INSERT INTO public.program_categories(name,slug,display_order) VALUES
 ('School Foundation','school-foundation',2),('IIT / NEET','iit-neet',3),('Competitive Exam Preparation','competitive-preparation',4)
 ON CONFLICT(slug) DO NOTHING;
DO $$ DECLARE r record; eid uuid; subjects text[]; label text; sid uuid; lid uuid; BEGIN
 FOR r IN SELECT * FROM (VALUES
 ('school-foundation','cbse-school-foundation','CBSE School Foundation',ARRAY['Class VI','Class VII','Class VIII','Class IX','Class X'],ARRAY['Mathematics','Science','English']),
 ('school-foundation','icse-school-foundation','ICSE School Foundation',ARRAY['Class VI','Class VII','Class VIII','Class IX','Class X'],ARRAY['Mathematics','Science','English']),
 ('school-foundation','state-board-school-foundation','State Board School Foundation',ARRAY['Class VI','Class VII','Class VIII','Class IX','Class X'],ARRAY['Mathematics','Science','English']),
 ('iit-neet','iit-neet-foundation','IIT / NEET Foundation',ARRAY['Class VI','Class VII','Class VIII','Class IX','Class X'],ARRAY['Mathematics','Physics','Chemistry','Biology']),
 ('iit-neet','jee-main','JEE Main',ARRAY['Class XI','Class XII'],ARRAY['Mathematics','Physics','Chemistry']),
 ('iit-neet','neet','NEET',ARRAY['Class XI','Class XII'],ARRAY['Physics','Chemistry','Biology'])
 ) AS seed(category,slug,name,tracks,subjects) LOOP
 SELECT id INTO eid FROM public.exams WHERE slug=r.slug;
 IF eid IS NULL THEN INSERT INTO public.exams(name,slug,category_id) VALUES(r.name,r.slug,(SELECT id FROM public.program_categories WHERE slug=r.category)) RETURNING id INTO eid;
 ELSE UPDATE public.exams SET category_id=(SELECT id FROM public.program_categories WHERE slug=r.category) WHERE id=eid; END IF;
 INSERT INTO public.exam_levels(exam_id,name,display_order) SELECT eid,t.name,t.ord::integer FROM unnest(r.tracks) WITH ORDINALITY t(name,ord) ON CONFLICT(exam_id,name) DO NOTHING;
 FOREACH label IN ARRAY r.subjects LOOP
 SELECT id INTO sid FROM public.exam_subjects WHERE exam_id=eid AND lower(name)=lower(label) ORDER BY created_at,id LIMIT 1;
 IF sid IS NULL THEN INSERT INTO public.exam_subjects(exam_id,name) VALUES(eid,label) RETURNING id INTO sid; END IF;
 FOR lid IN SELECT id FROM public.exam_levels WHERE exam_id=eid AND name=ANY(r.tracks) LOOP
 IF NOT EXISTS(SELECT 1 FROM public.syllabi WHERE level_id=lid AND subject_id=sid) THEN
 INSERT INTO public.syllabi(exam_id,level_id,subject_id,name,description,status) VALUES(eid,lid,sid,label||' preparation','KSC curriculum workspace; chapters and resources require institute review.','DRAFT'); END IF;
 END LOOP;
 END LOOP;
 END LOOP;
END $$;
-- Historical UG/Default tracks stay active for enrolled students and saved history.
UPDATE public.exam_levels l SET is_signup_enabled=false FROM public.exams e WHERE l.exam_id=e.id AND e.slug IN ('jee-main','neet') AND l.name IN ('Default','UG');
UPDATE public.exams SET category_id=(SELECT id FROM public.program_categories WHERE slug='competitive-preparation') WHERE slug IN ('dsc','group-ii','si-constable');
INSERT INTO public.ksc_signup_programs(exam_id,enabled) SELECT id,true FROM public.exams WHERE slug IN ('cbse-school-foundation','icse-school-foundation','state-board-school-foundation','iit-neet-foundation','jee-main','neet','dsc','group-ii','si-constable') AND is_active ON CONFLICT(exam_id) DO UPDATE SET enabled=excluded.enabled;
${catalogue}
${state}
${setter}
${settings}
${availability}
NOTIFY pgrst,'reload schema';
COMMIT;
`
writeFileSync('supabase/migrations/202610020039_program_families.sql',sql)
