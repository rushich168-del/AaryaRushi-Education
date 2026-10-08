// Turns backend and network failures into guidance for coaching staff.
// The original error stays on `cause` and in the console for developers.
const setupCodes=['PGRST202','PGRST205','42P01','42883']
const known=[
 [/Assigned creator exam or administrator access required|Exam assignment changed/i,'Your account is not assigned to this institute program. Ask your administrator to assign it, then save again. Your paper is kept on this device.'],
 [/Ready version changed/i,'This ready version is already in the shared library with different content or under another program. Create a revised draft to share it again.'],
 [/Complete paper checks, answers and valid test settings/i,'Complete the paper checks, answers, duration and marks before saving to the library.'],
 [/Question count does not match source/i,'The number of questions does not match the source paper. Check the numbering, then save again.'],
 [/Check AP DSC format counts and marks/i,'This DSC paper does not match its selected test format. Check the question count and marks per question in Edit details.'],
 [/Question (\d+) needs correction, answer or creator check/i,'Question $1 needs a correction, an answer or your confirmation before the paper can be saved.'],
 [/Invalid printed content|Invalid image|Invalid text|Unsupported printed content/i,'A question contains content the library cannot store. Prepare that question again from the source, then retry.'],
 [/Ready version unavailable/i,'This paper is no longer available in your library. Refresh the library and choose it again.'],
 [/Assigned course access required|Teacher access required/i,'You are not assigned to this course. Ask your administrator to assign the course and its batch, then retry.'],
 [/Choose a program linked to your assigned course/i,'This course is not linked to the paper’s program. Ask your administrator to link the program track to the course.'],
 [/Assigned batch access required|Batch assignment changed/i,'You no longer have access to one of the selected batches. Refresh course and batch access, then choose again.'],
 [/Publication request changed/i,'These delivery choices differ from an earlier attempt. Close this panel and publish the paper again.'],
]
export function libraryError(error,action='This step'){
 const raw=String(error?.message||error||''),code=error?.code||''
 let message,friendlyCode=code
 if(setupCodes.includes(code)){message='The paper library update is not available yet. Refresh and retry after the system update is complete. Your saved papers are kept.';friendlyCode='LIBRARY_SETUP_REQUIRED'}
 else if(error?.name==='AbortError'||code==='57014'||/AbortError|aborted|statement timeout/i.test(raw)){message=`${action} is taking longer than expected. Check your connection and retry. Retrying continues the same request, so nothing is duplicated.`;friendlyCode='LIBRARY_TIMEOUT'}
 else if(/Failed to fetch|NetworkError|Load failed|ERR_NETWORK|ERR_INTERNET/i.test(raw)){message='Could not reach the institute library. Check your internet connection and retry.';friendlyCode='LIBRARY_OFFLINE'}
 else if(code==='PGRST301'||/JWT/.test(raw)){message='Your sign-in has expired. Sign in again, then retry. Work saved on this device is kept.';friendlyCode='LIBRARY_SIGN_IN'}
 else if(code==='42501'||/permission denied/i.test(raw))message='Your account does not have permission for this step. Ask your administrator to check your access.'
 else{
  const match=known.find(([pattern])=>pattern.test(raw))
  // Remaining P0001 messages are written for staff in the database functions; anything else is a system fault.
  message=match?raw.match(match[0])[0].replace(match[0],match[1]):code==='P0001'&&raw?raw:`${action} could not be completed. Please retry. If it keeps happening, contact your administrator.`
 }
 const friendly=new Error(message);friendly.code=friendlyCode;friendly.cause=error
 return friendly
}
