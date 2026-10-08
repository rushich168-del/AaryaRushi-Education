import {supabase} from '../lib/supabaseClient.js'
import {paperIssues} from './localExamLibrary.js'
import {sectionGroups} from './dscTestFormats.js'
import {libraryError} from './libraryErrors.js'
async function rpc(name,args={},action='This step',wait=30000) {
 const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),wait)
 let result;try{result=await supabase.rpc(name,args).abortSignal(controller.signal)}catch(error){result={error}}finally{clearTimeout(timer)}
 const {data,error}=result
 if(error){console.error('[library]',name,error.code||error.name||'ERROR',error.message||'Request failed');throw libraryError(error,action)}
 return data
}
export function readyTransfer(paper) {
 const issues=paperIssues(paper);if(issues.length)throw new Error(issues.join(' '))
 const subjects=new Map(sectionGroups(paper).flatMap(g=>g.items.map(({index})=>[index,g.subject])))
 const {sharedReceipt,returnedReceipt,savedAt,resumeIndex,instituteProgram,readyOperation,...content}=paper
 return {...content,questions:paper.questions.map((q,index)=>{const subject=q.subject||subjects.get(index);return {...q,subject:subject&&subject!=='Unassigned questions'?subject:'General / mixed subjects'}})}
}
export function deliverySettings({title,release='AFTER_SUBMISSION',schedule=false,opens='',closes='',level=''}) {
 if(!title.trim()||title.trim().length>200)throw new Error('Enter a test title up to 200 characters.')
 if(!['SUMMARY_ONLY','AFTER_SUBMISSION'].includes(release))throw new Error('Choose a result release option.')
 const opening=schedule?new Date(opens):null,closing=closes?new Date(closes):null
 if(schedule&&(!opens||!Number.isFinite(opening.getTime())))throw new Error('Choose an opening date and time.')
 if(closing&&(!Number.isFinite(closing.getTime())||closing.getTime()<=Date.now()||closing<=(opening||new Date())))throw new Error('Closing time must be in the future and after opening time.')
 return {title:title.trim(),review_policy:release,opens_at:opening?.toISOString()||null,closes_at:closing?.toISOString()||null,...(level?{level_id:level}:{})}
}
export const examLibraryService={
 allDeliveries:async()=>{const [program,legacy]=await Promise.all([examLibraryService.programDeliveries(),examLibraryService.deliveries()]);return [...(program||[]),...(legacy||[])].sort((a,b)=>new Date(b.created_at||b.opens_at)-new Date(a.created_at||a.opens_at))},
 programDeliveries:()=>rpc('ksc_program_library_deliveries',{},'Loading published program tests'),
 withdrawPublished:test=>rpc('ksc_withdraw_published_test',{p_test:test},'Removing this published test'),
 publishProgram:(version,program,title,request)=>rpc('ksc_publish_program_paper',{p_version:version,p_exam:program,p_title:title,p_request:request},'Publishing this test',120000),
 restore:id=>rpc('ksc_library_restore_ready',{p_version:id},'Sharing this paper again'),
 bringBack:id=>rpc('ksc_library_bring_back',{p_version:id},'Bringing this paper back',120000),
 archive:id=>rpc('ksc_library_archive_ready',{p_version:id},'Removing this shared paper'),
 list:()=>rpc('ksc_exam_library_list',{},'Loading the paper library'),deliveries:()=>rpc('ksc_library_deliveries',{},'Loading published tests'),audiences:id=>rpc('ksc_library_audiences',{p_version:id},'Loading courses and batches'),
 // A paper with page images can be tens of MB; aborting early would restart the whole upload on retry.
 addReady:(paper,exam,level=null)=>rpc('ksc_library_add_ready',{p_request:paper.id,p_exam:exam,p_level:level||null,p_paper:readyTransfer(paper)},'Saving to the institute library',120000),
 publish:(version,course,batches,settings,request)=>rpc('ksc_teacher_publish_library',{p_version:version,p_course:course,p_batches:[...batches].sort(),p_settings:settings,p_request:request},'Publishing this test'),
}
