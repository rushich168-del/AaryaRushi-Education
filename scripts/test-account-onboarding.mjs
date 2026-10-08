import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { chromium } from 'playwright'

let browser, bundle
before(async () => {
  const result = await build({
    stdin: { contents: `
      import React from 'react'; import {createRoot} from 'react-dom/client';
      import { AuthProvider } from './src/context/AuthContext.jsx';
      import SignupPage from './src/pages/SignupPage.jsx';
      import LoginPage from './src/pages/LoginPage.jsx';
      import PasswordRecoveryPage from './src/pages/PasswordRecoveryPage.jsx';
      import StaffRoute from './src/components/auth/StaffRoute.jsx';
      const StaffProbe = () => { window.staffMounts=(window.staffMounts || 0)+1; return <div>Staff tools loaded</div>; };
      import { useAuth } from './src/context/AuthContext.jsx';
      const SessionProbe = () => { const {session,loading}=useAuth(); return <div>{loading ? 'Pending session' : session ? 'Session active' : 'Session absent'}</div>; };
      import DashboardPage from './src/pages/DashboardPage.jsx';
      import StudentDashboardPage from './src/pages/student/StudentDashboardPage.jsx';

      const Router = ({ path }) => {
        if (path === '/staff') return <StaffRoute><StaffProbe /></StaffRoute>;
        if (path === '/probe') return <SessionProbe />;
        if (path === '/forgot-password') return <PasswordRecoveryPage />;
        if (path === '/reset-password') return <PasswordRecoveryPage reset />;
        if (path === '/signup') return <SignupPage />;
        if (path === '/login') return <LoginPage />;
        if (path === '/dashboard') return <DashboardPage />;
        if (path === '/dashboard/student') return <StudentDashboardPage />;
        return <div>Not Found</div>;
      };

      window.mount = path => {
        createRoot(document.getElementById('root')).render(
          <AuthProvider>
            <Router path={path} />
          </AuthProvider>
        );
      };
    `, resolveDir: process.cwd(), loader: 'jsx' },
    bundle: true, write: false, platform: 'browser', format: 'iife', jsx: 'automatic',
    plugins: [{ name: 'local-only-fixtures', setup(b) {
      b.onResolve({ filter: /supabaseClient\.js$/ }, () => ({ path: 'transport', namespace: 'fixture' }))
      b.onResolve({ filter: /studentExamService\.js$/ }, () => ({ path: 'student', namespace: 'fixture' }))
      b.onResolve({ filter: /resultService\.js$/ }, () => ({ path: 'result', namespace: 'fixture' }))
      b.onResolve({ filter: /routes\.js$/ }, () => ({ path: 'routes', namespace: 'fixture' }))

      b.onLoad({ filter: /.*/, namespace: 'fixture' }, ({ path }) => {
        if (path === 'routes') return { contents: `export const navigateTo = path => { window.navigatedTo = path; }; export const getCurrentPath = () => '/';`, loader: 'js' };
        if (path === 'student') return { contents: `export const studentExamService = { getAvailableTests: async () => { if (window.fixture.availableTestsError) throw new Error(window.fixture.availableTestsError); return window.fixture.availableTests || []; }, getMyAttempts: async () => window.fixture.attempts || [] };`, loader: 'js' };
        if (path === 'result') return { contents: `export const resultService = { triggerExpiredFinalization: async () => {} };`, loader: 'js' };

        return { contents: `
          export const isSupabaseConfigured = true;
          export const supabase = {
            auth: {
              getSession: async () => { if(window.fixture.sessionDelay) await new Promise(r=>window.releaseSession=r); return { data: { session: window.fixture.initialSession }, error: null }; },
              onAuthStateChange: callback => { window.emitAuth=callback; return { data: { subscription: { unsubscribe: () => {} } } }; },
              resetPasswordForEmail: async (email,options) => {
                window.recoveryRequest={email,options}; window.authCalls++;
                if(window.fixture.delay) await new Promise(r=>window.releaseAuth=r);
                if(window.fixture.authThrow) throw new Error('Failed to fetch');
                return {data:{},error:window.fixture.recoveryError || null};
              },
              updateUser: async () => {
                window.authCalls++;
                if(window.fixture.delay) await new Promise(r=>window.releaseAuth=r);
                if(window.fixture.authThrow) throw new Error('Failed to fetch');
                return {data:{user:window.fixture.initialSession?.user},error:window.fixture.recoveryError || null};
              },
              getUser: async () => ({ data: { user: window.fixture.initialSession?.user || null }, error: window.fixture.userError ? {message:'Session lookup failed'} : null }),
              signInWithPassword: async () => {
                const f = window.fixture;
                window.authCalls++;
                if (f.delay) await new Promise(resolve => { window.releaseAuth = resolve; });
                if (f.authThrow) throw new Error('Failed to fetch');
                if (f.signInError) return { data: null, error: { message: f.signInError, code:f.errorCode, status:f.errorStatus } };
                return { data: { session: f.sessionResult }, error: null };
              },
              signUp: async () => {
                const f = window.fixture;
                window.authCalls++;
                if (f.delay) await new Promise(resolve => { window.releaseAuth = resolve; });
                if (f.authThrow) throw new Error('Failed to fetch');
                if (f.signUpError) return { data: null, error: { message: f.signUpError, code:f.errorCode, status:f.errorStatus } };
                return { data: { user: f.userResult, session: f.sessionResult }, error: null };
              },
              signOut: async () => {}
            },
            from: table => ({ select: columns => ({ eq: (column, id) => ({ maybeSingle: async () => {
              window.profileQuery = {table,columns,column,id};
              const f = window.fixture;
              return {data:f.profileMissing ? null : {id},error:f.profileError ? {code:f.profileError,message:'Query failed'} : null};
            } }) }) }),
            rpc: async (name, args) => {
              const f = window.fixture;
              if (name === 'ksc_my_access') return f.access ? {data:f.access,error:null} : {data:null,error:{code:'PGRST202',message:'Staff update not installed'}};
              if (name === 'is_teacher') {
                if (f.roleError) return { data: null, error: { message: f.roleError } };
                return { data: f.isTeacher, error: null };
              }
              throw new Error('Unexpected RPC '+name);
            }
          };
        `, loader: 'js' }
      })
    }}]
  })
  bundle = result.outputFiles[0].text
  browser = await chromium.launch({ headless: true })
})
after(async () => { await browser?.close() })

