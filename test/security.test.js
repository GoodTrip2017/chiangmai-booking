const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const vm = require('node:vm');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { Pool } = require('pg');
if (!process.env.TEST_DATABASE_URL) throw new Error('Security tests require a disposable TEST_DATABASE_URL.');
const schema = 'security_' + crypto.randomBytes(8).toString('hex');
const adminDb = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
const databaseUrl = new URL(process.env.TEST_DATABASE_URL);
databaseUrl.searchParams.set('options', '-c search_path=' + schema + ',public');
process.env.DATABASE_URL = databaseUrl.toString();
process.env.DATABASE_SSL = 'false';
process.env.NODE_ENV = 'test';
for (const key of ['RESEND_API_KEY', 'MAIL_FROM', 'LINE_CHANNEL_ACCESS_TOKEN', 'LINE_CHANNEL_SECRET', 'LINE_GROUP_ID']) delete process.env[key];
const { pool } = require('../src/db');
const { migrate } = require('../src/db/migrate');
const auth = require('../src/services/auth');
const booking = require('../src/services/booking');
const { createApp } = require('../src/app');
const password = crypto.randomBytes(24).toString('hex');
const form = { name: 'Security fixture', pax: 1, date: '2099-01-01', slot: '14:30-16:30', firstTime: '否', email: 'test@example.invalid', referral: '網路搜尋' };
let server, origin;
const children = new Set();
// Raw HTTP preserves encoded traversal paths and allows testing malformed bodies.
async function request(path, { method = 'GET', body, raw, cookie, csrf, headers = {}, base = origin } = {}) {
  const bytes = raw !== undefined ? raw : body !== undefined ? JSON.stringify(body) : method === 'GET' || method === 'HEAD' ? undefined : '{}';
  return new Promise((resolve, reject) => {
    const req = http.request(base, { path, method, headers: {
      ...(bytes === undefined ? {} : { Origin: process.env.APP_ORIGIN || base, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(bytes) }),
      ...(cookie ? { Cookie: cookie } : {}), ...(csrf ? { 'X-CSRF-Token': csrf } : {}), ...headers,
    } }, res => {
      let text = ''; res.setEncoding('utf8'); res.on('data', c => { text += c; });
      res.on('end', () => { let data; try { data = JSON.parse(text); } catch { data = text; } resolve({ status: res.statusCode, headers: res.headers, data, text }); });
    });
    req.setTimeout(5000, () => req.destroy(new Error('HTTP test timeout')));
    req.on('error', reject); req.end(bytes);
  });
}
async function login(extra = {}) {
  const res = await request('/api/admin/login', { method: 'POST', body: { password }, ...extra });
  assert.equal(res.status, 200, res.text);
  return { cookie: res.headers['set-cookie'][0].split(';')[0], csrf: res.data.csrfToken };
}
async function restartApp(production = false) {
  if (server) { server.closeAllConnections(); await new Promise(r => server.close(r)); }
  process.env.NODE_ENV = production ? 'production' : 'test';
  server = createApp().listen(0, '127.0.0.1'); await once(server, 'listening');
  origin = 'http://127.0.0.1:' + server.address().port;
  process.env.APP_ORIGIN = production ? 'https://booking.example.invalid' : origin;
}
async function startChild(env = {}) {
  const child = spawn(process.execPath, ['test/helpers/security-server.js'], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  children.add(child); child.once('exit', () => children.delete(child));
  child.output = ''; child.stdout.on('data', c => { child.output += c; }); child.stderr.on('data', c => { child.output += c; });
  const url = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Child startup timeout')), 5000);
    child.stdout.on('data', () => { const match = child.output.match(/TEST_URL=(http:\/\/127\.0\.0\.1:\d+)/); if (match) { clearTimeout(timer); resolve(match[1]); } });
    child.once('exit', code => { clearTimeout(timer); reject(new Error('Child failed: ' + code + ' ' + child.output)); });
  });
  return { child, url };
}
async function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const ended = once(child, 'exit'); child.kill('SIGTERM'); await ended;
}
before(async () => {
  await adminDb.query(`CREATE SCHEMA "${schema}"`); await migrate();
  process.env.ADMIN_PASSWORD_HASH = await auth.hashPassword(password);
  await restartApp();
});
beforeEach(async () => {
  await pool.query('TRUNCATE bookings, admin_sessions, admin_login_limits');
  await pool.query('TRUNCATE line_group_candidates');
  if ((await pool.query("SELECT to_regclass('request_limits') AS table_name")).rows[0].table_name) await pool.query('TRUNCATE request_limits');
});
after(async () => {
  for (const child of children) await stopChild(child);
  if (server) { server.closeAllConnections(); await new Promise(r => server.close(r)); }
  await pool.end(); await adminDb.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); await adminDb.end();
});

