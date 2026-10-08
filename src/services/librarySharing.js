import {localLibrary} from './localExamLibrary.js'
import {examLibraryService} from './examLibraryService.js'

const normalized=value=>String(value||'').toLowerCase().replace(/[^a-z0-9]/g,'')
export function matchingShareProgram(paper,programs){
 const saved=paper.returnedReceipt?.program||paper.sharedReceipt?.program||paper.instituteProgram
 if(programs.some(p=>p.id===saved))return saved
 const exam=normalized(paper.exam),aliases=exam==='dscsgt'?['dscsgt','dsc']:exam==='siconstable'?['siconstable','siconstables']: [exam]
 const matches=programs.filter(p=>aliases.includes(normalized(p.name)))
 return matches.length===1?matches[0].id:''
}
export function reconcileSharedPapers(rows){
 return localLibrary('update',data=>({...data,ready:data.ready.map(copy=>{
  const shared=rows.find(p=>p.source_id===copy.id||p.id===copy.sharedReceipt?.version)
  if(shared){const {returnedReceipt,...paper}=copy;return {...paper,sharedReceipt:{...copy.sharedReceipt,version:shared.id,program:shared.exam_id}}}
  if(copy.sharedReceipt){const {sharedReceipt,...paper}=copy;return {...paper,...(sharedReceipt.version?{returnedReceipt:{version:sharedReceipt.version,program:sharedReceipt.program}}:{})}}
  return copy
 })}))
}
export async function shareSavedPaper(paper,program,account,onProgress=()=>{}){
 onProgress('Checking the shared library…')
 const existing=(await examLibraryService.list()).find(p=>p.source_id===paper.id&&p.exam_id===program)
 onProgress(existing?'Already shared. Updating your library…':'Sending your paper to the shared library…')
 const version=existing?.id||(paper.returnedReceipt?.version&&paper.returnedReceipt.program===program
  ?await examLibraryService.restore(paper.returnedReceipt.version)
  :await examLibraryService.addReady(paper,program))
 if(typeof version!=='string'||!version)throw new Error('Sharing was not confirmed. Please retry this paper.')
 onProgress('Shared. Updating your library…')
 try{return await localLibrary('update',data=>({...data,ready:data.ready.map(p=>{
  if(p.id!==paper.id)return p
  const {returnedReceipt,...copy}=p
  return {...copy,sharedReceipt:{version,program,account,savedAt:new Date().toISOString()}}
 })}))}catch(error){error.sharedVersion=version;throw error}
}
export async function bringBackSharedPaper(version,api=examLibraryService){
 const result=await api.bringBack(version)
 if(!result?.paper?.id||!result.exam_id||!result.version_id)throw new Error('The paper could not be brought back. Please retry.')
 const {sharedReceipt,...paper}=result.paper
 return localLibrary('update',data=>({...data,ready:[{...paper,returnedReceipt:{version:result.version_id,program:result.exam_id}},...data.ready.filter(p=>p.id!==paper.id)]}))
}
