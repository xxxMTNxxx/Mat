// Matgram v2 — بدون هیچ کتابخانه‌ی خارجی | اجرا: node matgram.js
const http = require('http'), crypto = require('crypto'), fs = require('fs'), path = require('path');
let DatabaseSync;
try { ({ DatabaseSync } = require('node:sqlite')); } catch { console.log('Node 22.5+ لازمه: pkg upgrade && pkg install nodejs'); process.exit(1); }
const db = new DatabaseSync(__dirname + '/matgram.db');
const UP = path.join(__dirname, 'uploads/'), LIM = 60 * 1024 * 1024;
fs.mkdirSync(UP, { recursive: true });
db.exec(`PRAGMA journal_mode=WAL;
CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY,username TEXT UNIQUE,name TEXT,bio TEXT DEFAULT '',pass TEXT,salt TEXT,last_seen INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY,uid INTEGER);
CREATE TABLE IF NOT EXISTS chats(id INTEGER PRIMARY KEY,type TEXT,title TEXT,owner INTEGER);
CREATE TABLE IF NOT EXISTS members(chat INTEGER,uid INTEGER,lr INTEGER DEFAULT 0,PRIMARY KEY(chat,uid));
CREATE TABLE IF NOT EXISTS msgs(id INTEGER PRIMARY KEY,chat INTEGER,sender INTEGER,text TEXT,img TEXT,reply INTEGER,ts INTEGER,edited INTEGER DEFAULT 0,del INTEGER DEFAULT 0);
CREATE INDEX IF NOT EXISTS ix ON msgs(chat,id);
CREATE TABLE IF NOT EXISTS reacts(msg INTEGER,uid INTEGER,e TEXT,PRIMARY KEY(msg,uid));
CREATE TABLE IF NOT EXISTS files(id TEXT PRIMARY KEY,mime TEXT);`);
['users ADD COLUMN color INTEGER DEFAULT -1', 'users ADD COLUMN hide INTEGER DEFAULT 0', 'users ADD COLUMN avatar TEXT',
 'chats ADD COLUMN avatar TEXT', 'chats ADD COLUMN about TEXT', 'chats ADD COLUMN pub INTEGER DEFAULT 0',
 'members ADD COLUMN clr INTEGER DEFAULT 0', 'msgs ADD COLUMN kind TEXT', 'msgs ADD COLUMN file TEXT', 'msgs ADD COLUMN fname TEXT',
 'msgs ADD COLUMN fsize INTEGER', 'msgs ADD COLUMN dur INTEGER', 'msgs ADD COLUMN fwd TEXT', 'chats ADD COLUMN handle TEXT'].forEach(c => { try { db.exec('ALTER TABLE ' + c); } catch {} });
const q = (s, ...a) => db.prepare(s).all(...a), q1 = (s, ...a) => db.prepare(s).get(...a), run = (s, ...a) => db.prepare(s).run(...a);
const PORT = +process.env.PORT || 5000;
const RX = ['like', 'heart', 'fire', 'star', 'bolt', 'gem'], KINDS = ['image', 'video', 'voice', 'file'];
const clients = new Map();
const hash = (p, s) => crypto.scryptSync(p, s, 32).toString('hex');
const pub = u => ({ id: u.id, name: u.name, username: u.username, bio: u.bio, avatar: u.avatar, online: clients.has(u.id), last_seen: u.hide ? 0 : u.last_seen, hide: u.hide });
const push = (uid, ev, d) => (clients.get(uid) || []).forEach(r => r.write('event: ' + ev + '\ndata: ' + JSON.stringify(d) + '\n\n'));
const mem = c => q('SELECT uid FROM members WHERE chat=?', c).map(x => x.uid);
const pushChat = (c, ev, d, ex) => mem(c).forEach(u => u !== ex && push(u, ev, d));
const isMem = (c, u) => q1('SELECT 1 x FROM members WHERE chat=? AND uid=?', c, u);
const body = req => new Promise(ok => { let b = ''; req.on('data', c => { b += c; if (b.length > 2e6) req.destroy(); }); req.on('end', () => { try { ok(JSON.parse(b || '{}')); } catch { ok({}); } }); });
const out = (res, code, o) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
const session = uid => { const t = crypto.randomBytes(24).toString('hex'); run('INSERT INTO sessions VALUES(?,?)', t, uid); return t; };
const LBL = { image: 'عکس', video: 'ویدئو', voice: 'پیام صوتی', file: 'فایل' };
const txt = m => m.del ? 'پیام حذف شد' : (m.text || LBL[m.kind || (m.img ? 'image' : '')] || 'پیام');
const okUrl = u => typeof u === 'string' && /^\/f\/[a-f0-9]{24}$/.test(u);
const wipe = c => { run('DELETE FROM reacts WHERE msg IN (SELECT id FROM msgs WHERE chat=?)', c); run('DELETE FROM msgs WHERE chat=?', c); run('DELETE FROM members WHERE chat=?', c); run('DELETE FROM chats WHERE id=?', c); };