async function open(t, data, path) {
  const context = await browser.newContext()
  t.after(() => context.close())
  const page = await context.newPage()
  page.setDefaultTimeout(5000)
  await context.route('**/*', route => route.request().url() === 'http://ksc.test/' ? route.fulfill({contentType:'text/html',body:'<div id="root"></div>'}) : route.abort())
  const errors=[]; page.on('pageerror',e=>errors.push(e.message))
  await page.goto('http://ksc.test/')
  await page.evaluate(data => {
    if (data.initialSession) data.initialSession.user = {id:'fixture-student', ...data.initialSession.user};
    window.fixture=data; window.navigatedTo = null; window.authCalls = 0;
  }, data)
  await page.addScriptTag({content:bundle})
  await page.evaluate(path => window.mount(path), path)
  await page.waitForFunction(() => !document.body.innerText.includes('Checking session') && !document.body.innerText.includes('Loading dashboard...'))
  assert.deepEqual(errors,[])
  return page
}

test('Signup requires confirmation, does not redirect to dashboard', async t => {
  const f = { userResult: { identities: [{}] }, sessionResult: null };
  const page = await open(t, f, '/signup');
  await page.fill('input[type="email"]', 'test@example.com');
  await page.fill('input[type="password"]', 'password123');
  await page.click('button[type="submit"]');

  await page.waitForFunction(() => document.body.innerText.includes('Check your inbox'));
  const nav = await page.evaluate(() => window.navigatedTo);
  assert.equal(nav, null);
});

test('Signup immediately creates session, redirects to dashboard', async t => {
  const f = { userResult: {}, sessionResult: { user: {} } };
  const page = await open(t, f, '/signup');
  await page.fill('input[type="email"]', 'test@example.com');
  await page.fill('input[type="password"]', 'password123');
  await page.click('button[type="submit"]');

  await page.waitForFunction(() => window.navigatedTo === '/dashboard');
  const nav = await page.evaluate(() => window.navigatedTo);
  assert.equal(nav, '/dashboard');
});

test('Signup shows user exists error when identities is empty', async t => {
  const f = { userResult: { identities: [] }, sessionResult: null };
  const page = await open(t, f, '/signup');
  await page.fill('input[type="email"]', 'test@example.com');
  await page.fill('input[type="password"]', 'password123');
  await page.click('button[type="submit"]');

  await page.waitForFunction(() => document.body.innerText.includes('already registered'));
});

