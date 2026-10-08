import {supabase} from '../lib/supabaseClient.js'
import brand from '../config/brand.js'
async function rpc(name,args){
 const {data,error}=await supabase.rpc(name,args)
 if(error){const failure=new Error(['PGRST202','42883','42P01'].includes(error.code)?'Program registration setup is not available yet. Please contact '+brand.name+'.':error.message||'Could not load your program. Please retry.');failure.setupRequired=['PGRST202','42883','42P01'].includes(error.code);throw failure}
 return data
}
export const studentProgramService={
 catalogue:()=>rpc('ksc_signup_catalogue'),
 state:()=>rpc('ksc_student_program_state'),
 select:(level,version,user)=>rpc('ksc_set_student_program',{p_level:level,p_version:version,p_user:user}),
 settings:()=>rpc('ksc_signup_program_settings'),
 availability:(exam,enabled)=>rpc('ksc_set_signup_program',{p_exam:exam,p_enabled:enabled}),
}
export function programOptions(catalogue,enrolled=[]){
 const programs=new Map((catalogue?.programs||[]).map(p=>[p.id,{...p,tracks:[...p.tracks]}]))
 for(const row of enrolled){
  if(!programs.has(row.exam_id))programs.set(row.exam_id,{id:row.exam_id,name:row.program,category:'My enrolled programs',tracks:[]})
  const p=programs.get(row.exam_id);if(!p.tracks.some(t=>t.id===row.level_id))p.tracks.push({id:row.level_id,name:row.track})
 }
 return [...programs.values()]
}