test('SEC-01: every admin endpoint rejects anonymous/forged credentials and never returns customer data', async () => {
  const b = await booking.createManualBooking(form);
  const paths = [['GET','/admin'],['GET','/api/admin/week'],['GET','/api/admin/session'],['POST','/api/admin/bookings'],['PUT',`/api/admin/bookings/${b.id}`],['POST',`/api/admin/bookings/${b.id}/cancel`],['POST',`/api/admin/bookings/${b.id}/resend-mail`],['POST','/api/admin/logout']];
  for (const [method,path] of paths) for (const cookie of ['', 'admin_session=' + 'a'.repeat(64), '__Host-admin_session=' + 'b'.repeat(64)]) {
    const r = await request(path + '?token=legacy', { method, cookie, body: method === 'GET' ? undefined : form, headers: { 'X-Admin-Token':'legacy', Authorization:'Bearer legacy' } });
    assert.ok([401,303].includes(r.status), path + ': ' + r.status); assert.ok(!r.text.includes(form.email));
  }
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM bookings WHERE status=\'CONFIRMED\'')).rows[0].n, 1);
});
test('SEC-02: origin, content type, absent/mismatched/session-swapped CSRF cannot change bookings', async () => {
  const a = await login(), b = await login(), saved = await booking.createManualBooking(form);
  const targets = [['POST','/api/admin/bookings'],['PUT',`/api/admin/bookings/${saved.id}`],['POST',`/api/admin/bookings/${saved.id}/cancel`],['POST',`/api/admin/bookings/${saved.id}/resend-mail`],['POST','/api/admin/logout']];
  const variants = [{ csrf:'' },{ csrf:'x'.repeat(64) },{ csrf:b.csrf },{ headers:{ Origin:'https://attacker.invalid' } },{ headers:{ Origin:'' } },{ headers:{ Origin:'null' } },{ headers:{ 'Content-Type':'text/plain' } },{ headers:{ 'Sec-Fetch-Site':'cross-site' } }];
  for (const variation of variants) for (const [method,path] of targets) {
    const r = await request(path, { ...a, method, body:form, ...variation });
    assert.ok([403,415].includes(r.status), JSON.stringify(variation) + ': ' + r.status);
  }
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM bookings')).rows[0].n, 1);
  assert.equal((await pool.query('SELECT status FROM bookings WHERE id=$1',[saved.id])).rows[0].status,'CONFIRMED');
});
test('SEC-03: successful login rotates sessions; raw cookies are never stored; logout invalidates replay', async () => {
  const a = await login(); const b = await login({cookie:a.cookie}); assert.notEqual(a.cookie,b.cookie);
  assert.equal((await request('/api/admin/session',a)).status,401);
  const token = b.cookie.split('=')[1];
  const rows = (await pool.query('SELECT * FROM admin_sessions')).rows;
  assert.ok(!JSON.stringify(rows).includes(token)); assert.equal(rows[0].token_hash,crypto.createHash('sha256').update(token).digest('hex'));
  assert.equal((await request('/api/admin/logout',{...b,method:'POST'})).status,200);
  assert.equal((await request('/api/admin/session',b)).status,401);
});
test('SEC-04: route case variants, errors and authenticated HTML all prohibit caching and embedding', async () => {
  const session = await login();
  for (const path of ['/admin','/ADMIN','/admin/login','/API/admin/week','/api/admin/session','/api/missing','/healthz']) {
    const r = await request(path,session);
    assert.equal(r.headers['cache-control'],'no-store',path);
    assert.equal(r.headers['x-frame-options'],'DENY'); assert.equal(r.headers['x-content-type-options'],'nosniff');
    assert.equal(r.headers['referrer-policy'],'no-referrer'); assert.ok(!r.headers['x-powered-by']);
    assert.match(r.headers['content-security-policy'],/frame-ancestors 'none'/);
    assert.doesNotMatch(r.headers['content-security-policy'].split('script-src ')[1].split(';')[0],/unsafe-inline|unsafe-eval/);
    assert.ok(!r.headers['access-control-allow-origin']);
  }
});
test('SEC-05: backup/source/config files and encoded traversal cannot expose private assets', async () => {
  for (const path of ['/.env','/.env.example','/.git/config','/package.json','/package-lock.json','/src/server.js','/src/db/schema.sql','/views/admin.html','/README.md','/admin.html.bak','/%2e%2e/views/admin.html','/assets/..%2f..%2fviews/admin.html','/assets/%2e%2e/%2e%2e/.env','//evil.invalid','/admin?next=https://evil.invalid','/admin/login?token=secret']) {
    const r = await request(path); assert.ok([400,403,404,303].includes(r.status), path + ': ' + r.status);
    assert.ok(!r.text.includes('DATABASE_URL')); assert.ok(!r.text.includes('id="fEmail"'));
    if (r.headers.location) assert.ok(['/admin','/admin/login'].includes(r.headers.location));
  }
});
test('SEC-06: typed validation rejects arrays, booleans, objects, controls, malformed UUID and recipient injection', async () => {
  for (const [field,values] of Object.entries({ name:[['Name'],{},42,'bad\u0000name'],pax:[true,[1],{},'1e1','0xA',Infinity],email:[['test@example.invalid'],'Name<test@example.invalid>','a@example.invalid\r\nBcc:b@example.invalid','a\u0000@example.invalid'],date:[['2099-01-01']],note:[{x:'x'},'bad\u0000note'],requestId:[[crypto.randomUUID()],{}] })) {
    for (const value of values) await assert.rejects(booking.createManualBooking({...form,[field]:value}),{status:400}, field + ':' + JSON.stringify(value));
  }
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM bookings')).rows[0].n,0);
});
test('SEC-07: SQL injection and mass assignment remain inert; public queries contain no PII', async () => {
  const payload = {...form,name:"x'); DROP TABLE bookings; --",pax:1,source:'PHONE',status:'CANCELLED',mail_status:'ACCEPTED',id:crypto.randomUUID(),line:'private-LINE',note:'private-note',__proto__:null};
  const r = await booking.submitBooking(payload); assert.equal(r.ok,true);
  const stored=(await pool.query('SELECT * FROM bookings')).rows[0];
  assert.equal(stored.name,payload.name); assert.equal(stored.source,'WEB'); assert.equal(stored.status,'CONFIRMED'); assert.notEqual(stored.id,payload.id);
  const available=await request('/api/availability?date='+form.date);
  for (const value of [form.email,payload.name,payload.line,payload.note,stored.id,stored.request_key]) assert.ok(!available.text.includes(value));
  for (const path of ['/api/availability?date=2099-01-01%27%3BSELECT%20pg_sleep(9)--','/api/availability?date[]=2099-01-01','/api/availability?date=2099-01-01&date=2099-01-02']) assert.equal((await request(path)).status,400,path);
});
test('SEC-08: reusing a public request key after staff edits/cancels reveals no edited PII or false success', async () => {
  const input={...form,requestId:crypto.randomUUID()}; await booking.submitBooking(input);
  const b=(await pool.query('SELECT * FROM bookings')).rows[0];
  await booking.updateBooking({...form,id:b.id,name:'Private staff correction',email:'private@example.invalid'});
  await assert.rejects(booking.submitBooking(input),err=>err.status===409 && !err.message.includes('private@example.invalid'));
  await booking.cancelBooking(b.id); await assert.rejects(booking.submitBooking(input),{status:409});
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM bookings')).rows[0].n,1);
});
test('SEC-09: all stored customer fields including legacy source render as escaped text', () => {
  const nodes=new Map();
  const context={document:{getElementById(id){if(!nodes.has(id))nodes.set(id,{style:{},addEventListener(){},value:''});return nodes.get(id);},querySelectorAll(){return[];}},fetch:async()=>({ok:true,json:async()=>({})}),location:{replace(){}}};
  vm.createContext(context); vm.runInContext(fs.readFileSync('public/assets/admin.js','utf8'),context);
  context.week={maxPax:12}; const attack='<img src=x onerror=alert(1)>';
  const html=context.cellHtml({}, {groups:1,totalPax:1,bookings:[{name:attack,line:attack,email:attack,referral:attack,note:attack,source:attack,pax:1}]},0,0);
  assert.ok(!html.includes('<img'),html); assert.ok(html.includes('&lt;img'));
});
test('SEC-10: malformed/oversized/compressed JSON cannot crash the server or expose parsing contents', async () => {
  const cases=[['{"secret-marker":',{},400],['[]',{},400],['null',{},400],['"scalar"',{},400],[JSON.stringify({name:'x'.repeat(40*1024)}),{},413],[require('node:zlib').gzipSync(Buffer.from('{"events":[]}')),{'Content-Encoding':'gzip'},415]];
  for (const [raw,headers,status] of cases) { const r=await request('/webhook/line',{method:'POST',raw,headers}); assert.equal(r.status,status); assert.ok(!r.text.includes('secret-marker')); }
  assert.equal((await request('/healthz')).status,200);
});
test('SEC-11: LINE signature rejects mutations; even correctly signed malformed events cannot terminate process', async () => {
  const secret=crypto.randomBytes(32).toString('hex'); const {child,url}=await startChild({LINE_CHANNEL_SECRET:secret});
  try {
    const raw=JSON.stringify({events:[]}); const sign=s=>crypto.createHmac('sha256',secret).update(s).digest('base64');
    assert.equal((await request('/webhook/line',{base:url,method:'POST',raw})).status,401);
    assert.equal((await request('/webhook/line',{base:url,method:'POST',raw,headers:{'X-Line-Signature':'é'}})).status,401);
    assert.equal((await request('/webhook/line',{base:url,method:'POST',raw:raw+' ',headers:{'X-Line-Signature':sign(raw)}})).status,401);
    assert.equal((await request('/webhook/line',{base:url,method:'POST',raw,headers:{'X-Line-Signature':sign(raw)}})).status,200);
    const groupId='C'+'a'.repeat(32);
    const joined=JSON.stringify({events:[{type:'join',source:{type:'group',groupId}}]});
    assert.equal((await request('/webhook/line',{base:url,method:'POST',raw:joined})).status,401);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM line_group_candidates')).rows[0].n,0);
    assert.equal((await request('/webhook/line',{base:url,method:'POST',raw:joined,headers:{'X-Line-Signature':sign(joined)}})).status,200);
    assert.equal((await request('/api/admin/line/groups')).status,401);
    const session=await login();
    const groups=await request('/api/admin/line/groups',session);
    assert.equal(groups.status,200);
    assert.equal(groups.data.groups[0].group_id,groupId);
    for (const events of [{},'invalid',[null],[{}],Array.from({length:101},()=>({type:'message'}))]) {
      const body=JSON.stringify({events}); const r=await request('/webhook/line',{base:url,method:'POST',raw:body,headers:{'X-Line-Signature':sign(body)}}); assert.equal(r.status,400);
      assert.equal((await request('/healthz',{base:url})).status,200);
    }
  } finally {await stopChild(child);}
});
test('SEC-12: login quota survives real process replacement and is shared atomically across workers', async () => {
  let a=await startChild(), b=await startChild();
  try {
    const attempts=await Promise.all(Array.from({length:6},(_,i)=>request('/api/admin/login',{base:i%2?a.url:b.url,method:'POST',body:{password:'wrong'}})));
    assert.equal(attempts.filter(r=>r.status===401).length,5); assert.equal(attempts.filter(r=>r.status===429).length,1);
    await stopChild(a.child); a=await startChild();
    const blocked=await request('/api/admin/login',{base:a.url,method:'POST',body:{password}}); assert.equal(blocked.status,429); assert.ok(Number(blocked.headers['retry-after'])>0);
    await pool.query("UPDATE admin_login_limits SET expires_at=now()-interval '1 second'");
    assert.equal((await request('/api/admin/login',{base:a.url,method:'POST',body:{password}})).status,200);
    await pool.query("UPDATE admin_login_limits SET attempts=60 WHERE bucket='global'");
    assert.equal((await request('/api/admin/login',{base:b.url,method:'POST',body:{password}})).status,429);
  } finally {await stopChild(a.child); await stopChild(b.child);}
});
test('SEC-13: public booking quotas survive restart, are atomic across workers, and enforce daily limits', async () => {
  let a=await startChild(), b=await startChild();
  try {
    const attempts=await Promise.all(Array.from({length:4},(_,i)=>request('/api/bookings',{base:i%2?a.url:b.url,method:'POST',body:{...form,email:''}})));
    assert.equal(attempts.filter(r=>r.status===400).length,3); assert.equal(attempts.filter(r=>r.status===429).length,1);
    await stopChild(a.child); a=await startChild();
    assert.equal((await request('/api/bookings',{base:a.url,method:'POST',body:form})).status,429);
    await pool.query("UPDATE request_limits SET expires_at=now()-interval '1 second' WHERE bucket LIKE 'booking-minute:%'");
    await pool.query("UPDATE request_limits SET attempts=20 WHERE bucket LIKE 'booking-day:%'");
    const blocked=await request('/api/bookings',{base:b.url,method:'POST',body:form}); assert.equal(blocked.status,429); assert.ok(Number(blocked.headers['retry-after'])>60);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM bookings')).rows[0].n,0);
  } finally {await stopChild(a.child); await stopChild(b.child);}
});
test('SEC-14: proxy simulation ignores forged leftmost addresses and groups IPv6 subnet addresses', async () => {
  await restartApp(true);
  try {
    for(let i=0;i<5;i++) assert.equal((await request('/api/admin/login',{method:'POST',body:{password:'wrong'},headers:{'X-Forwarded-For':`203.0.113.${i}, 198.51.100.8`,'X-Real-IP':`192.0.2.${i}`}})).status,401);
    assert.equal((await request('/api/admin/login',{method:'POST',body:{password},headers:{'X-Forwarded-For':'192.0.2.254, 198.51.100.8'}})).status,429);
    await pool.query('TRUNCATE admin_login_limits');
    for(let i=0;i<5;i++) assert.equal((await request('/api/admin/login',{method:'POST',body:{password:'wrong'},headers:{'X-Forwarded-For':`2001:db8:abcd:12::${i+1}`}})).status,401);
    assert.equal((await request('/api/admin/login',{method:'POST',body:{password},headers:{'X-Forwarded-For':'2001:db8:abcd:34::1234'}})).status,429);
    const good=await login({headers:{'X-Forwarded-For':'198.51.100.9','X-Forwarded-Proto':'https'}});
    const r=await request('/api/admin/session',{...good,headers:{'X-Forwarded-For':'198.51.100.9','X-Forwarded-Proto':'https'}});
    assert.equal(r.status,200); assert.ok(good.cookie.startsWith('__Host-admin_session=')); assert.match(r.headers['strict-transport-security'],/max-age=31536000/);
    const duplicate=await request('/api/admin/session',{cookie:good.cookie+'; '+good.cookie}); assert.equal(duplicate.status,401);
  } finally {await restartApp();}
  for(let i=0;i<5;i++) assert.equal((await request('/api/admin/login',{method:'POST',body:{password:'wrong'},headers:{'X-Forwarded-For':`203.0.113.${i}`}})).status,401);
  assert.equal((await request('/api/admin/login',{method:'POST',body:{password},headers:{'X-Forwarded-For':'203.0.113.100'}})).status,429);
});
test('SEC-15: concurrent mail resend is limited before outbound calls; browser retries cannot mail-bomb', async () => {
  const b=await booking.createManualBooking(form); const previous=global.fetch; let calls=0;
  process.env.RESEND_API_KEY='test-only'; process.env.MAIL_FROM='test@example.invalid';
  global.fetch=async(url,options)=>{ assert.equal(url,'https://api.resend.com/emails'); assert.ok(options.signal instanceof AbortSignal); calls++; return {ok:true,json:async()=>({id:'mock-only'})}; };
  try {
    const results=await Promise.allSettled(Array.from({length:8},()=>booking.resendConfirmation(b.id)));
    assert.equal(results.filter(r=>r.status==='fulfilled').length,1); assert.equal(results.filter(r=>r.status==='rejected'&&r.reason.status===429).length,7); assert.equal(calls,1);
    await pool.query("UPDATE request_limits SET expires_at=now()-interval '1 second' WHERE bucket LIKE 'resend:%'");
    await pool.query("UPDATE request_limits SET attempts=60 WHERE bucket='resend-hour'");
    await assert.rejects(booking.resendConfirmation(b.id),{status:429}); assert.equal(calls,1);
  } finally {global.fetch=previous; delete process.env.RESEND_API_KEY; delete process.env.MAIL_FROM;}
});
test('SEC-16: database failures fail closed; responses and application logs omit secrets/SQL details', async () => {
  const session=await login(), query=pool.query, log=console.error; const logs=[];
  pool.query=async()=>{throw Object.assign(new Error('postgres://sensitive-password@db SELECT customer-email'),{code:'ECONNREFUSED'});}; console.error=(...args)=>logs.push(args.join(' '));
  try {
    for(const path of ['/admin','/api/admin/week','/api/availability?date='+form.date]) {const r=await request(path,session); assert.equal(r.status,500); assert.deepEqual(r.data,{error:'服務暫時無法處理，請稍後再試。'});}
    assert.equal((await request('/healthz')).status,503);
    assert.ok(!logs.join('\n').includes('sensitive-password')); assert.ok(!logs.join('\n').includes('customer-email'));
  } finally {pool.query=query;console.error=log;}
});
test('SEC-17: production startup rejects missing/legacy hashes and unsafe origins before opening a port', async () => {
  const configs=[{ADMIN_PASSWORD_HASH:''},{ADMIN_PASSWORD_HASH:'scrypt:'+ 'a'.repeat(32)+':'+ 'b'.repeat(128)},{APP_ORIGIN:'http://booking.invalid'},{APP_ORIGIN:'https://booking.invalid/path'},{APP_ORIGIN:'https://user:password@booking.invalid'},{APP_ORIGIN:'',RAILWAY_PUBLIC_DOMAIN:''},{DATABASE_URL:''},{DATABASE_SSL:''},{NODE_TLS_REJECT_UNAUTHORIZED:'0'}];
  for(const config of configs) {
    const child=spawn(process.execPath,['src/server.js'],{env:{...process.env,NODE_ENV:'production',APP_ORIGIN:'https://booking.invalid',...config},stdio:['ignore','pipe','pipe']});
    children.add(child); let output=''; child.stdout.on('data',c=>output+=c);child.stderr.on('data',c=>output+=c);
    const timer=setTimeout(()=>child.kill('SIGKILL'),5000); const [code,signal]=await once(child,'exit');clearTimeout(timer);children.delete(child);
    assert.equal(signal,null);assert.equal(code,1,output);assert.ok(!output.includes('系統已啟動'));assert.ok(!output.includes(password));
  }
});
test('SEC-18: prototype pollution and body identifier replacement cannot grant privileges or edit another booking', async () => {
  const first=await booking.createManualBooking(form), second=await booking.createManualBooking(form), session=await login();
  const input=JSON.parse(JSON.stringify({...form,id:second.id,status:'CANCELLED',source:'<script>alert(1)</script>'}).slice(0,-1)+',"__proto__":{"admin":true},"constructor":{"prototype":{"admin":true}}}');
  const r=await request('/api/admin/bookings/'+first.id,{...session,method:'PUT',body:{...input,name:'Edited first'}});assert.equal(r.status,200);assert.equal({}.admin,undefined);
  const rows=(await pool.query('SELECT id,name,status,source FROM bookings ORDER BY id')).rows;
  assert.equal(rows.find(b=>b.id===first.id).name,'Edited first');assert.equal(rows.find(b=>b.id===second.id).name,form.name);
  assert.ok(rows.every(b=>b.status==='CONFIRMED'&&b.source==='WALK_IN'));
  assert.equal((await request('/api/admin/week',{...session,headers:{Origin:'https://evil.invalid'}})).headers['access-control-allow-origin'],undefined);
});
test('SEC-19: admin edit/cancel/resend rejects invalid or nonexistent IDs and cancelled edits', async () => {
  const session=await login(), b=await booking.createManualBooking(form);
  for(const id of ['not-a-uuid',"x%27%3BOR%201%3D1--",crypto.randomUUID()]) for(const [method,suffix] of [['PUT',''],['POST','/cancel'],['POST','/resend-mail']]) {
    const r=await request('/api/admin/bookings/'+id+suffix,{...session,method,body:form}); assert.ok([400,404].includes(r.status));
  }
  await booking.cancelBooking(b.id);await assert.rejects(booking.updateBooking({...form,id:b.id}),{status:409});await assert.rejects(booking.resendConfirmation(b.id),{status:409});
  assert.equal((await pool.query('SELECT status FROM bookings WHERE id=$1',[b.id])).rows[0].status,'CANCELLED');
});
test('SEC-20: URL flags and ambient PGSSLMODE cannot disable TLS verification or discard the configured CA', () => {
  const {connectionConfig}=require('../src/db/config');const {Client}=require('pg');
  for(const query of ['sslmode=no-verify','sslmode=disable','sslmode=require','ssl=true','sslrootcert=/tmp/fake','uselibpqcompat=true&sslmode=require']) {
    assert.throws(()=>connectionConfig({DATABASE_URL:'postgres://u:p@db.invalid/db?'+query,DATABASE_SSL:'true',DATABASE_CA_CERT:'test'}),/請移除/);
  }
  const config=connectionConfig({DATABASE_URL:'postgres://u:p@db.invalid/db',DATABASE_SSL:'true',DATABASE_CA_CERT:'line1\\nline2'});
  const client=new Client(config);assert.equal(client.ssl.rejectUnauthorized,true);assert.equal(client.ssl.ca,'line1\nline2');
  assert.equal(new Client(connectionConfig({DATABASE_URL:'postgres://u:p@localhost/db',DATABASE_SSL:'false'})).ssl,false);
  assert.throws(()=>connectionConfig({DATABASE_URL:'not a URL with secret'}),err=>!err.message.includes('secret'));
  assert.throws(()=>connectionConfig({DATABASE_SSL:'tru'}));
});
test('SEC-21: actual PostgreSQL TLS handshake rejects an untrusted certificate and accepts explicit test CA', async () => {
  const {mkdtempSync,readFileSync,rmSync}=fs;const os=require('node:os');const path=require('node:path');const net=require('node:net');const tls=require('node:tls');const {execFileSync}=require('node:child_process');const {Client}=require('pg');const {connectionConfig}=require('../src/db/config');
  const dir=mkdtempSync(path.join(os.tmpdir(),'booking-test-cert-'));const key=path.join(dir,'key.pem'),cert=path.join(dir,'cert.pem');
  // Ephemeral key/certificate only; never packaged in the app.
  execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',key,'-out',cert,'-days','1','-subj','/CN=localhost','-addext','subjectAltName=DNS:localhost'],{stdio:'ignore'});
  const ca=readFileSync(cert,'utf8'),context=tls.createSecureContext({key:readFileSync(key),cert:ca});let trustedStartups=0;const sockets=new Set();
  const fakePg=net.createServer(socket=>{
    sockets.add(socket);socket.on('error',()=>{});socket.on('close',()=>sockets.delete(socket));
    socket.once('data',bytes=>{
      assert.equal(bytes.readInt32BE(4),80877103);socket.write('S');
      const secure=new tls.TLSSocket(socket,{isServer:true,secureContext:context});secure.on('error',()=>{});
      secure.once('data',()=>{
        trustedStartups++;
        const message=Buffer.from('SFATAL\0C28000\0MTEST_TLS_HANDSHAKE_OK\0\0');const reply=Buffer.alloc(message.length+5);reply[0]=69;reply.writeInt32BE(message.length+4,1);message.copy(reply,5);secure.end(reply);
      });
    });
  });
  await new Promise(r=>fakePg.listen(0,'127.0.0.1',r));
  try {
    // pg connects to localhost for hostname verification, listener is loopback only.
    const url=`postgres://test:test@localhost:${fakePg.address().port}/test`;
    const untrusted=new Client(connectionConfig({DATABASE_URL:url,DATABASE_SSL:'true'}));
    try {await assert.rejects(untrusted.connect(),err=>['DEPTH_ZERO_SELF_SIGNED_CERT','SELF_SIGNED_CERT_IN_CHAIN'].includes(err.code));} finally {await untrusted.end();}
    assert.equal(trustedStartups,0);
    const trusted=new Client(connectionConfig({DATABASE_URL:url,DATABASE_SSL:'true',DATABASE_CA_CERT:ca}));
    try {await assert.rejects(trusted.connect(),err=>err.code==='28000'&&err.message==='TEST_TLS_HANDSHAKE_OK');} finally {await trusted.end();}
    assert.equal(trustedStartups,1);
    const wrongHost=new Client(connectionConfig({DATABASE_URL:url.replace('localhost','127.0.0.1'),DATABASE_SSL:'true',DATABASE_CA_CERT:ca}));
    try {await assert.rejects(wrongHost.connect(),err=>err.code==='ERR_TLS_CERT_ALTNAME_INVALID');} finally {await wrongHost.end();}
    assert.equal(trustedStartups,1);
  } finally {for(const socket of sockets)socket.destroy();await new Promise(r=>fakePg.close(r));rmSync(dir,{recursive:true,force:true});}
});
test('SEC-22: Railway edge IP controls booking and login quotas despite changing forwarded headers', async () => {
  const prior = process.env.RAILWAY_ENVIRONMENT_ID;
  process.env.RAILWAY_ENVIRONMENT_ID = 'railway-proxy-regression';
  await restartApp(true);
  const headers = i => ({ 'X-Real-IP': '198.51.100.42', 'X-Forwarded-For': `203.0.113.${i}`, 'CF-Connecting-IP': `192.0.2.${i}` });
  try {
    for (let i=1;i<=3;i++) assert.equal((await request('/api/bookings',{method:'POST',body:{...form,email:''},headers:headers(i)})).status,400);
    assert.equal((await request('/api/bookings',{method:'POST',body:form,headers:headers(4)})).status,429);
    for (let i=1;i<=5;i++) assert.equal((await request('/api/admin/login',{method:'POST',body:{password:'wrong'},headers:headers(i)})).status,401);
    assert.equal((await request('/api/admin/login',{method:'POST',body:{password},headers:headers(6)})).status,429);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM bookings')).rows[0].n,0);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM admin_sessions')).rows[0].n,0);
  } finally {
    if (prior===undefined) delete process.env.RAILWAY_ENVIRONMENT_ID; else process.env.RAILWAY_ENVIRONMENT_ID=prior;
    await restartApp();
  }
});