test('Login shows error and stays on page', async t => {
  const f = { signInError: 'Invalid login credentials' };
  const page = await open(t, f, '/login');
  await page.fill('input[type="email"]', 'test@example.com');
  await page.fill('input[type="password"]', 'password123');
  await page.click('button[type="submit"]');

  await page.waitForFunction(() => document.body.innerText.includes('Check the email and password'));
});

test('Login success redirects to dashboard', async t => {
  const f = { sessionResult: { user: {} } };
  const page = await open(t, f, '/login');
  await page.fill('input[type="email"]', 'test@example.com');
  await page.fill('input[type="password"]', 'password123');
  await page.click('button[type="submit"]');

  await page.waitForFunction(() => window.navigatedTo === '/dashboard');
  const nav = await page.evaluate(() => window.navigatedTo);
  assert.equal(nav, '/dashboard');
});

test('DashboardPage role error shows explicit retryable state', async t => {
  const f = { initialSession: { user: {} }, roleError: 'PGRST timeout' };
  const page = await open(t, f, '/dashboard');

  await page.waitForFunction(() => document.body.innerText.includes('Failed to verify'));
  const text = await page.locator('body').innerText();
  assert.match(text, /Failed to verify/);
  assert.match(text, /Retry/); // the retry button
});

test('StudentDashboardPage missing profile explicitly shows profile incomplete', async t => {
  const f = { initialSession: { user: {} }, profileMissing: true };
  const page = await open(t, f, '/dashboard/student');

  await page.waitForFunction(() => document.body.innerText.includes('Profile Incomplete'));
  const text = await page.locator('body').innerText();
  assert.match(text, /Profile Incomplete/);
  assert.match(text, /student profile is not yet fully set up/);
  assert.match(text, /Course enrollment is separate/);
  assert.deepEqual(await page.evaluate(() => window.profileQuery), {table:'student_profiles',columns:'id',column:'id',id:'fixture-student'});
});

test('StudentDashboardPage empty tests shows honest empty state, not error', async t => {
  const f = { initialSession: { user: {} }, availableTests: [], attempts: [] };
  const page = await open(t, f, '/dashboard/student');

  await page.waitForFunction(() => document.body.innerText.includes('No new tests available'));
  const text = await page.locator('body').innerText();
  assert.match(text, /No new tests available/);
  assert.doesNotMatch(text, /Profile Incomplete|Error Loading/);
});

for (const route of ['/login', '/signup']) {
  test(`${route}: same-event submissions make one request; thrown failure releases form and retry succeeds`, async t => {
    const page = await open(t, {delay:true,authThrow:true}, route)
    await page.fill('input[type="email"]', 'test@example.com')
    await page.fill('input[type="password"]', 'password123')
    await page.evaluate(() => {
      const form = document.querySelector('form')
      form.dispatchEvent(new Event('submit', {bubbles:true,cancelable:true}))
      form.dispatchEvent(new Event('submit', {bubbles:true,cancelable:true}))
    })
    assert.equal(await page.evaluate(() => window.authCalls), 1)
    assert.equal(await page.locator('button[type="submit"]').isDisabled(), true)
    await page.evaluate(() => window.releaseAuth())
    await page.getByText('Network connection failed. Check your connection and try again.', {exact:true}).waitFor()
    assert.equal(await page.locator('button[type="submit"]').isEnabled(), true)
    await page.evaluate(() => Object.assign(window.fixture, {delay:false,authThrow:false,sessionResult:{user:{id:'fixture-student'}}}))
    await page.click('button[type="submit"]')
    await page.waitForFunction(() => window.navigatedTo === '/dashboard')
    assert.equal(await page.evaluate(() => window.authCalls), 2)
  })
}