const fm = m => {
  let r = null;
  if (m.reply) { const o = q1('SELECT m.text,m.kind,m.img,m.del,u.name FROM msgs m JOIN users u ON u.id=m.sender WHERE m.id=?', m.reply); if (o) r = { id: m.reply, name: o.name, text: txt(o) }; }
  return { id: m.id, chat: m.chat, sender: m.sender, sname: q1('SELECT name FROM users WHERE id=?', m.sender).name, text: m.del ? '' : m.text,
    kind: m.del ? 'text' : (m.kind || (m.img ? 'image' : 'text')), file: m.del ? null : (m.file || m.img || null), fname: m.fname, fsize: m.fsize, dur: m.dur, fwd: m.fwd,
    reply: r, ts: m.ts, edited: m.edited, del: m.del, re: q('SELECT e,COUNT(*) n,GROUP_CONCAT(uid) us FROM reacts WHERE msg=? GROUP BY e', m.id) };
};
const row = (c, u) => q1('SELECT c.*,m.lr,m.clr FROM chats c JOIN members m ON m.chat=c.id AND m.uid=? WHERE c.id=?', u, c);
const co = (c, uid) => {
  const l = q1('SELECT * FROM msgs WHERE chat=? AND id>? ORDER BY id DESC LIMIT 1', c.id, c.clr), lr = Math.max(c.lr, c.clr);
  let o = { id: c.id, type: c.type, title: c.title, about: c.about, owner: c.owner, avatar: c.avatar, handle: c.handle, last: l ? txt(l) : '', lts: l ? l.ts : 0,
    unread: q1('SELECT COUNT(*) n FROM msgs WHERE chat=? AND id>? AND sender!=? AND del=0', c.id, lr, uid).n };
  if (c.type === 'p') { const u = q1('SELECT u.* FROM users u JOIN members m ON m.uid=u.id WHERE m.chat=? AND u.id!=?', c.id, uid) || q1('SELECT * FROM users WHERE id=?', uid); o = { ...pub(u), ...o, title: u.name, uid: u.id, avatar: u.avatar }; }
  else o.n = mem(c.id).length;
  return o;
};
const markRead = (c, uid) => {
  const mx = q1('SELECT COALESCE(MAX(id),0) m FROM msgs WHERE chat=?', c).m, lr = q1('SELECT lr FROM members WHERE chat=? AND uid=?', c, uid).lr;
  if (mx > lr) { run('UPDATE members SET lr=? WHERE chat=? AND uid=?', mx, c, uid); pushChat(c, 'read', { chat: c }, uid); }
};
const ins = (c, sender, text, reply, f, fwd) => {
  const mid = Number(run('INSERT INTO msgs(chat,sender,text,reply,ts,kind,file,fname,fsize,dur,fwd) VALUES(?,?,?,?,?,?,?,?,?,?,?)', c, sender, text, reply || null, Date.now(),
    f ? f.kind : 'text', f ? f.url : null, f ? String(f.name || 'file').slice(0, 120) : null, f ? (+f.size || 0) : null, f ? (+f.dur || 0) : null, fwd || null).lastInsertRowid);
  run('UPDATE members SET lr=? WHERE chat=? AND uid=? AND lr<?', mid, c, sender, mid);
  pushChat(c, 'msg', fm(q1('SELECT * FROM msgs WHERE id=?', mid)));
};
const canPost = (c, uid) => { const ch = q1('SELECT * FROM chats WHERE id=?', c); return ch && isMem(c, uid) && (ch.type !== 'c' || ch.owner === uid); };

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x'), p = url.pathname;
  if (p === '/') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); return res.end(PAGE); }
  if (p.startsWith('/f/')) {
    const fid = p.slice(3), f = /^[a-f0-9]{24}$/.test(fid) && q1('SELECT mime FROM files WHERE id=?', fid);
    if (!f || !fs.existsSync(UP + fid)) return out(res, 404, { error: 'not found' });
    const size = fs.statSync(UP + fid).size, inl = /^(image\/(?!svg)|video\/|audio\/)/.test(f.mime), m = /bytes=(\d*)-(\d*)/.exec(req.headers.range || '');
    let s = 0, e = size - 1, code = 200;
    if (m) { code = 206; if (m[1]) { s = +m[1]; if (m[2]) e = Math.min(+m[2], e); } else if (m[2]) s = Math.max(0, size - +m[2]); }
    if (!size || s > e) { res.writeHead(416, { 'content-range': 'bytes */' + size }); return res.end(); }
    const h = { 'content-type': inl ? f.mime : 'application/octet-stream', 'accept-ranges': 'bytes', 'content-length': e - s + 1, 'x-content-type-options': 'nosniff', 'cache-control': 'private,max-age=31536000' };
    if (!inl) h['content-disposition'] = 'attachment';
    if (code === 206) h['content-range'] = 'bytes ' + s + '-' + e + '/' + size;
    res.writeHead(code, h); return fs.createReadStream(UP + fid, { start: s, end: e }).pipe(res);
  }
  if (!p.startsWith('/api/')) return out(res, 404, { error: 'not found' });
  const r = p.slice(5), b = req.method === 'POST' && r !== 'upload' ? await body(req) : {};

  if (r === 'register') {
    const un = String(b.username || '').toLowerCase(), pw = String(b.password || ''), nm = String(b.name || '').trim().slice(0, 30) || un;
    if (!/^[a-z0-9_]{3,20}$/.test(un)) return out(res, 400, { error: 'نام کاربری: ۳ تا ۲۰ حرف انگلیسی/عدد/_' });
    if (pw.length < 4) return out(res, 400, { error: 'رمز حداقل ۴ کاراکتر' });
    if (q1('SELECT 1 x FROM users WHERE username=?', un) || q1('SELECT 1 x FROM chats WHERE handle=?', un)) return out(res, 400, { error: 'این نام کاربری گرفته شده' });
    const salt = crypto.randomBytes(8).toString('hex');
    return out(res, 200, { token: session(Number(run('INSERT INTO users(username,name,pass,salt) VALUES(?,?,?,?)', un, nm, hash(pw, salt), salt).lastInsertRowid)) });
  }
  if (r === 'login') {
    const u = q1('SELECT * FROM users WHERE username=?', String(b.username || '').toLowerCase());
    if (!u || hash(String(b.password || ''), u.salt) !== u.pass) return out(res, 400, { error: 'نام کاربری یا رمز اشتباهه' });
    return out(res, 200, { token: session(u.id) });
  }
  const s = q1('SELECT uid FROM sessions WHERE token=?', req.headers['x-token'] || url.searchParams.get('t') || ''), me = s && q1('SELECT * FROM users WHERE id=?', s.uid);
  if (!me) return out(res, 401, { error: 'وارد نشدی' });
  const id = me.id;

  if (r === 'upload') {
    const fid = crypto.randomBytes(12).toString('hex'), m = String(url.searchParams.get('m') || '').split(';')[0], mime = /^[\w.+-]+\/[\w.+-]+$/.test(m) ? m : 'application/octet-stream', ws = fs.createWriteStream(UP + fid);
    let n = 0, bad = 0;
    req.on('data', c => { n += c.length; if (n > LIM && !bad) { bad = 1; ws.destroy(); req.destroy(); fs.unlink(UP + fid, () => {}); } });
    req.pipe(ws); ws.on('error', () => {});
    ws.on('finish', () => { if (bad) return; run('INSERT INTO files VALUES(?,?)', fid, mime); out(res, 200, { url: '/f/' + fid, size: n }); });
    return;
  }
  if (r === 'events') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' }); res.write(': hi\n\n');
    if (!clients.has(id)) clients.set(id, new Set());
    clients.get(id).add(res); clients.forEach((_, u) => push(u, 'presence', {}));
    const ping = setInterval(() => res.write(': p\n\n'), 25000);
    req.on('close', () => {
      clearInterval(ping); const set = clients.get(id); set && set.delete(res);
      if (set && !set.size) { clients.delete(id); run('UPDATE users SET last_seen=? WHERE id=?', Date.now(), id); clients.forEach((_, u) => push(u, 'presence', {})); }
    });
    return;
  }
  if (r === 'chats') return out(res, 200, { me: pub(me), chats: q('SELECT c.*,m.lr,m.clr FROM chats c JOIN members m ON m.chat=c.id AND m.uid=?', id).map(c => co(c, id)).filter(c => c.lts || c.type !== 'p').sort((a, b) => b.lts - a.lts || b.id - a.id) });
  if (r === 'users') {
    const k = '%' + String(url.searchParams.get('q') || '').toLowerCase().replace(/[%_]/g, '') + '%';
    return out(res, 200, { users: q('SELECT * FROM users WHERE username LIKE ? OR lower(name) LIKE ? LIMIT 20', k, k).map(pub),
      chats: q("SELECT * FROM chats WHERE type IN ('g','c') AND pub=1 AND (lower(title) LIKE ? OR handle LIKE ?) AND id NOT IN (SELECT chat FROM members WHERE uid=?) LIMIT 15", k, k, id).map(c => ({ id: c.id, type: c.type, title: c.title, about: c.about, handle: c.handle, avatar: c.avatar, n: mem(c.id).length })) });
  }
  if (r === 'open') {
    const t = Number(b.uid); if (!q1('SELECT 1 x FROM users WHERE id=?', t)) return out(res, 400, { error: 'کاربر نیست' });
    const n = t === id ? 1 : 2;
    let c = q1("SELECT c.id FROM chats c WHERE c.type='p' AND (SELECT COUNT(*) FROM members WHERE chat=c.id AND uid IN (?,?))=? AND (SELECT COUNT(*) FROM members WHERE chat=c.id)=?", id, t, n, n);
    if (!c) { c = { id: Number(run("INSERT INTO chats(type) VALUES('p')").lastInsertRowid) }; run('INSERT INTO members(chat,uid) VALUES(?,?)', c.id, id); if (t !== id) run('INSERT INTO members(chat,uid) VALUES(?,?)', c.id, t); }
    return out(res, 200, co(row(c.id, id), id));
  }
  if (r === 'group') {
    const t = String(b.title || '').trim().slice(0, 40), ty = b.type === 'c' ? 'c' : 'g'; if (!t) return out(res, 400, { error: 'اسم لازمه' });
    const hd = String(b.handle || '').trim().toLowerCase().replace(/^@/, '');
    if (b.pub) {
      if (!/^[a-z0-9_]{3,20}$/.test(hd)) return out(res, 400, { error: 'برای عمومی بودن نام کاربری لازمه (۳ تا ۲۰ حرف انگلیسی/عدد/_)' });
      if (q1('SELECT 1 x FROM users WHERE username=?', hd) || q1('SELECT 1 x FROM chats WHERE handle=?', hd)) return out(res, 400, { error: 'این نام کاربری قبلاً گرفته شده' });
    }
    const c = Number(run('INSERT INTO chats(type,title,owner,about,pub,handle) VALUES(?,?,?,?,?,?)', ty, t, id, String(b.about || '').slice(0, 200), b.pub ? 1 : 0, b.pub ? hd : null).lastInsertRowid); run('INSERT INTO members(chat,uid) VALUES(?,?)', c, id);
    (b.members || []).slice(0, 200).forEach(n => { const u = q1('SELECT id FROM users WHERE username=?', String(n)); u && run('INSERT OR IGNORE INTO members(chat,uid) VALUES(?,?)', c, u.id); });
    mem(c).forEach(u => push(u, 'chat', {})); return out(res, 200, co(row(c, id), id));
  }
  if (r === 'join') {
    const c = +b.chat, ch = q1("SELECT * FROM chats WHERE id=? AND pub=1 AND type IN ('g','c')", c); if (!ch) return out(res, 400, { error: 'پیدا نشد' });
    run('INSERT OR IGNORE INTO members(chat,uid) VALUES(?,?)', c, id); mem(c).forEach(u => push(u, 'chat', {})); return out(res, 200, co(row(c, id), id));
  }
  if (r === 'leave') {
    const c = +b.chat, ch = q1('SELECT * FROM chats WHERE id=?', c); if (!ch || ch.type === 'p' || !isMem(c, id)) return out(res, 400, { error: 'no' });
    run('DELETE FROM members WHERE chat=? AND uid=?', c, id); const ms = mem(c);
    if (!ms.length) wipe(c); else { if (ch.owner === id) run('UPDATE chats SET owner=? WHERE id=?', ms[0], c); ms.forEach(u => push(u, 'chat', {})); }
    return out(res, 200, {});
  }
  if (r === 'delgroup') {
    const c = +b.chat, ch = q1('SELECT * FROM chats WHERE id=?', c); if (!ch || ch.type === 'p' || ch.owner !== id) return out(res, 403, { error: 'no' });
    const ms = mem(c); wipe(c); ms.forEach(u => push(u, 'chat', {})); return out(res, 200, {});
  }
  if (r === 'clear') {
    const c = +b.chat; if (!isMem(c, id)) return out(res, 403, { error: 'no' });
    const mx = q1('SELECT COALESCE(MAX(id),0) m FROM msgs WHERE chat=?', c).m; run('UPDATE members SET clr=?,lr=? WHERE chat=? AND uid=?', mx, mx, c, id); return out(res, 200, {});
  }
  if (r === 'avatar') {
    const url2 = b.url === null ? null : okUrl(b.url) ? b.url : undefined; if (url2 === undefined) return out(res, 400, { error: 'no' });
    if (!b.chat) run('UPDATE users SET avatar=? WHERE id=?', url2, id);
    else { const ch = q1('SELECT * FROM chats WHERE id=?', +b.chat); if (!ch || ch.type === 'p' || ch.owner !== id) return out(res, 403, { error: 'no' }); run('UPDATE chats SET avatar=? WHERE id=?', url2, ch.id); }
    clients.forEach((_, u) => push(u, 'chat', {})); return out(res, 200, {});
  }
  if (r === 'msgs') {
    const c = +url.searchParams.get('chat'), ch = q1('SELECT * FROM chats WHERE id=?', c),
      mm = isMem(c, id) ? q1('SELECT clr FROM members WHERE chat=? AND uid=?', c, id) : (ch && ch.pub && ch.type !== 'p' ? { clr: 0, pv: 1 } : null);
    if (!mm) return out(res, 403, { error: 'no' });
    if (!mm.pv) markRead(c, id);
    const o = mm.pv ? [] : q('SELECT lr FROM members WHERE chat=? AND uid!=?', c, id);
    return out(res, 200, { seen: o.length ? Math.min(...o.map(x => x.lr)) : 1e12, msgs: q('SELECT * FROM msgs WHERE chat=? AND id>? ORDER BY id DESC LIMIT 300', c, mm.clr).reverse().map(fm) });
  }
  if (r === 'read') { if (isMem(+b.chat, id)) markRead(+b.chat, id); return out(res, 200, {}); }
  if (r === 'typing') { if (isMem(+b.chat, id)) pushChat(+b.chat, 'typing', { chat: +b.chat, name: me.name }, id); return out(res, 200, {}); }
  if (r === 'send') {
    const c = +b.chat, t = String(b.text || '').trim().slice(0, 4000), f = b.file && okUrl(b.file.url) ? { ...b.file, kind: KINDS.includes(b.file.kind) ? b.file.kind : 'file' } : null;
    if (!canPost(c, id)) return out(res, 403, { error: 'اجازه ارسال نداری' });
    if (!t && !f) return out(res, 400, { error: 'پیام نامعتبر' });
    ins(c, id, t, b.reply ? +b.reply : null, f); return out(res, 200, {});
  }
  if (r === 'forward') {
    const m = q1('SELECT * FROM msgs WHERE id=? AND del=0', +b.id); if (!m || !isMem(m.chat, id)) return out(res, 403, { error: 'no' });
    const f = m.file || m.img ? { kind: m.kind || 'image', url: m.file || m.img, name: m.fname, size: m.fsize, dur: m.dur } : null, from = m.fwd || q1('SELECT name FROM users WHERE id=?', m.sender).name;
    (b.chats || []).slice(0, 20).forEach(c => { if (canPost(+c, id)) ins(+c, id, m.text || '', null, f && f.url.startsWith('/f/') ? f : null, from); });
    return out(res, 200, {});
  }
  if (r === 'edit' || r === 'del') {
    const m = q1('SELECT * FROM msgs WHERE id=?', +b.id), ch = m && q1('SELECT owner,type FROM chats WHERE id=?', m.chat);
    if (!m || !isMem(m.chat, id) || (m.sender !== id && !(r === 'del' && ch.type !== 'p' && ch.owner === id))) return out(res, 403, { error: 'no' });
    r === 'edit' ? run('UPDATE msgs SET text=?,edited=1 WHERE id=?', String(b.text || '').slice(0, 4000), m.id) : run('UPDATE msgs SET del=1 WHERE id=?', m.id);
    pushChat(m.chat, 'upd', fm(q1('SELECT * FROM msgs WHERE id=?', m.id))); return out(res, 200, {});
  }
  if (r === 'react') {
    const m = q1('SELECT * FROM msgs WHERE id=?', +b.id); if (!m || !isMem(m.chat, id)) return out(res, 403, { error: 'no' });
    if (!RX.includes(String(b.e))) return out(res, 400, { error: 'no' });
    const e = String(b.e), o = q1('SELECT e FROM reacts WHERE msg=? AND uid=?', m.id, id);
    o && o.e === e ? run('DELETE FROM reacts WHERE msg=? AND uid=?', m.id, id) : run('INSERT OR REPLACE INTO reacts VALUES(?,?,?)', m.id, id, e);
    pushChat(m.chat, 'upd', fm(m)); return out(res, 200, {});
  }
  if (r === 'profile') { run('UPDATE users SET name=?,bio=?,hide=? WHERE id=?', String(b.name || me.name).trim().slice(0, 30) || me.name, String(b.bio || '').slice(0, 100), b.hide ? 1 : 0, id); clients.forEach((_, u) => push(u, 'presence', {})); return out(res, 200, {}); }
  if (r === 'password') {
    if (hash(String(b.old || ''), me.salt) !== me.pass) return out(res, 400, { error: 'رمز فعلی اشتباهه' });
    if (String(b.pw || '').length < 4) return out(res, 400, { error: 'رمز حداقل ۴ کاراکتر' });
    run('UPDATE users SET pass=? WHERE id=?', hash(String(b.pw), me.salt), id); return out(res, 200, {});
  }
  if (r === 'members') { const c = +url.searchParams.get('chat'), ch = q1('SELECT * FROM chats WHERE id=?', c); if (!isMem(c, id) || !ch || (ch.type === 'c' && ch.owner !== id)) return out(res, 403, { error: 'no' }); return out(res, 200, mem(c).map(u => pub(q1('SELECT * FROM users WHERE id=?', u)))); }
  if (r === 'add') {
    const c = +b.chat, u = q1('SELECT id FROM users WHERE username=?', String(b.username || '').toLowerCase()), ch = q1('SELECT * FROM chats WHERE id=?', c);
    if (!isMem(c, id) || !ch || ch.type === 'p' || !u || (ch.type === 'c' && ch.owner !== id)) return out(res, 400, { error: 'کاربر نیست' });
    run('INSERT OR IGNORE INTO members(chat,uid) VALUES(?,?)', c, u.id); mem(c).forEach(x => push(x, 'chat', {})); return out(res, 200, {});
  }
  out(res, 404, { error: 'not found' });
}).listen(PORT, '0.0.0.0', () => {
  console.log('Matgram is running\n  This phone : http://127.0.0.1:' + PORT);
  try { Object.values(require('os').networkInterfaces()).flat().filter(i => i && i.family === 'IPv4' && !i.internal).forEach(i => console.log('  Network    : http://' + i.address + ':' + PORT)); }
  catch { console.log('  Network    : run ifconfig, then open http://YOUR-IP:' + PORT); }
}).on('error', e => { console.log(e.code === 'EADDRINUSE' ? 'Port ' + PORT + ' is busy. Try: PORT=5001 node matgram.js' : e.message); process.exit(1); });

