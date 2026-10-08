// Shared client/server validation. Never returns or logs password contents.
export const validUuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
export function passwordChecks(value) {
 const password = typeof value === 'string' ? value : '';
 return [
  {id:'length',label:'12–128 characters',valid:password.length>=12&&password.length<=128},
  {id:'uppercase',label:'An uppercase letter (A–Z)',valid:/[A-Z]/.test(password)},
  {id:'lowercase',label:'A lowercase letter (a–z)',valid:/[a-z]/.test(password)},
  {id:'number',label:'A number (0–9)',valid:/[0-9]/.test(password)},
  {id:'symbol',label:'A symbol, for example ! @ #',valid:/[^a-zA-Z0-9]/.test(password)},
 ];
}
export const strongPassword = value => typeof value==='string' && passwordChecks(value).every(check=>check.valid);
export function passwordError(value) {
 const missing=passwordChecks(value).filter(check=>!check.valid);
 return missing.length?'Temporary password needs: '+missing.map(check=>check.label).join('; ')+'.':'';
}
export function teacherAccountErrors(input) {
 const errors={};
 if(!validUuid(input.request_id))errors.request_id='This form has expired. Close it and select Add teacher again.';
 if(typeof input.name!=='string'||!input.name.trim()||input.name.trim().length>120)errors.name='Enter a full name between 1 and 120 characters.';
 if(typeof input.email!=='string'||input.email.trim().length>254||!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.email.trim()))errors.email='Enter a valid email address.';
 const problem=passwordError(input.password);if(problem)errors.password=problem;
 if(!Array.isArray(input.courses)||!Array.isArray(input.batches)||input.courses.length>100||input.batches.length>200||![...(input.courses||[]),...(input.batches||[])].every(validUuid))errors.assignments='The course or batch selection is invalid. Refresh it and retry.';
 return errors;
}
export function staffAccountErrors(input) {
 if(input.role===undefined||input.role==='teacher')return teacherAccountErrors(input);
 const errors=teacherAccountErrors({...input,courses:[],batches:[]});
 if(input.role!=='creator')errors.role='Choose Teacher or Test Creator.';
 if(!Array.isArray(input.exams)||!input.exams.length||input.exams.length>100||!input.exams.every(validUuid))errors.assignments='Select at least one valid exam for this Test Creator.';
 if((input.courses?.length||input.batches?.length))errors.assignments='Test Creators receive exam access. Remove course and batch assignments.';
 if(errors.request_id)errors.request_id='This form has expired. Close it and start a new account operation.';
 return errors;
}