for (const [route, code, message, expected] of [
  ['/signup','user_already_exists','User already registered','Try signing in if you already registered'],
  ['/signup','over_email_send_rate_limit','Email rate limit exceeded','email service has reached its sending limit'],
  ['/login','email_not_confirmed','Email not confirmed','Confirm your email'],
  ['/signup','unexpected_failure','Supabase auth database failure','Account creation failed'],
]) {
  test(`${route}: ${code} uses account wording and releases submit`, async t => {
    const page = await open(t, {[route === '/signup' ? 'signUpError' : 'signInError']:message,errorCode:code}, route)
    await page.fill('input[type="email"]', 'test@example.com')
    await page.fill('input[type="password"]', 'password123')
    await page.click('button[type="submit"]')
    await page.getByText(expected,{exact:false}).waitFor()
    assert.equal(await page.locator('button[type="submit"]').isEnabled(), true)
    assert.doesNotMatch(await page.locator('body').innerText(), /Project Atlas|file.*uploaded|workspace/i)
    assert.equal(await page.evaluate(() => window.navigatedTo), null)
  })
}

test('Null role cannot route as student; retry with a verified false result can', async t => {
  const page = await open(t, {initialSession:{user:{}},isTeacher:null}, '/dashboard')
  await page.getByRole('button', {name:'Retry',exact:true}).waitFor()
  assert.equal(await page.evaluate(() => window.navigatedTo), null)
  await page.evaluate(() => {window.fixture.isTeacher = false})
  await page.getByRole('button', {name:'Retry',exact:true}).click()
  await page.waitForFunction(() => window.navigatedTo === '/dashboard/student')
})

test('Session lookup failure cannot route even when a user is returned', async t => {
  const page = await open(t, {initialSession:{user:{}},userError:true,isTeacher:true}, '/dashboard')
  await page.getByRole('button',{name:'Retry',exact:true}).waitFor()
  assert.equal(await page.evaluate(() => window.navigatedTo), null)
  await page.evaluate(() => {window.fixture.userError = false})
  await page.getByRole('button',{name:'Retry',exact:true}).click()
  await page.waitForFunction(() => window.navigatedTo === '/dashboard/admin')
})

test('Profile query cardinality error is a retryable failure, not a missing profile', async t => {
  const page = await open(t, {initialSession:{user:{}},profileError:'PGRST116'}, '/dashboard/student')
  await page.getByRole('heading',{name:'Error Loading Dashboard'}).waitFor()
  assert.equal(await page.getByRole('heading',{name:'Profile Incomplete'}).count(),0)
  await page.evaluate(() => {window.fixture.profileError = null})
  await page.getByRole('button',{name:'Retry',exact:true}).click()
  await page.getByText('No new tests available at the moment.',{exact:true}).waitFor()
})

test('Missing profile retries after setup; test request failure remains a data error', async t => {
  const page = await open(t, {initialSession:{user:{}},profileMissing:true}, '/dashboard/student')
  await page.getByRole('heading',{name:'Profile Incomplete'}).waitFor()
  await page.evaluate(() => Object.assign(window.fixture,{profileMissing:false,availableTestsError:'student profile service unavailable'}))
  await page.getByRole('button',{name:'Retry',exact:true}).click()
  await page.getByRole('heading',{name:'Error Loading Dashboard'}).waitFor()
  assert.equal(await page.getByRole('heading',{name:'Profile Incomplete'}).count(),0)
})

test('Recovery request is neutral and uses current-origin reset destination', async t => {
  const page = await open(t, {}, '/forgot-password');
  await page.getByLabel('Email address').fill('learner@example.com');
  await page.getByRole('button', {name:'Send recovery link'}).click();
  await page.getByRole('status').waitFor();
  assert.match(await page.locator('body').innerText(), /If an account matches/);
  assert.equal(await page.evaluate(() => window.recoveryRequest.options.redirectTo), 'http://ksc.test/reset-password');
});

test('Recovery duplicate request is blocked; thrown failure permits retry', async t => {
  const page = await open(t, {delay:true,authThrow:true}, '/forgot-password');
  await page.getByLabel('Email address').fill('learner@example.com');
  await page.evaluate(() => {const form=document.querySelector('form'); form.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})); form.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));});
  assert.equal(await page.evaluate(() => window.authCalls),1);
  await page.evaluate(() => window.releaseAuth());
  await page.getByRole('alert').waitFor();
  await page.evaluate(() => {window.fixture.authThrow=false;window.fixture.delay=false;});
  await page.getByRole('button',{name:'Send recovery link'}).click();
  await page.getByRole('status').waitFor();
  assert.equal(await page.evaluate(() => window.authCalls),2);
});

test('Reset without session cannot update password', async t => {
  const page = await open(t, {}, '/reset-password');
  await page.getByText('This recovery link is invalid or expired.', {exact:false}).waitFor();
  assert.equal(await page.locator('input').count(),0);
  assert.equal(await page.evaluate(() => window.authCalls),0);
});