const PAGE = String.raw`<!doctype html><html lang="fa" dir="rtl"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="theme-color" content="#07080d"><title>Matgram</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Vazirmatn:wght@400;600;800&display=swap">
<style>
:root{--bg:#07080d;--p:#0f1118;--p2:#171a25;--ac:#c9a45c;--on:#1b1406;--tx:#f3efe6;--mu:#8d909e;--ln:#ffffff14;--g:linear-gradient(135deg,color-mix(in srgb,var(--ac) 65%,#fff),var(--ac));--sh:0 18px 60px #000a}
body.light{--bg:#eceef4;--p:#fff;--p2:#f1f2f7;--tx:#15171f;--mu:#6b7080;--ln:#0000000f;--sh:0 18px 60px #4b567022}
*{box-sizing:border-box;margin:0;font-family:Vazirmatn,Tahoma,system-ui,sans-serif;-webkit-tap-highlight-color:transparent}
body{color:var(--tx);background:var(--bg);height:100dvh;overflow:hidden;-webkit-user-select:none;user-select:none;-webkit-touch-callout:none}
input,textarea{-webkit-user-select:text;user-select:text}img{-webkit-user-drag:none}
body::before{content:"";position:fixed;inset:-20%;z-index:-1;filter:blur(40px);background:radial-gradient(38% 38% at 15% 20%,color-mix(in srgb,var(--ac) 22%,transparent),transparent),radial-gradient(35% 35% at 85% 15%,#5b4bd633,transparent),radial-gradient(40% 40% at 60% 90%,#c2417a22,transparent);animation:au 20s ease-in-out infinite alternate}
@keyframes au{to{transform:translate(4%,3%) rotate(6deg) scale(1.1)}}@keyframes pop{from{opacity:0;transform:translateY(8px) scale(.97)}}
::-webkit-scrollbar{width:5px}::-webkit-scrollbar-thumb{background:#8884;border-radius:6px}
button{cursor:pointer;border:0;background:none;color:inherit;font:inherit;transition:.18s}input{outline:0;font:inherit}
.ic{width:20px;height:20px;fill:none;stroke:currentColor;stroke-width:1.7;stroke-linecap:round;stroke-linejoin:round;flex:none;vertical-align:middle}
.lgb{width:84px;height:84px;filter:drop-shadow(0 8px 28px color-mix(in srgb,var(--ac) 50%,transparent))}.lgm{width:34px;height:34px}
#sp{position:fixed;inset:0;z-index:99;background:radial-gradient(circle,#15161f,#050509);display:flex;flex-direction:column;align-items:center;justify-content:center;gap:20px;transition:opacity .5s}
#mp{fill:none;stroke:#1b1406;stroke-width:11;stroke-linecap:round;stroke-linejoin:round;stroke-dasharray:1;stroke-dashoffset:1;animation:dr 1.2s .2s ease forwards}
#sp h1{font:800 34px system-ui;letter-spacing:6px;background:linear-gradient(90deg,#e8cf9a,#c9a45c);-webkit-background-clip:text;color:transparent;opacity:0;animation:fi .8s 1s forwards}
@keyframes dr{to{stroke-dashoffset:0}}@keyframes fi{to{opacity:1}}
#auth{height:100%;display:flex;align-items:center;justify-content:center;padding:16px}
.card,#side,#main{background:color-mix(in srgb,var(--p) 82%,transparent);backdrop-filter:blur(28px);-webkit-backdrop-filter:blur(28px);border:1px solid var(--ln);box-shadow:var(--sh)}
.card{padding:32px 26px;border-radius:30px;width:100%;max-width:370px;display:flex;flex-direction:column;gap:14px;align-items:center;text-align:center;animation:pop .5s}
.card h1{font:800 28px system-ui;letter-spacing:5px;background:var(--g);-webkit-background-clip:text;color:transparent}.card p{color:var(--mu);font-size:13px;margin-top:-8px}
.fld{display:flex;align-items:center;gap:10px;width:100%;background:var(--p2);border:1px solid var(--ln);border-radius:15px;padding:0 14px;color:var(--mu);transition:.2s}
.fld:focus-within{border-color:var(--ac);color:var(--ac);box-shadow:0 0 0 3px color-mix(in srgb,var(--ac) 22%,transparent)}
.fld input{flex:1;min-width:0;background:none;border:0;color:var(--tx);padding:13px 0;font-size:15px}
.go,.pbtn{width:100%;background:var(--g);color:var(--on);padding:13px;border-radius:15px;font-weight:700;font-size:15px;box-shadow:0 12px 28px -10px var(--ac)}.go:hover,.pbtn:hover{transform:translateY(-2px)}
.lnk{color:var(--ac);font-size:13px;padding:4px}#err{color:#ff7b7b;font-size:13px;min-height:16px}
#app{display:none;height:100%;max-width:1360px;margin:0 auto;padding:18px;gap:14px}
#side,#main{border-radius:28px;overflow:hidden}#side{width:370px;display:flex;flex-direction:column;flex:none}
#top{padding:16px 16px 8px;display:flex;align-items:center;gap:6px}.brand{font:800 18px system-ui;letter-spacing:3px;flex:1;margin-inline-start:6px;background:var(--g);-webkit-background-clip:text;color:transparent}
#top button,#hd button{width:38px;height:38px;border-radius:13px;color:var(--mu);display:grid;place-items:center}#top button:hover,#hd button:hover{background:var(--p2);color:var(--ac)}
.srch{margin:6px 16px 10px;width:auto}#list{flex:1;overflow:auto;padding:0 8px}
.it{display:flex;gap:12px;padding:10px;border-radius:18px;align-items:center;cursor:pointer;margin-bottom:2px}.it:hover{background:var(--p2)}.it.on{background:color-mix(in srgb,var(--ac) 14%,var(--p2))}
.av{width:50px;height:50px;border-radius:50%;background:linear-gradient(135deg,hsl(var(--h) 45% 45%),hsl(calc(var(--h) + 40) 50% 28%));display:grid;place-items:center;font-weight:800;font-size:20px;flex:none;position:relative;color:#fff;box-shadow:0 0 0 2px color-mix(in srgb,var(--ac) 45%,transparent),0 6px 16px -6px #000}
.av.ph{background-size:cover;background-position:center;color:transparent}.av.ed{cursor:pointer}
.av i{position:absolute;bottom:0;inset-inline-end:0;width:13px;height:13px;border-radius:50%;background:#34d399;border:2.5px solid var(--p)}
.in{flex:1;min-width:0}.in>div{display:flex;justify-content:space-between;gap:6px;align-items:center}.in b{display:flex;gap:6px;align-items:center;font-size:15px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.in small{color:var(--mu);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;display:block;font-size:12.5px;margin-top:3px;flex:1}.in>div:last-child{justify-content:flex-start;gap:8px}.in .ic{color:var(--ac)}.tm{color:var(--mu);font-size:11px}
.bd{background:var(--g);color:var(--on);border-radius:11px;padding:1px 8px;font-size:11px;font-weight:700;min-width:20px;text-align:center}
#pf{display:flex;gap:12px;align-items:center;padding:12px 16px;border-top:1px solid var(--ln);cursor:pointer}#pf:hover{background:var(--p2)}#pf .av{width:40px;height:40px;font-size:16px}
#main{flex:1;display:flex;flex-direction:column;min-width:0}
#empty{margin:auto;display:flex;flex-direction:column;align-items:center;gap:10px;color:var(--mu)}#empty b{font:800 22px system-ui;letter-spacing:5px;color:var(--tx)}
#chat{display:none;flex-direction:column;height:100%;min-height:0;position:relative}
#hd{padding:12px 16px;display:flex;align-items:center;gap:12px;border-bottom:1px solid var(--ln);cursor:pointer}#hd small{display:block;color:var(--mu);font-size:12px}#hd .av{width:42px;height:42px;font-size:17px}#back{display:none!important}
#sb{display:none;align-items:center;gap:8px;padding:8px 16px;border-bottom:1px solid var(--ln);color:var(--mu)}#sb input{flex:1;background:none;border:0;color:var(--tx);font-size:14px}
#msgs{flex:1;overflow:auto;padding:16px;display:flex;flex-direction:column;gap:4px;font-size:var(--fs,15px)}
.day{align-self:center;margin:10px 0}.day span{background:var(--p2);color:var(--mu);font-size:12px;padding:4px 14px;border-radius:12px;border:1px solid var(--ln)}
.m{max-width:min(80%,520px);padding:8px 13px 6px;border-radius:18px 18px 18px 6px;background:var(--p2);border:1px solid var(--ln);align-self:flex-end;white-space:pre-wrap;word-break:break-word;line-height:1.7;cursor:pointer;animation:pop .25s ease}
.m.me{background:linear-gradient(135deg,color-mix(in srgb,var(--ac) 30%,var(--p)),color-mix(in srgb,var(--ac) 13%,var(--p)));border-color:color-mix(in srgb,var(--ac) 38%,transparent);border-radius:18px 18px 6px 18px;align-self:flex-start;box-shadow:0 10px 24px -12px var(--ac)}
.m.fl{outline:2px solid var(--ac)}.m.dim{opacity:.22}.m.hit{outline:2px solid var(--ac)}.m a{color:var(--ac)}
.m img,.m video{max-width:100%;max-height:340px;border-radius:12px;display:block;margin-bottom:4px;cursor:zoom-in;background:#000}.m video{cursor:default;width:320px}img.lb{max-width:100%;max-height:70dvh;border-radius:14px;object-fit:contain;margin:auto}
.m s{display:block;text-decoration:none;font-size:10.5px;color:var(--mu);margin-top:2px;text-align:left}.m s .ic{width:16px;height:16px;vertical-align:-4px;margin-inline-start:3px}.m s.r .ic{color:var(--ac)}
.sn{display:block;font-size:12px;font-weight:700}.dl{color:var(--mu);font-size:13px;display:flex;gap:6px;align-items:center}.fw{display:block;font-size:11.5px;color:var(--ac);margin-bottom:3px}
.rp{border-inline-start:3px solid var(--ac);padding:2px 9px;margin-bottom:5px;background:#0003;border-radius:6px;font-size:12px}.rp span{display:block;opacity:.75;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;max-width:220px}
.re{display:flex;gap:5px;flex-wrap:wrap;margin-top:5px}.re span{display:inline-flex;gap:4px;align-items:center;background:#0003;border-radius:12px;padding:2px 8px;font-size:12px}.re span.on{background:var(--ac);color:var(--on)}.re .ic{width:14px;height:14px}.re .on .ic{fill:currentColor}
.fc{display:flex;align-items:center;gap:10px;color:inherit!important;text-decoration:none;min-width:200px;padding:2px 0 4px}.fc .fi{width:42px;height:42px;border-radius:13px;background:var(--g);color:var(--on);display:grid;place-items:center}.fc .fn{flex:1;min-width:0}.fc b{display:block;font-size:13.5px;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;max-width:180px}.fc small{color:var(--mu);font-size:11.5px}
.vc{display:flex;align-items:center;gap:10px;min-width:210px;padding:2px 0 4px}.vc .pl{width:38px;height:38px;border-radius:50%;background:var(--g);color:var(--on);display:grid;place-items:center;flex:none}.pb{flex:1;height:5px;border-radius:5px;background:#8883;overflow:hidden;cursor:pointer;padding:0}.pb i{display:block;height:100%;width:0;background:var(--ac)}.vc span{font-size:11.5px;color:var(--mu);min-width:34px}
#mn{position:fixed;z-index:70;background:color-mix(in srgb,var(--p) 94%,transparent);backdrop-filter:blur(24px);border:1px solid var(--ln);border-radius:18px;box-shadow:var(--sh);padding:6px;min-width:200px;animation:pop .15s}
#mn a{display:flex;gap:12px;align-items:center;padding:10px 12px;cursor:pointer;border-radius:11px;font-size:14px}#mn a:hover{background:var(--p2);color:var(--ac)}#mn a.dg{color:#ff6b6b}
.rx{display:flex;justify-content:space-around;padding:4px 0 8px;border-bottom:1px solid var(--ln);margin-bottom:4px}.rx button{padding:6px;border-radius:50%;color:var(--mu)}.rx button:hover{color:var(--ac);transform:scale(1.25)}
#ctx{display:none;align-items:center;gap:10px;margin:0 14px;padding:8px 14px;border-radius:16px 16px 0 0;background:var(--p2);border:1px solid var(--ln);border-bottom:0;color:var(--ac)}
.cx{flex:1;min-width:0;font-size:12px}.cx span{display:block;color:var(--mu);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
#em{display:none;margin:0 14px;padding:8px;background:var(--p2);border:1px solid var(--ln);border-radius:16px 16px 0 0;flex-wrap:wrap;gap:2px;max-height:130px;overflow:auto}#em button{font-size:22px;width:38px;height:38px;border-radius:10px}#em button:hover{background:var(--p)}
#bar,#rb{display:flex;gap:4px;margin:10px 14px 14px;padding:6px;border-radius:30px;background:var(--p2);border:1px solid var(--ln);align-items:center}#rb{display:none;padding-inline:14px}
#bar button,#rb button{color:var(--mu);width:42px;height:42px;border-radius:50%;display:grid;place-items:center;flex:none}#bar button:hover{color:var(--ac)}
#t{flex:1;background:none;border:0;color:var(--tx);padding:10px 6px;font-size:15px;min-width:0}
#bar #sd,#rb #rs,#bar #mic{background:var(--g);color:var(--on);box-shadow:0 8px 20px -8px var(--ac)}#sd{display:none}#rb #rc{color:#ff6b6b}.rd{width:10px;height:10px;border-radius:50%;background:#ff4d4d;animation:pl 1s infinite}@keyframes pl{50%{opacity:.2}}
#ro{display:none;text-align:center;color:var(--mu);padding:16px;font-size:13px;border-top:1px solid var(--ln)}
#dn{display:none;position:absolute;bottom:84px;inset-inline-end:22px;width:42px;height:42px;border-radius:50%;background:var(--p);border:1px solid var(--ln);box-shadow:var(--sh);place-items:center;color:var(--ac);z-index:5}
#ts{display:none;position:fixed;top:14px;left:50%;transform:translateX(-50%);background:var(--g);color:var(--on);padding:8px 18px;border-radius:20px;font-size:13px;z-index:90;box-shadow:var(--sh)}
[dir=rtl] #back .ic,[dir=rtl] #sd .ic,[dir=rtl] #rs .ic{transform:scaleX(-1)}
#md{position:fixed;inset:0;background:#000a;backdrop-filter:blur(8px);z-index:60;display:none;align-items:center;justify-content:center;padding:12px}
#mc{background:var(--p);border:1px solid var(--ln);box-shadow:var(--sh);border-radius:26px;width:100%;max-width:420px;max-height:90dvh;overflow:auto;padding:20px;display:flex;flex-direction:column;gap:12px;animation:pop .25s}
#mc h3{color:var(--ac);text-align:center}#mc label{display:block;font-size:12px;color:var(--mu);margin-bottom:6px}.mu{color:var(--mu);text-align:center;font-size:13px}.hr{font-size:12px;font-weight:800;color:var(--ac);letter-spacing:1px;border-bottom:1px solid var(--ln);padding:8px 0 4px}
#mc input[type=text],#mc input[type=password]{background:var(--p2);border:1px solid var(--ln);color:var(--tx);padding:11px 13px;border-radius:13px;font-size:14px;width:100%;margin-bottom:6px}
.row{display:flex;justify-content:space-between;align-items:center;gap:8px}
.sw{display:flex;gap:10px;flex-wrap:wrap}.sw span{width:32px;height:32px;border-radius:50%;cursor:pointer;border:3px solid transparent;transition:.2s;background-size:cover}.sw span.on{border-color:var(--tx);transform:scale(1.12)}
.seg{display:inline-flex;background:var(--p2);border-radius:13px;overflow:hidden;border:1px solid var(--ln)}.seg button{padding:8px 16px;font-size:13px}.seg button.on{background:var(--g);color:var(--on);font-weight:700}
.dng{color:#ff6b6b;padding:8px}.sel{outline:2px solid var(--ac)}
[dir=ltr] .m{align-self:flex-start}
@media(max-width:760px){#app{padding:0;gap:0}#side,#main{border-radius:0;border:0}#side{width:100%}#main{display:none}#app.open #side{display:none}#app.open #main{display:flex}#back{display:grid!important}.m video{width:100%}}
</style></head><body>
<svg width="0" height="0" style="position:absolute"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#f0dba8"/><stop offset="1" stop-color="#b8903f"/></linearGradient></defs>
<symbol id="lg" viewBox="0 0 120 120"><rect width="120" height="120" rx="30" fill="url(#g)"/><path d="M30 88V34l30 36 30-36v54" fill="none" stroke="#1b1406" stroke-width="11" stroke-linecap="round" stroke-linejoin="round"/></symbol>
<symbol id="i-send" viewBox="0 0 24 24"><path d="M21 3 10 14M21 3l-7 18-4-7-7-4z"/></symbol>
<symbol id="i-sliders" viewBox="0 0 24 24"><path d="M4 7h9M17 7h3M4 17h3M11 17h9"/><circle cx="15" cy="7" r="2"/><circle cx="9" cy="17" r="2"/></symbol>
<symbol id="i-users" viewBox="0 0 24 24"><circle cx="9" cy="8" r="3.2"/><path d="M3 20c0-3.6 2.7-6 6-6s6 2.4 6 6"/><circle cx="17" cy="9" r="2.4"/><path d="M17.5 14c2.2.3 4 2.2 4 5"/></symbol>
<symbol id="i-logout" viewBox="0 0 24 24"><path d="M9 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h3M16 8l4 4-4 4M20 12H9"/></symbol>
<symbol id="i-back" viewBox="0 0 24 24"><path d="M15 5l-7 7 7 7"/></symbol>
<symbol id="i-reply" viewBox="0 0 24 24"><path d="M9 7 4 12l5 5M4 12h10a6 6 0 0 1 6 6v1"/></symbol>
<symbol id="i-copy" viewBox="0 0 24 24"><rect x="8" y="8" width="12" height="12" rx="2.5"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/></symbol>
<symbol id="i-edit" viewBox="0 0 24 24"><path d="M4 20h4L19 9l-4-4L4 16zM13.5 6.5l4 4"/></symbol>
<symbol id="i-trash" viewBox="0 0 24 24"><path d="M5 7h14M10 7V4h4v3M7 7l1 13h8l1-13"/></symbol>
<symbol id="i-ban" viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.5"/><path d="M6 6l12 12"/></symbol>
<symbol id="i-x" viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18"/></symbol>
<symbol id="i-search" viewBox="0 0 24 24"><circle cx="11" cy="11" r="6.5"/><path d="M16 16l4.5 4.5"/></symbol>
<symbol id="i-ck1" viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7"/></symbol>
<symbol id="i-ck2" viewBox="0 0 24 24"><path d="M2.5 12.5 7 17 16.5 7M10.5 15.5l1.5 1.5L21.5 7"/></symbol>
<symbol id="i-user" viewBox="0 0 24 24"><circle cx="12" cy="8" r="3.6"/><path d="M5 20c0-4 3-6.5 7-6.5s7 2.5 7 6.5"/></symbol>
<symbol id="i-at" viewBox="0 0 24 24"><circle cx="12" cy="12" r="3.5"/><path d="M15.5 12v1.5a2.5 2.5 0 0 0 5 0V12a8.5 8.5 0 1 0-3.4 6.8"/></symbol>
<symbol id="i-lock" viewBox="0 0 24 24"><rect x="5" y="11" width="14" height="9" rx="2.5"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></symbol>
<symbol id="i-like" viewBox="0 0 24 24"><path d="M7 11v9H4v-9zM7 11l4-7c1.6 0 2.6 1.3 2 3L12.5 10H18a2 2 0 0 1 2 2.4l-1.2 5.6a2 2 0 0 1-2 1.6H7"/></symbol>
<symbol id="i-heart" viewBox="0 0 24 24"><path d="M12 20s-7.5-4.6-7.5-10A4.3 4.3 0 0 1 12 7.2 4.3 4.3 0 0 1 19.5 10c0 5.4-7.5 10-7.5 10z"/></symbol>
<symbol id="i-fire" viewBox="0 0 24 24"><path d="M12 3c1 4 5 5.5 5 10a5 5 0 0 1-10 0c0-2 1-3 2-4 0 2 1 3 2 3 0-3-1-6 1-9z"/></symbol>
<symbol id="i-star" viewBox="0 0 24 24"><path d="M12 3.5l2.6 5.4 5.9.8-4.3 4.1 1 5.9L12 16.9l-5.2 2.8 1-5.9L3.5 9.7l5.9-.8z"/></symbol>
<symbol id="i-bolt" viewBox="0 0 24 24"><path d="M13 3 5 13.5h6L10 21l8-10.5h-6z"/></symbol>
<symbol id="i-gem" viewBox="0 0 24 24"><path d="M6 4h12l3.5 5L12 20.5 2.5 9z"/><path d="M2.5 9h19M9 4 7.5 9 12 20.5 16.5 9 15 4"/></symbol>
<symbol id="i-mic" viewBox="0 0 24 24"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/></symbol>
<symbol id="i-clip" viewBox="0 0 24 24"><path d="M20 11.5 12.5 19a5 5 0 0 1-7-7L13 4.5a3.4 3.4 0 0 1 5 5L10.5 17a1.8 1.8 0 0 1-2.5-2.5L14.5 8"/></symbol>
<symbol id="i-file" viewBox="0 0 24 24"><path d="M7 3h7l5 5v11a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2zM14 3v5h5"/></symbol>
<symbol id="i-image" viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="16" rx="3.5"/><circle cx="9" cy="10" r="1.6"/><path d="M4 18l5-5 4 4 3-3 4 4"/></symbol>
<symbol id="i-play" viewBox="0 0 24 24"><path d="M8 5.5v13l11-6.5z" fill="currentColor"/></symbol>
<symbol id="i-pause" viewBox="0 0 24 24"><path d="M8 5v14M16 5v14" stroke-width="3.2"/></symbol>
<symbol id="i-fwd" viewBox="0 0 24 24"><path d="m15 7 5 5-5 5M20 12H9a5 5 0 0 0-5 5v1"/></symbol>
<symbol id="i-pin" viewBox="0 0 24 24"><path d="M9 4h6l-1 6 3 3H7l3-3zM12 13v7"/></symbol>
<symbol id="i-plus" viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></symbol>
<symbol id="i-smile" viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.5"/><path d="M8.5 14c1 1.5 2.2 2.2 3.5 2.2s2.5-.7 3.5-2.2M9 10h.01M15 10h.01"/></symbol>
<symbol id="i-down" viewBox="0 0 24 24"><path d="m6 9 6 6 6-6"/></symbol>
<symbol id="i-dl" viewBox="0 0 24 24"><path d="M12 4v11M7 11l5 5 5-5M5 20h14"/></symbol>
<symbol id="i-mega" viewBox="0 0 24 24"><path d="M4 10v4l12 5V5zM16 9a3 3 0 0 1 0 6M7 14l1 5h2l-1-4"/></symbol></svg>
<div id="sp"><svg viewBox="0 0 120 120" width="130" height="130"><rect width="120" height="120" rx="30" fill="url(#g)"/><path id="mp" pathLength="1" d="M30 88V34l30 36 30-36v54"/></svg><h1>Matgram</h1></div>
<div id="ts"></div>
<div id="auth"><div class="card"><svg class="lgb"><use href="#lg"/></svg><h1>Matgram</h1><p>پیام‌رسان سریع، خصوصی و زیبا</p>
<label class="fld" id="nmw" style="display:none"><svg class="ic"><use href="#i-user"/></svg><input id="nm" placeholder="نام نمایشی"></label>
<label class="fld"><svg class="ic"><use href="#i-at"/></svg><input id="un" placeholder="نام کاربری (انگلیسی)" dir="ltr" autocapitalize="none"></label>
<label class="fld"><svg class="ic"><use href="#i-lock"/></svg><input id="pw" type="password" placeholder="رمز عبور" dir="ltr"></label>
<div id="err"></div><button class="go" id="go">ورود</button><button class="lnk" id="sw">حساب ندارید؟ ثبت‌نام</button></div></div>
<div id="app"><div id="side"><div id="top"><svg class="lgm"><use href="#lg"/></svg><b class="brand">Matgram</b>
<button id="ng" title="جدید"><svg class="ic"><use href="#i-plus"/></svg></button><button id="st" title="تنظیمات"><svg class="ic"><use href="#i-sliders"/></svg></button></div>
<label class="fld srch"><svg class="ic"><use href="#i-search"/></svg><input id="q" placeholder="جستجوی کاربر، گروه یا کانال..."></label><div id="list"></div>
<div id="pf"><div class="av" id="mav"></div><div class="in"><b id="me"></b><small id="mu"></small></div></div></div>
<div id="main"><div id="empty"><svg class="lgb"><use href="#lg"/></svg><b>Matgram</b><span>یه گفتگو انتخاب کن</span></div>
<div id="chat"><div id="hd"><button id="back"><svg class="ic"><use href="#i-back"/></svg></button><div class="av" id="hav"></div><div class="in"><b id="hn"></b><small id="hs"></small></div><button id="hsb" title="جستجو"><svg class="ic"><use href="#i-search"/></svg></button></div>
<div id="sb"><svg class="ic"><use href="#i-search"/></svg><input id="sq" placeholder="جستجو در پیام‌ها"></div><div id="msgs"></div><button id="dn"><svg class="ic"><use href="#i-down"/></svg></button><div id="ctx"></div><div id="em"></div>
<div id="jn" style="display:none;padding:14px"><button class="pbtn" id="jb">پیوستن</button></div><div id="ro">فقط مدیر کانال می‌تونه پیام بذاره</div>
<div id="bar"><button id="ab"><svg class="ic"><use href="#i-clip"/></svg></button><button id="eb"><svg class="ic"><use href="#i-smile"/></svg></button><input id="t" placeholder="پیام..." autocomplete="off"><button id="mic"><svg class="ic"><use href="#i-mic"/></svg></button><button id="sd"><svg class="ic"><use href="#i-send"/></svg></button></div>
<div id="rb"><button id="rc"><svg class="ic"><use href="#i-trash"/></svg></button><span class="rd"></span><b id="rt">0:00</b><i style="flex:1"></i><button id="rs"><svg class="ic"><use href="#i-send"/></svg></button></div>
<input type="file" id="f1" accept="image/*,video/*" multiple hidden><input type="file" id="f2" multiple hidden></div></div></div>
<div id="md"><div id="mc"></div></div>
<script>
const $=s=>document.querySelector(s),fa=n=>new Date(n).toLocaleTimeString('fa-IR',{hour:'2-digit',minute:'2-digit'});
const h=(t,p,...c)=>{const e=document.createElement(t);Object.assign(e,p||{});e.append(...c.filter(x=>x!=null&&x!==false));return e};
const ic=(n,z)=>{const e=document.createElementNS('http://www.w3.org/2000/svg','svg');e.setAttribute('class','ic');if(z)e.style.width=e.style.height=z+'px';e.innerHTML='<use href="#i-'+n+'"/>';return e};
const mmss=s=>{s=Math.round(s||0);return Math.floor(s/60)+':'+String(s%60).padStart(2,'0')},sz=n=>n>1048576?(n/1048576).toFixed(1)+' MB':Math.max(1,Math.round(n/1024))+' KB';
const toast=t=>{const e=$('#ts');e.textContent=t||'';e.style.display=t?'block':'none'};
let T=localStorage.t,me,cur,chats=[],es,reg=false,tt,lt=0,rep=null,edit=null,seen=0,rec=null,pins=[];
// تنظیمات محلی باید جداگانه برای هر حساب ذخیره شوند؛ توکن ورود عمداً سراسری می‌ماند.
const PREF_NAMES=['th','fs','wp','snd','ent','pins'];
const prefKey=k=>'matgram:account:'+me.id+':'+k;
function pref(k,d){if(!me)return d;const v=localStorage.getItem(prefKey(k));return v===null?d:v}
function setPref(k,v){if(me)localStorage.setItem(prefKey(k),String(v))}
function initAccountPrefs(){
  // تنظیمات قدیمی فقط یک بار به اولین حساب واردشده منتقل می‌شوند تا تنظیمات حساب‌ها قاطی نشوند.
  if(!localStorage.getItem('matgram:legacy-prefs-migrated')){
    for(const k of PREF_NAMES){const v=localStorage.getItem(k);if(v!==null&&localStorage.getItem(prefKey(k))===null)localStorage.setItem(prefKey(k),v);localStorage.removeItem(k)}
    localStorage.setItem('matgram:legacy-prefs-migrated','1');
  }
  try{pins=JSON.parse(pref('pins','[]')||'[]');if(!Array.isArray(pins))pins=[]}catch{pins=[]}
  applyUI();
}
const ttl=c=>c.type=='p'&&(c.uid||c.id)==me.id?'پیام‌های ذخیره‌شده':(c.title||c.name),ro=()=>cur&&cur.type=='c'&&cur.owner!=me.id;
const ACS=[['#c9a45c','#1b1406'],['#7c8cff','#fff'],['#e0629a','#fff'],['#2fc79a','#06231a'],['#a76bff','#fff']],WP=['','linear-gradient(160deg,#1a1c2c,#0b0c12)','radial-gradient(circle at 20% 15%,#3a2d12,#0b0c12 70%)','radial-gradient(circle at 80% 10%,#26164a,#0b0c12 70%)'];
function applyUI(){const r=document.documentElement.style,a=ACS[0],t=pref('th','d'),L=t=='l'||t=='1'||(t=='a'&&matchMedia('(prefers-color-scheme: light)').matches);
r.setProperty('--ac',a[0]);r.setProperty('--on',a[1]);r.setProperty('--fs',(pref('fs','15')||15)+'px');document.body.classList.toggle('light',L);const m=$('#msgs');if(m)m.style.background=(!L&&WP[+(pref('wp','0')||0)])||''}
setTimeout(()=>{$('#sp').style.opacity=0;setTimeout(()=>$('#sp').remove(),500)},1800);
document.addEventListener('selectstart',e=>{if(!(e.target.closest&&e.target.closest('input,textarea')))e.preventDefault()});
document.addEventListener('contextmenu',e=>{if(!(e.target.closest&&e.target.closest('input,textarea')))e.preventDefault()});
async function api(p,m,b){const r=await fetch('/api/'+p,{method:m||'GET',headers:{'x-token':T||'','content-type':'application/json'},body:b?JSON.stringify(b):undefined});
const d=await r.json();if(!r.ok){if(r.status==401&&T)logout();throw new Error(d.error||'خطا')}return d}
async function upload(bl,m){const r=await fetch('/api/upload?m='+encodeURIComponent(m||bl.type||'application/octet-stream'),{method:'POST',headers:{'x-token':T},body:bl});const d=await r.json();if(!r.ok)throw new Error(d.error||'خطا');return d}
function logout(){localStorage.removeItem('t');T=null;es&&es.close();cur=null;$('#app').style.display='none';$('#auth').style.display='flex'}
$('#st').onclick=$('#pf').onclick=()=>settings();
$('#hd').onclick=e=>!e.target.closest('#back,#hsb')&&info();
$('#sw').onclick=()=>{reg=!reg;$('#nmw').style.display=reg?'flex':'none';$('#go').textContent=reg?'ثبت‌نام':'ورود';$('#sw').textContent=reg?'حساب دارید؟ ورود':'حساب ندارید؟ ثبت‌نام'};
$('#go').onclick=async()=>{try{const d=await api(reg?'register':'login','POST',{username:$('#un').value,name:$('#nm').value,password:$('#pw').value});T=localStorage.t=d.token;$('#pw').value='';$('#err').textContent='';start()}catch(e){$('#err').textContent=e.message}};
$('#pw').onkeydown=e=>e.key=='Enter'&&$('#go').click();
const modal=(...c)=>{$('#mc').replaceChildren(...c);$('#md').style.display='flex'},closeM=()=>$('#md').style.display='none';
$('#md').onclick=e=>e.target.id=='md'&&closeM();
const pick=(e,fn)=>{[...e.target.parentNode.children].forEach(b=>b.classList.remove('on'));e.target.classList.add('on');fn()};
const seg=(o,val,fn)=>h('div',{className:'seg'},...o.map(([v,l])=>h('button',{className:v==val?'on':'',onclick:e=>pick(e,()=>fn(v))},l)));
const swatch=(list,sel,fn,paint)=>h('div',{className:'sw'},...list.map((v,i)=>h('span',{className:i==sel?'on':'',style:'background:'+paint(v),onclick:e=>pick(e,()=>fn(i))})));
const sec=(l,...c)=>h('div',{},h('label',{},l),...c),hr=t=>h('div',{className:'hr'},t);
function popup(x,y,items,top){closeMenu();const m=h('div',{id:'mn'});top&&m.append(top);items.filter(Boolean).forEach(([i,l,f,d])=>m.append(h('a',{className:d?'dg':'',onclick:f},ic(i,18),l)));document.body.append(m);const r=m.getBoundingClientRect();m.style.left=Math.max(6,Math.min(x,innerWidth-r.width-8))+'px';m.style.top=Math.max(6,Math.min(y,innerHeight-r.height-8))+'px'}
function closeMenu(){const x=$('#mn');x&&x.remove()}document.addEventListener('click',closeMenu);
function lp(el,fn){let tm,sx,sy;el.addEventListener('touchstart',e=>{const t=e.touches[0];sx=t.clientX;sy=t.clientY;tm=setTimeout(()=>{el._lp=1;fn(sx,sy)},450)},{passive:true});
['touchend','touchcancel'].forEach(n=>el.addEventListener(n,()=>clearTimeout(tm)));el.addEventListener('touchmove',e=>{const t=e.touches[0];if(Math.abs(t.clientX-sx)>10||Math.abs(t.clientY-sy)>10)clearTimeout(tm)},{passive:true});
el.addEventListener('contextmenu',e=>{e.preventDefault();el._lp=0;fn(e.clientX,e.clientY)})}
const img=(f,mx,sq)=>new Promise((ok,no)=>{const im=new Image();im.onload=()=>{let w=im.width,hh=im.height,sx=0,sy=0,sw=w,sh=hh,dw,dh;if(sq){const s=Math.min(w,hh);sx=(w-s)/2;sy=(hh-s)/2;sw=sh=s;dw=dh=mx}else{const k=Math.min(1,mx/Math.max(w,hh));dw=w*k|0;dh=hh*k|0}
const c=h('canvas',{width:dw,height:dh});c.getContext('2d').drawImage(im,sx,sy,sw,sh,0,0,dw,dh);c.toBlob(ok,'image/jpeg',.82)};im.onerror=no;im.src=URL.createObjectURL(f)});
function pickAv(chat){const i=h('input',{type:'file',accept:'image/*'});i.onchange=async()=>{const f=i.files[0];if(!f)return;try{toast('در حال آپلود…');const d=await upload(await img(f,320,true),'image/jpeg');await api('avatar','POST',{chat,url:d.url});toast();await refresh();closeM();chat?info():settings()}catch(e){toast();alert(e.message||'خطا')}};i.click()}
function av(c,z){const k=c.type=='g'?c.id+50:c.type=='c'?c.id+90:(c.uid||c.id),d=h('div',{className:'av',style:'--h:'+(k*67%360)+(z?';width:'+z+'px;height:'+z+'px;font-size:'+z*.4+'px':'')}),nm=c.type=='g'||c.type=='c'?c.title:(c.name||c.title);
if(c.avatar){d.style.backgroundImage='url('+c.avatar+')';d.classList.add('ph')}else d.append((nm||'?')[0]);c.online&&d.append(h('i'));return d}
function setMe(){$('#me').textContent=me.name;$('#mu').textContent='@'+me.username;const a=av({...me,type:'p',uid:me.id,online:0});a.id='mav';$('#mav').replaceWith(a)}
function settings(){
 const nm=h('input',{type:'text',value:me.name}),bi=h('input',{type:'text',value:me.bio||'',placeholder:'بیو'}),op=h('input',{type:'password',placeholder:'رمز فعلی'}),np=h('input',{type:'password',placeholder:'رمز جدید'});let hide=me.hide?1:0;
 const S=(k,d)=>pref(k,d),onoff=k=>seg([['1','روشن'],['0','خاموش']],S(k,'1'),v=>{setPref(k,v);applyUI()});
 const a=av({...me,type:'p',uid:me.id,online:0},88);a.classList.add('ed');a.style.margin='0 auto';a.onclick=()=>pickAv(0);
 modal(h('h3',{},'تنظیمات'),a,h('button',{className:'lnk',onclick:()=>pickAv(0)},'تغییر عکس پروفایل'),me.avatar&&h('button',{className:'lnk',onclick:async()=>{await api('avatar','POST',{chat:0,url:null});await refresh();settings()}},'حذف عکس'),
 sec('نام',nm),sec('بیو',bi),h('div',{className:'mu',dir:'ltr'},'@'+me.username),
 hr('ظاهر'),sec('تم',seg([['d','تیره'],['l','روشن'],['a','خودکار']],pref('th','d'),v=>{setPref('th',v);applyUI()})),
 sec('اندازه متن',seg([['13','کوچک'],['15','متوسط'],['18','بزرگ']],S('fs','15'),v=>{setPref('fs',v);applyUI()})),
 sec('پس‌زمینه گفتگو (تم تیره)',swatch(WP,+S('wp','0'),i=>{setPref('wp',i);applyUI()},v=>v||'var(--p2)')),
 hr('گفتگو'),sec('صدای پیام جدید',onoff('snd')),sec('ارسال با Enter',onoff('ent')),
 hr('حریم خصوصی'),sec('مخفی کردن آخرین بازدید',seg([['0','خاموش'],['1','روشن']],''+hide,v=>hide=+v)),
 hr('امنیت'),sec('تغییر رمز',op,np,h('button',{className:'pbtn',onclick:async()=>{try{await api('password','POST',{old:op.value,pw:np.value});op.value=np.value='';alert('رمز عوض شد')}catch(e){alert(e.message)}}},'تغییر رمز')),
 h('button',{className:'pbtn',onclick:async()=>{try{await api('profile','POST',{name:nm.value,bio:bi.value,hide});closeM();refresh()}catch(e){alert(e.message)}}},'ذخیره'),h('button',{className:'dng',onclick:()=>{closeM();logout()}},'خروج از حساب'))}
async function info(){if(!cur)return;const c=cur,g=c.type!='p',own=c.owner==me.id,a=av(c,88),rows=[];a.style.margin='0 auto';
 if(g&&own){a.classList.add('ed');a.onclick=()=>pickAv(c.id)}rows.push(a,h('h3',{},ttl(c)));c.handle&&rows.push(h('div',{className:'mu',dir:'ltr'},'@'+c.handle));g&&own&&rows.push(h('button',{className:'lnk',onclick:()=>pickAv(c.id)},'تغییر عکس'));
 if(!g){c.username&&rows.push(h('div',{className:'row'},h('label',{},'نام کاربری'),h('span',{dir:'ltr'},'@'+c.username)));rows.push(h('div',{className:'row'},h('label',{},'بیو'),h('span',{},c.bio||'—')))}
 else if(c.preview){c.about&&rows.push(h('div',{className:'mu'},c.about));rows.push(h('div',{className:'mu'},c.n+(c.type=='c'?' مشترک':' عضو')),h('button',{className:'pbtn',onclick:()=>{closeM();$('#jb').click()}},'پیوستن'))}
 else{c.about&&rows.push(h('div',{className:'mu'},c.about));rows.push(h('label',{},c.n+(c.type=='c'?' مشترک':' عضو')));
  if(c.type=='g'||own)(await api('members?chat='+c.id)).forEach(u=>rows.push(h('div',{className:'it',onclick:async()=>{closeM();openChat(await api('open','POST',{uid:u.id}))}},av(u),h('div',{className:'in'},h('b',{},u.name),h('small',{},'@'+u.username)))));
  if(c.type=='g'||own){const ai=h('input',{type:'text',placeholder:'افزودن با نام کاربری',dir:'ltr'});rows.push(h('div',{},ai,h('button',{className:'pbtn',onclick:async()=>{try{await api('add','POST',{chat:c.id,username:ai.value.trim().toLowerCase()});info()}catch(e){alert(e.message)}}},'افزودن')))}
  const go=async(u)=>{await api(u,'POST',{chat:c.id});closeM();back();refresh()};
  if(!c.preview)rows.push(h('button',{className:'dng',onclick:()=>confirm('خارج می‌شی؟')&&go('leave')},'ترک '+(c.type=='c'?'کانال':'گروه')));!c.preview&&own&&rows.push(h('button',{className:'dng',onclick:()=>confirm('برای همه حذف بشه؟')&&go('delgroup')},'حذف برای همه'))}
 rows.push(h('button',{className:'lnk',onclick:closeM},'بستن'));modal(...rows)}
function newChat(ty){const t=h('input',{type:'text',placeholder:'نام'}),ab=h('input',{type:'text',placeholder:'توضیحات (اختیاری)'}),mb=h('input',{type:'text',placeholder:'نام کاربری اعضا، با کاما',dir:'ltr'}),hd=h('input',{type:'text',placeholder:'مثلاً my_channel',dir:'ltr',autocapitalize:'none'}),hw=sec('نام کاربری عمومی (اجباری)',hd);let pb=ty=='c'?1:0;hw.style.display=pb?'block':'none';
 modal(h('h3',{},ty=='c'?'کانال جدید':'گروه جدید'),t,ab,mb,sec('قابل جستجو و عضویت برای همه',seg([['1','بله'],['0','خیر']],''+pb,v=>{pb=+v;hw.style.display=pb?'block':'none'})),hw,
 h('button',{className:'pbtn',onclick:async()=>{try{const c=await api('group','POST',{type:ty,title:t.value,about:ab.value,pub:pb,handle:hd.value,members:mb.value.split(',').map(s=>s.trim().toLowerCase()).filter(Boolean)});closeM();await refresh();openChat(c)}catch(e){alert(e.message)}}},'ساخت'),h('button',{className:'dng',onclick:closeM},'بستن'))}
$('#ng').onclick=e=>{e.stopPropagation();const r=e.currentTarget.getBoundingClientRect();popup(r.left,r.bottom+6,[['users','گروه جدید',()=>newChat('g')],['mega','کانال جدید',()=>newChat('c')]])};
function item(c,sub,time,unread,fn){const b=h('div',{},h('small',{},sub));if(unread)b.append(h('span',{className:'bd'},unread));if(pins.includes(c.id)&&!fn)b.append(ic('pin',14));
 const e=h('div',{className:'it'+(cur&&cur.id==c.id&&!fn?' on':''),onclick:ev=>{if(e._lp){e._lp=0;ev.stopPropagation();return}fn?fn():openChat(c)}},av(c),h('div',{className:'in'},h('div',{},h('b',{},c.type=='c'?ic('mega',15):c.type=='g'?ic('users',15):null,ttl(c)),h('span',{className:'tm'},time?fa(time):'')),b));
 if(!fn)lp(e,(x,y)=>chatMenu(c,x,y));return e}
function chatMenu(c,x,y){const g=c.type!='p',own=c.owner==me.id,nm=c.type=='c'?'کانال':'گروه',after=()=>{if(cur&&cur.id==c.id)back();refresh()};
 popup(x,y,[['pin',pins.includes(c.id)?'برداشتن پین':'پین کردن',()=>{pins=pins.includes(c.id)?pins.filter(i=>i!=c.id):[c.id,...pins];setPref('pins',JSON.stringify(pins));renderChats()}],
 !g&&['trash','پاک کردن گفتگو',()=>confirm('گفتگو فقط برای تو پاک بشه؟')&&api('clear','POST',{chat:c.id}).then(after),1],
 g&&['logout','ترک '+nm,()=>confirm('ترک '+nm+'؟')&&api('leave','POST',{chat:c.id}).then(after),1],
 g&&own&&['trash','حذف '+nm+' برای همه',()=>confirm('برای همه حذف بشه؟')&&api('delgroup','POST',{chat:c.id}).then(after),1]])}
function renderChats(){const l=$('#list');l.innerHTML='';chats.slice().sort((a,b)=>pins.includes(b.id)-pins.includes(a.id)).forEach(c=>l.append(item(c,c.last,c.lts,c.unread)));if(!chats.length)l.append(h('p',{style:'color:var(--mu);text-align:center;padding:30px;font-size:13px'},'با جستجوی نام کاربری، گفتگو شروع کن'))}
async function refresh(){const d=await api('chats');me=d.me;setMe();if($('#q').value)return;chats=d.chats;renderChats();if(cur){const c=chats.find(x=>x.id==cur.id);if(c){cur=c;status()}}}
$('#q').oninput=async()=>{const v=$('#q').value.trim();if(!v)return refresh();const r=await api('users?q='+encodeURIComponent(v)),l=$('#list');l.innerHTML='';
 r.users.forEach(u=>l.append(item(u,'@'+u.username+(u.bio?' · '+u.bio:''),0,0,async()=>{$('#q').value='';openChat(await api('open','POST',{uid:u.id}))})));
 r.chats.forEach(c=>l.append(item(c,(c.type=='c'?'کانال · ':'گروه · ')+(c.handle?'@'+c.handle+' · ':'')+c.n+' عضو',0,0,()=>{$('#q').value='';openChat({...c,preview:1})})))};
function status(txt){const a=av(cur);a.id='hav';$('#hav').replaceWith(a);$('#hn').textContent=ttl(cur);
 $('#hs').textContent=txt||(cur.type=='g'?cur.n+' عضو':cur.type=='c'?cur.n+' مشترک':cur.online?'آنلاین':cur.last_seen?'آخرین بازدید '+fa(cur.last_seen):'آفلاین')}
function jump(id){const e=$('[data-id="'+id+'"]');if(e){e.scrollIntoView({block:'center'});e.classList.add('fl');setTimeout(()=>e.classList.remove('fl'),800)}}
const RX=['like','heart','fire','star','bolt','gem'],day=t=>new Date(t).toDateString();
const sep=t=>h('div',{className:'day'},h('span',{},new Date(t).toLocaleDateString('fa-IR',{month:'long',day:'numeric'})));
function addMsg(b,m){const l=[...b.querySelectorAll('.m')].pop();if(!l||day(+l.dataset.ts)!=day(m.ts))b.append(sep(m.ts));b.append(bubble(m))}
const lk=t=>t.split(/(https?:\/\/[^\s]+)/g).map((s,i)=>i%2?h('a',{href:s,target:'_blank',rel:'noopener',onclick:e=>e.stopPropagation()},s):s);
function voice(m){const a=h('audio',{src:m.file,preload:'metadata'}),b=h('button',{className:'pl'},ic('play',18)),bar=h('i'),pr=h('div',{className:'pb'},bar),tm=h('span',{},mmss(m.dur)),D=()=>isFinite(a.duration)&&a.duration||m.dur||1;
 b.onclick=e=>{e.stopPropagation();if(a.paused){document.querySelectorAll('audio').forEach(x=>x.pause());a.play()}else a.pause()};a.onplay=()=>b.replaceChildren(ic('pause',18));a.onpause=a.onended=()=>b.replaceChildren(ic('play',18));
 a.ontimeupdate=()=>{bar.style.width=Math.min(100,a.currentTime/D()*100)+'%';tm.textContent=mmss(a.currentTime)};pr.onclick=e=>{e.stopPropagation();const r=pr.getBoundingClientRect(),x=(e.clientX-r.left)/r.width;a.currentTime=(1-x)*D()};return h('div',{className:'vc'},b,pr,tm,a)}
function media(m){
 if(m.kind=='image')return h('img',{src:m.file,loading:'lazy',onclick:e=>{e.stopPropagation();modal(h('img',{src:m.file,className:'lb'}),h('button',{className:'dng',onclick:closeM},'بستن'))}});
 if(m.kind=='video'){const v=h('video',{src:m.file,controls:true,playsInline:true,preload:'metadata'});v.onclick=e=>e.stopPropagation();return v}
 if(m.kind=='voice')return voice(m);
 if(m.kind=='file')return h('a',{className:'fc',href:m.file,download:m.fname||'file',onclick:e=>e.stopPropagation()},h('span',{className:'fi'},ic('file',22)),h('span',{className:'fn'},h('b',{},m.fname||'file'),h('small',{},sz(m.fsize||0))),ic('dl',18))}
function bubble(m){const mine=m.sender==me.id,d=h('div',{className:'m'+(mine?' me':'')});d.dataset.id=m.id;d.dataset.ts=m.ts;
 if(!mine&&cur.type=='g')d.append(h('b',{className:'sn',style:'color:hsl('+(m.sender*67%360)+',70%,62%)'},m.sname));
 if(m.fwd&&!m.del)d.append(h('span',{className:'fw'},'فوروارد از '+m.fwd));
 if(m.reply)d.append(h('div',{className:'rp',onclick:e=>{e.stopPropagation();jump(m.reply.id)}},h('b',{},m.reply.name),h('span',{},m.reply.text)));
 if(m.del)d.append(h('i',{className:'dl'},ic('ban',14),'این پیام حذف شد'));else{const x=media(m);x&&d.append(x);m.text&&d.append(...lk(m.text))}
 if(m.re.length)d.append(h('div',{className:'re'},...m.re.map(r=>h('span',{className:r.us.split(',').includes(''+me.id)?'on':'',onclick:e=>{e.stopPropagation();api('react','POST',{id:m.id,e:r.e})}},ic(r.e),r.n))));
 const ok=m.id<=seen;d.append(h('s',{className:ok&&mine?'r':''},(m.edited&&!m.del?'ویرایش‌شده · ':'')+fa(m.ts),mine?ic(ok?'ck2':'ck1'):null));
 d.onclick=e=>menu(e,m);d.oncontextmenu=e=>{e.preventDefault();menu(e,m)};return d}
const cp=t=>{if(navigator.clipboard&&isSecureContext)navigator.clipboard.writeText(t);else{const a=h('textarea',{value:t});document.body.append(a);a.select();document.execCommand('copy');a.remove()}};
function menu(e,m){if(m.del||cur.preview)return;e.stopPropagation();const mine=m.sender==me.id;
 popup(e.clientX,e.clientY,[!ro()&&['reply','پاسخ',()=>{rep=m;edit=null;bar()}],m.text&&['copy','کپی',()=>cp(m.text)],['fwd','فوروارد',()=>fwd(m)],
 mine&&m.text&&m.kind=='text'&&['edit','ویرایش',()=>{edit=m;rep=null;$('#t').value=m.text;bar()}],
 (mine||(cur.type!='p'&&cur.owner==me.id))&&['trash','حذف',()=>confirm('حذف شود؟')&&api('del','POST',{id:m.id}),1]],
 h('div',{className:'rx'},...RX.map(r=>h('button',{onclick:()=>api('react','POST',{id:m.id,e:r})},ic(r,22)))))}
function fwd(m){const sel=new Set(),tg=chats.filter(c=>c.type!='c'||c.owner==me.id),l=h('div',{style:'max-height:50dvh;overflow:auto'});
 tg.forEach(c=>{const e=h('div',{className:'it',onclick:()=>{sel.has(c.id)?sel.delete(c.id):sel.add(c.id);e.classList.toggle('sel')}},av(c),h('div',{className:'in'},h('b',{},ttl(c))));l.append(e)});
 modal(h('h3',{},'فوروارد به…'),l,h('button',{className:'pbtn',onclick:async()=>{if(!sel.size)return;try{await api('forward','POST',{id:m.id,chats:[...sel]});closeM()}catch(e){alert(e.message)}}},'ارسال'),h('button',{className:'dng',onclick:closeM},'بستن'))}
function sw(){const on=$('#t').value.trim()||edit;$('#sd').style.display=on?'grid':'none';$('#mic').style.display=on?'none':'grid'}
function bar(){const b=$('#ctx'),m=rep||edit;b.innerHTML='';b.style.display=m?'flex':'none';
 if(m)b.append(ic(edit?'edit':'reply',18),h('div',{className:'cx'},h('b',{},edit?'ویرایش پیام':'پاسخ به '+m.sname),h('span',{},(m.text||'رسانه').slice(0,60))),h('button',{onclick:()=>{rep=edit=null;$('#t').value='';bar()}},ic('x',18)));sw();$('#t').focus()}
async function load(){const d=await api('msgs?chat='+cur.id);seen=d.seen;const b=$('#msgs');b.innerHTML='';let pd='';d.msgs.forEach(m=>{const k=day(m.ts);if(k!=pd){b.append(sep(m.ts));pd=k}b.append(bubble(m))});b.scrollTop=b.scrollHeight}
async function openChat(c){cur=c;rep=edit=null;bar();$('#t').value='';sw();$('#em').style.display='none';$('#sb').style.display='none';$('#sq').value='';$('#empty').style.display='none';$('#chat').style.display='flex';$('#app').classList.add('open');
 const pv=!!c.preview;$('#bar').style.display=pv||ro()?'none':'flex';$('#ro').style.display=!pv&&ro()?'block':'none';$('#jn').style.display=pv?'block':'none';status();await load();await refresh()}
function back(){$('#app').classList.remove('open');cur=null;$('#chat').style.display='none';$('#empty').style.display='flex';renderChats()}
$('#back').onclick=back;
$('#jb').onclick=async()=>{try{const c=await api('join','POST',{chat:cur.id});await refresh();openChat(c)}catch(e){alert(e.message)}};
async function send(){const v=$('#t').value.trim();if(!cur||!v)return;$('#t').value='';
 try{edit?await api('edit','POST',{id:edit.id,text:v}):await api('send','POST',{chat:cur.id,text:v,reply:rep&&rep.id})}catch(e){alert(e.message)}rep=edit=null;bar()}
async function sendFile(bl,kind,o){if(!cur)return;toast('در حال ارسال…');try{const d=await upload(bl,o.m);await api('send','POST',{chat:cur.id,text:'',reply:rep&&rep.id,file:{url:d.url,kind,name:o.name||'file',size:bl.size,dur:o.dur||0}});rep=null;bar()}catch(e){alert(e.message||'ارسال نشد')}toast()}
async function files(l){for(const f of l){if(f.size>6e7){alert('حداکثر حجم فایل ۶۰ مگابایت');continue}const t=f.type||'';
 try{if(t.startsWith('image/')&&!t.includes('gif'))await sendFile(await img(f,1600),'image',{name:f.name,m:'image/jpeg'});else await sendFile(f,t.startsWith('image/')?'image':t.startsWith('video/')?'video':'file',{name:f.name,m:t})}catch(e){alert('این فایل ارسال نشد')}}}
$('#f1').onchange=$('#f2').onchange=e=>{const l=[...e.target.files];e.target.value='';files(l)};
$('#ab').onclick=e=>{e.stopPropagation();const r=e.currentTarget.getBoundingClientRect();popup(r.left,r.top-110,[['image','عکس یا ویدئو',()=>$('#f1').click()],['file','فایل',()=>$('#f2').click()]])};
$('#sd').onclick=send;$('#t').onkeydown=e=>e.key=='Enter'&&(pref('ent','1')!='0'||e.ctrlKey)&&send();
$('#t').oninput=()=>{sw();if(cur&&Date.now()-lt>2000){lt=Date.now();api('typing','POST',{chat:cur.id}).catch(()=>{})}};
const EM='😀 😂 🥹 😍 😘 😎 🤔 😢 😭 😡 👍 👎 👏 🙏 💪 🔥 ❤️ 💔 🎉 ✨ 🌹 ☕ 🍕 🎂 😴 🤝 👀 💯 ✅ ❌'.split(' ');
EM.forEach(x=>$('#em').append(h('button',{onclick:()=>{$('#t').value+=x;sw();$('#t').focus()}},x)));
$('#eb').onclick=e=>{e.stopPropagation();const x=$('#em');x.style.display=x.style.display=='flex'?'none':'flex'};
const recUI=on=>{$('#bar').style.display=on?'none':'flex';$('#rb').style.display=on?'flex':'none'};
$('#mic').onclick=async()=>{try{const st=await navigator.mediaDevices.getUserMedia({audio:true}),mt=['audio/webm;codecs=opus','audio/mp4','audio/webm'].find(t=>MediaRecorder.isTypeSupported(t))||'',mr=new MediaRecorder(st,mt?{mimeType:mt}:{}),ch=[];
 mr.ondataavailable=e=>e.data.size&&ch.push(e.data);rec={mr,t0:Date.now(),cancel:false};
 mr.onstop=async()=>{st.getTracks().forEach(t=>t.stop());const R=rec;clearInterval(R.iv);rec=null;recUI(false);const dur=Math.round((Date.now()-R.t0)/1000);if(R.cancel||dur<1)return;const bl=new Blob(ch,{type:mr.mimeType||mt});await sendFile(bl,'voice',{name:'voice',dur,m:bl.type})};
 mr.start();recUI(true);$('#rt').textContent='0:00';rec.iv=setInterval(()=>$('#rt').textContent=mmss((Date.now()-rec.t0)/1000),500)}catch{alert('دسترسی به میکروفون ممکن نیست. با آدرس 127.0.0.1 یا HTTPS باز کن و اجازه‌ی میکروفون بده.')}};
$('#rs').onclick=()=>rec&&rec.mr.stop();$('#rc').onclick=()=>{if(rec){rec.cancel=true;rec.mr.stop()}};
$('#msgs').onscroll=()=>{const m=$('#msgs');$('#dn').style.display=m.scrollHeight-m.scrollTop-m.clientHeight>300?'grid':'none'};$('#dn').onclick=()=>$('#msgs').scrollTo({top:1e9,behavior:'smooth'});
function beep(){if(pref('snd','1')=='0')return;try{const a=new AudioContext(),o=a.createOscillator(),g=a.createGain();o.connect(g);g.connect(a.destination);o.frequency.value=880;g.gain.setValueAtTime(.1,a.currentTime);g.gain.exponentialRampToValueAtTime(.001,a.currentTime+.25);o.start();o.stop(a.currentTime+.25)}catch{}}
async function start(){try{const d=await api('chats');me=d.me;chats=d.chats;initAccountPrefs()}catch(e){return}
 $('#auth').style.display='none';$('#app').style.display='flex';setMe();renderChats();
 es&&es.close();es=new EventSource('/api/events?t='+T);
 es.addEventListener('msg',e=>{const m=JSON.parse(e.data);if(cur&&cur.id==m.chat){const b=$('#msgs'),n=b.scrollHeight-b.scrollTop-b.clientHeight<90;if(!$('[data-id="'+m.id+'"]'))addMsg(b,m);if(n||m.sender==me.id)b.scrollTop=b.scrollHeight;if(m.sender!=me.id)api('read','POST',{chat:m.chat})}else if(m.sender!=me.id)beep();refresh()});
 es.addEventListener('upd',e=>{const m=JSON.parse(e.data),o=cur&&$('[data-id="'+m.id+'"]');o&&o.replaceWith(bubble(m));refresh()});
 es.addEventListener('read',e=>{if(cur&&cur.id==JSON.parse(e.data).chat)load()});
 es.addEventListener('chat',()=>{refresh().then(()=>{if(cur&&!cur.preview&&!chats.find(x=>x.id==cur.id))back()})});es.addEventListener('presence',refresh);
 es.addEventListener('typing',e=>{const d=JSON.parse(e.data);if(cur&&cur.id==d.chat){status(cur.type=='g'?d.name+' در حال نوشتن…':'در حال نوشتن…');clearTimeout(tt);tt=setTimeout(()=>status(),2200)}})}
$('#hsb').onclick=e=>{e.stopPropagation();const x=$('#sb'),on=x.style.display=='flex';x.style.display=on?'none':'flex';if(on){$('#sq').value='';qs('')}else $('#sq').focus()};
$('#sq').oninput=()=>qs($('#sq').value.trim());
function qs(v){let f=null;document.querySelectorAll('#msgs .m').forEach(m=>{const hit=v&&m.textContent.toLowerCase().includes(v.toLowerCase());m.classList.toggle('dim',!!v&&!hit);m.classList.toggle('hit',!!hit);if(hit)f=m});f&&f.scrollIntoView({block:'center'})}
applyUI();sw();if(T)start();
</script></body></html>`;