test('Reset validates confirmation and retains form on backend error, then succeeds', async t => {
  const page = await open(t, {initialSession:{user:{}},recoveryError:{code:'weak_password'}}, '/reset-password');
  await page.getByLabel('New password',{exact:true}).fill('new-password-123');
  await page.getByLabel('Confirm new password').fill('different-password');
  await page.getByRole('button',{name:'Update password'}).click();
  await page.getByText('Passwords do not match.').waitFor();
  assert.equal(await page.evaluate(() => window.authCalls),0);
  await page.getByLabel('Confirm new password').fill('new-password-123');
  await page.getByRole('button',{name:'Update password'}).click();
  await page.getByText('Choose a stronger password and try again.').waitFor();
  await page.evaluate(() => {window.fixture.recoveryError=null;});
  await page.getByRole('button',{name:'Update password'}).click();
  await page.getByText('Your password has been updated.').waitFor();
  assert.equal(await page.locator('input[type=password]').count(),0);
});

for (const event of ['SIGNED_IN','TOKEN_REFRESHED','SIGNED_OUT']) {
  test(`Late initial session lookup cannot overwrite ${event}`, async t => {
    const page = await open(t, {sessionDelay:true,initialSession:event==='SIGNED_OUT'?{user:{}}:null}, '/probe');
    await page.evaluate(event => window.emitAuth(event,event==='SIGNED_OUT'?null:{user:{id:'fresh'}}),event);
    await page.getByText(event==='SIGNED_OUT'?'Session absent':'Session active',{exact:true}).waitFor();
    await page.evaluate(() => window.releaseSession());
    await page.evaluate(() => new Promise(r=>setTimeout(r,50)));
    assert.equal(await page.locator('body').innerText(),event==='SIGNED_OUT'?'Session absent':'Session active');
  });
}

test('Recovery auth event routes to password form and survives late session lookup', async t => {
  const page = await open(t, {sessionDelay:true}, '/probe');
  await page.evaluate(() => window.emitAuth('PASSWORD_RECOVERY',{user:{id:'recovering'}}));
  assert.equal(new URL(page.url()).pathname,'/reset-password');
  await page.evaluate(() => window.releaseSession());
  await page.getByText('Session active',{exact:true}).waitFor();
});

test('Reset with URL error refuses update despite existing session', async t => {
  const page = await open(t, {initialSession:{user:{}}}, '/probe');
  await page.evaluate(() => {history.replaceState({},'', '/reset-password#error_code=otp_expired'); document.body.innerHTML='<div id="root"></div>';window.mount('/reset-password');});
  await page.getByText('This recovery link is invalid or expired.',{exact:false}).waitFor();
  assert.equal(await page.locator('input').count(),0);
});

for (const role of [false,null,true]) test(`Staff gate mounts tools only for exact true: ${role}`,async t=>{
 const page=await open(t,{initialSession:{user:{}},isTeacher:role},'/staff');
 await page.getByText(role===true?'Staff tools loaded':role===false?'Staff access required':'Unable to verify staff access',{exact:true}).waitFor();
 assert.equal(await page.evaluate(()=>window.staffMounts || 0),role===true?1:0);
});
test('Staff role failure is retryable without mounting staff tools',async t=>{
 const page=await open(t,{initialSession:{user:{}},roleError:'offline'},'/staff');
 await page.getByText('Unable to verify staff access',{exact:true}).waitFor();
 assert.equal(await page.evaluate(()=>window.staffMounts || 0),0);
 await page.evaluate(()=>{window.fixture.roleError=null;window.fixture.isTeacher=true;});
 await page.getByRole('button',{name:'Retry',exact:true}).click();
 await page.getByText('Staff tools loaded',{exact:true}).waitFor();
});

for(const [role,expected] of [['admin','/dashboard/admin'],['teacher','/dashboard/teacher'],['student','/dashboard/student']])test('Verified KSC role routes '+role+' to its distinct portal',async t=>{
 const page=await open(t,{initialSession:{user:{}},access:{role,state:'active',password_change_required:false}},'/dashboard');
 await page.waitForFunction(()=>!!window.navigatedTo);
 assert.equal(await page.evaluate(()=>window.navigatedTo),expected);
});
