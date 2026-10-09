const express = require('express'), http = require('http'), crypto = require('crypto');
const fs = require('fs'), path = require('path');
const { Server } = require('socket.io');
const BUILTIN = require('./bots');

// ---------- الإعدادات ----------
const DATA = process.env.DATA_DIR || __dirname;          // فولدر البيانات (حطه على قرص دائم لو هتنشر)
const UPLOADS = path.join(DATA, 'uploads');
fs.mkdirSync(UPLOADS, { recursive: true });
const MAX = (+process.env.MAX_UPLOAD_MB || 25) * 1024 * 1024;

const app = express(), server = http.createServer(app);
app.set('trust proxy', 1);
const io = new Server(server, { maxHttpBufferSize: 2e5 });

// ---------- التخزين ----------
const FILE = path.join(DATA, 'data.json');
let db = {};
try { db = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch {}
db = Object.assign({ users: {}, sessions: {}, messages: [], groups: {}, files: {}, reminders: [], botTokens: {} }, db);
let timer;
const save = () => {
  clearTimeout(timer);
  timer = setTimeout(() => fs.writeFile(FILE + '.tmp', JSON.stringify(db), e => { if (!e) fs.rename(FILE + '.tmp', FILE, () => {}); }), 300);
};

// ---------- أدوات ----------
const uuid = () => crypto.randomUUID();
const sha = s => crypto.createHash('sha256').update(s).digest('hex');
const hash = (pw, salt) => crypto.scryptSync(pw, salt, 32).toString('hex');
const same = (a, b) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && crypto.timingSafeEqual(x, y); };
const getUser = id => (typeof id === 'string' && Object.hasOwn(db.users, id)) ? db.users[id] : null;
const isGroupId = id => typeof id === 'string' && id[0] === 'g';
const getGroup = id => (isGroupId(id) && Object.hasOwn(db.groups, id)) ? db.groups[id] : null;
const room = id => 'u:' + id;
const isOnline = id => (io.sockets.adapter.rooms.get(room(id))?.size || 0) > 0;
const pub = u => ({ id: u.id, name: u.name, photo: u.photo || '', online: isOnline(u.id), bot: !!u.bot });
const gpub = g => ({
  id: g.id, name: g.name, photo: g.photo || '', isGroup: true, onlyAdmins: !!g.onlyAdmins, admins: g.admins,
  members: g.members.map(getUser).filter(Boolean).map(u => ({ id: u.id, name: u.name, photo: u.photo || '', bot: !!u.bot }))
});
const groupsOf = uid => Object.values(db.groups).filter(g => g.members.includes(uid));
const humans = g => g.members.filter(id => { const u = getUser(id); return u && !u.bot; });
const watchers = id => Object.values(db.users).filter(u => u.contacts && u.contacts.includes(id)).map(u => u.id);
const cleanName = n => typeof n === 'string' ? n.trim().replace(/\s+/g, ' ').slice(0, 30) : '';
const okPhoto = p => p === '' || (typeof p === 'string' && p.length < 60000 && /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(p));
const catalog = () => BUILTIN.map(b => {
  const u = Object.values(db.users).find(x => x.builtin === b.key);
  return { id: u.id, name: b.name, desc: b.desc, commands: Object.keys(b.commands) };
});

function newId() {
  let id;
  do { id = String(crypto.randomInt(1, 10)) + Array.from({ length: 14 }, () => crypto.randomInt(10)).join(''); }
  while (db.users[id]);
  return id;
}
const hits = new Map();
function limited(key, max, ms) {
  const now = Date.now(), h = (hits.get(key) || []).filter(t => now - t < ms);
  h.push(now); hits.set(key, h); return h.length > max;
}
function newSession(id) { const t = crypto.randomBytes(24).toString('hex'); db.sessions[t] = id; save(); return t; }
const userOfToken = t => (typeof t === 'string' && Object.hasOwn(db.sessions, t)) ? db.sessions[t] : null;
function pushMsg(m) { db.messages.push(m); if (db.messages.length > 50000) db.messages.splice(0, db.messages.length - 50000); }

// البوتات المدمجة: تتسجل كمستخدمين مرة واحدة
for (const b of BUILTIN) {
  if (!Object.values(db.users).some(u => u.builtin === b.key)) {
    const id = newId();
    db.users[id] = { id, name: b.name, photo: '', contacts: [], bot: true, builtin: b.key, created: Date.now() };
  }
}
save();

// ---------- الإرسال (مشترك بين البشر والبوتات) ----------
function toMembers(g, evt, data) { g.members.forEach(id => io.to(room(id)).emit(evt, data)); }
function upsert(g) { toMembers(g, 'group:upsert', gpub(g)); }
function sysMsg(g, text) {
  const m = { id: uuid(), from: '', to: g.id, type: 'system', text, ts: Date.now(), status: 'delivered' };
  pushMsg(m); toMembers(g, 'msg:new', m);
}

function postMessage(from, to, p) {
  const sender = getUser(from);
  if (!sender) return { error: 'مرسل غير صحيح' };
  const m = { id: uuid(), from, to, type: p.type || 'text', text: p.text || '', ts: Date.now(), status: 'sent' };
  if (p.url) m.url = p.url;
  if (p.dur) m.dur = p.dur;
  const g = getGroup(to);
  if (g) {
    if (!g.members.includes(from)) return { error: 'انت مش عضو في الجروب ده' };
    if (g.onlyAdmins && !sender.bot && !g.admins.includes(from)) return { error: 'الإدارة فقط تقدر ترسل هنا' };
    m.fn = sender.name; m.status = 'delivered';
    pushMsg(m); toMembers(g, 'msg:new', m);
    if (!sender.bot) g.members.forEach(id => { const b = getUser(id); if (b && b.bot) botHandle(b, m, g); });
  } else {
    const t = getUser(to);
    if (!t || to === from) return { error: 'مستلم غير صحيح' };
    m.status = (t.bot || isOnline(to)) ? 'delivered' : 'sent';
    pushMsg(m);
    if (!t.contacts.includes(from)) { t.contacts.push(from); io.to(room(to)).emit('contact:new', pub(sender)); }
    if (!sender.contacts.includes(to)) sender.contacts.push(to);
    io.to(room(to)).emit('msg:new', m);
    if (!sender.bot) io.to(room(from)).emit('msg:new', m);
    if (t.bot && !sender.bot) botHandle(t, m, null);
  }
  save();
  return { msg: m };
}

// ---------- البوتات ----------
const queues = new Map();
const getQ = id => { if (!queues.has(id)) queues.set(id, { seq: 0, updates: [], waiters: [] }); return queues.get(id); };

function botPost(bot, chat, text) {
  const g = getGroup(chat);
  if (g) { if (!g.members.includes(bot.id)) return { error: 'البوت مش عضو في الجروب' }; }
  else if (!getUser(chat) || !db.messages.some(x => x.from === chat && x.to === bot.id)) return { error: 'المستخدم لسه ماكلمش البوت' };
  return postMessage(bot.id, chat, { type: 'text', text: String(text).slice(0, 2000) });
}
function mkCtx(bot, user, g, chat, argStr) {
  return {
    user: { id: user.id, name: user.name }, args: argStr ? argStr.split(/\s+/) : [], argStr, group: g,
    isAdmin: !!g && g.admins.includes(user.id),
    reply: t => botPost(bot, chat, t), save, nameOf: id => (getUser(id) || {}).name || id,
    remind: (ms, text) => { db.reminders.push({ id: uuid(), chat, bot: bot.id, name: user.name, at: Date.now() + ms, text }); save(); }
  };
}
function runDef(fn, ctx) { try { const r = fn(ctx); if (r && r.catch) r.catch(() => {}); } catch (e) { console.error(e); } }

function botHandle(bot, m, g) {
  if (m.type !== 'text') return;
  const sender = getUser(m.from), chat = g ? g.id : m.from, isCmd = m.text.startsWith('/');
  if (bot.builtin) {
    const def = BUILTIN.find(b => b.key === bot.builtin);
    if (!def) return;
    if (!isCmd) { if (!g) botPost(bot, chat, 'اكتب /help أو أي أمر يبدأ بـ / عشان أساعدك.'); return; }
    const sp = m.text.trim().split(/\s+/), cmd = sp[0].split('@')[0].toLowerCase();
    const fn = def.commands[cmd];
    if (!fn) { if (!g) botPost(bot, chat, 'الأمر غير معروف. جرّب /help'); return; }
    runDef(fn, mkCtx(bot, sender, g, chat, sp.slice(1).join(' ')));
  } else {
    if (g && !isCmd) return;                       // في الجروبات البوت الخارجي يشوف الأوامر بس
    const q = getQ(bot.id);
    q.updates.push({
      update_id: ++q.seq,
      message: { id: m.id, chat, chat_type: g ? 'group' : 'private', chat_name: g ? g.name : undefined,
                 from: { id: sender.id, name: sender.name }, text: m.text, ts: m.ts }
    });
    if (q.updates.length > 500) q.updates.shift();
    const w = q.waiters; q.waiters = []; w.forEach(f => f());
  }
}
setInterval(() => {
  const now = Date.now(), due = db.reminders.filter(r => r.at <= now);
  if (!due.length) return;
  db.reminders = db.reminders.filter(r => r.at > now);
  due.forEach(r => { const b = getUser(r.bot); if (b) botPost(b, r.chat, '⏰ تذكير لـ ' + r.name + ': ' + r.text); });
  save();
}, 5000);

// ---------- الجروبات ----------
function addMember(g, actor, id) {
  const u = getUser(id);
  if (!u) return 'مفيش حساب بالرقم ده';
  if (g.members.includes(id)) return 'العضو موجود بالفعل';
  if (g.members.length >= 256) return 'الجروب وصل الحد الأقصى (256)';
  if (u.bot && g.members.filter(x => (getUser(x) || {}).bot).length >= 10) return 'الحد الأقصى 10 بوتات في الجروب';
  g.members.push(id);
  upsert(g);
  sysMsg(g, actor.name + ' أضاف ' + u.name);
  if (!u.bot) g.members.forEach(bid => {
    const b = getUser(bid), def = b && b.builtin && BUILTIN.find(x => x.key === b.builtin);
    if (def && def.onJoin) runDef(def.onJoin, mkCtx(b, u, g, g.id, ''));
  });
  save();
  return null;
}
function deleteGroup(g) {
  toMembers(g, 'group:remove', { id: g.id });
  delete db.groups[g.id];
  db.messages = db.messages.filter(m => m.to !== g.id);
}
function dropMember(g, id) {
  g.members = g.members.filter(x => x !== id);
  g.admins = g.admins.filter(x => x !== id);
  io.to(room(id)).emit('group:remove', { id: g.id });
  const h = humans(g);
  if (!h.length) return deleteGroup(g);
  if (!g.admins.length) g.admins.push(h[0]);
  upsert(g);
}

// ---------- الملفات (رفع) ----------
const MIMES = {
  'image/jpeg': ['jpg', 'image'], 'image/png': ['png', 'image'], 'image/webp': ['webp', 'image'], 'image/gif': ['gif', 'image'],
  'video/mp4': ['mp4', 'video'], 'video/webm': ['webm', 'video'], 'video/quicktime': ['mov', 'video'],
  'audio/webm': ['weba', 'audio'], 'audio/ogg': ['ogg', 'audio'], 'audio/mpeg': ['mp3', 'audio'], 'audio/mp4': ['m4a', 'audio'],
  'audio/x-m4a': ['m4a', 'audio'], 'audio/aac': ['aac', 'audio'], 'audio/wav': ['wav', 'audio'], 'audio/x-wav': ['wav', 'audio']
};
app.use('/files', express.static(UPLOADS, {
  index: false, dotfiles: 'deny', maxAge: '7d', immutable: true,
  setHeaders: (res, p) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (p.endsWith('.weba')) res.setHeader('Content-Type', 'audio/webm');
  }
}));

app.post('/api/upload', (req, res) => {
  const uid = userOfToken((req.headers.authorization || '').replace(/^Bearer /, ''));
  if (!uid) return res.status(401).json({ error: 'سجّل الدخول من جديد' });
  if (limited('u' + uid, 40, 60e3)) return res.status(429).json({ error: 'رفع كتير، استنى شوية' });
  const mime = (req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  const info = MIMES[mime];
  if (!info) return res.status(415).json({ error: 'نوع الملف غير مدعوم (صور JPG/PNG/WebP/GIF، فيديو MP4/WebM/MOV، صوت)' });
  if ((+req.headers['content-length'] || 0) > MAX) { res.set('Connection', 'close'); req.resume(); return res.status(413).json({ error: 'الملف كبير، الحد الأقصى ' + MAX / 1048576 + ' ميجا' }); }
  const name = crypto.randomBytes(16).toString('hex') + '.' + info[0], full = path.join(UPLOADS, name);
  const out = fs.createWriteStream(full);
  let size = 0, over = false;
  req.on('data', c => {
    size += c.length;
    if (size > MAX && !over) { over = true; req.unpipe(out); out.destroy(); fs.unlink(full, () => {}); req.resume(); res.set('Connection', 'close'); res.status(413).json({ error: 'الملف كبير' }); }
  });
  req.pipe(out);
  out.on('finish', () => {
    if (over) return;
    db.files[name] = { owner: uid, kind: info[1], size, ts: Date.now() }; save();
    res.json({ url: '/files/' + name, kind: info[1] });
  });
  out.on('error', () => { if (!res.headersSent) res.status(500).json({ error: 'فشل حفظ الملف' }); });
  req.on('aborted', () => { out.destroy(); fs.unlink(full, () => {}); });
});

// ---------- API التسجيل والدخول ----------
app.use(express.json({ limit: '10kb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.post('/api/register', (req, res) => {
  if (limited('r' + req.ip, 20, 3600e3)) return res.status(429).json({ error: 'محاولات كتيرة، جرّب بعد شوية' });
  const name = cleanName((req.body || {}).name), pw = (req.body || {}).password;
  if (!name) return res.status(400).json({ error: 'اكتب اسمك' });
  if (typeof pw !== 'string' || pw.length < 6 || pw.length > 100) return res.status(400).json({ error: 'كلمة السر لازم 6 أحرف على الأقل' });
  const id = newId(), salt = crypto.randomBytes(16).toString('hex');
  db.users[id] = { id, name, salt, hash: hash(pw, salt), photo: '', contacts: [], created: Date.now() };
  res.json({ id, token: newSession(id) });
});
app.post('/api/login', (req, res) => {
  const { id, password } = req.body || {};
  if (limited('l' + id + req.ip, 10, 60e3)) return res.status(429).json({ error: 'محاولات كتيرة، جرّب بعد دقيقة' });
  const u = typeof id === 'string' ? getUser(id.replace(/\D/g, '')) : null;
  if (!u || u.bot || typeof password !== 'string' || !same(hash(password, u.salt), u.hash))
    return res.status(401).json({ error: 'الرقم أو كلمة السر غلط' });
  res.json({ id: u.id, token: newSession(u.id) });
});

// ---------- API البوتات الخارجية ----------
const botByToken = t => (typeof t === 'string' && Object.hasOwn(db.botTokens, sha(t))) ? getUser(db.botTokens[sha(t)]) : null;
app.get('/api/bot/:token/me', (req, res) => {
  const b = botByToken(req.params.token);
  if (!b) return res.status(401).json({ ok: false, error: 'invalid token' });
  res.json({ ok: true, id: b.id, name: b.name });
});
app.get('/api/bot/:token/updates', (req, res) => {
  const bot = botByToken(req.params.token);
  if (!bot) return res.status(401).json({ ok: false, error: 'invalid token' });
  const q = getQ(bot.id), off = +req.query.offset || 0;
  q.updates = q.updates.filter(u => u.update_id >= off);
  const wait = Math.min(+req.query.timeout || 0, 30) * 1000;
  const reply = () => res.json({ ok: true, updates: q.updates.slice(0, 100) });
  if (q.updates.length || !wait) return reply();
  let tm;
  const w = () => { clearTimeout(tm); reply(); };
  tm = setTimeout(() => { q.waiters = q.waiters.filter(x => x !== w); reply(); }, wait);
  q.waiters.push(w);
  res.on('close', () => { clearTimeout(tm); q.waiters = q.waiters.filter(x => x !== w); });
});
app.post('/api/bot/:token/send', (req, res) => {
  const bot = botByToken(req.params.token);
  if (!bot) return res.status(401).json({ ok: false, error: 'invalid token' });
  if (limited('bs' + bot.id, 30, 10e3)) return res.status(429).json({ ok: false, error: 'too many messages' });
  const { chat, text } = req.body || {};
  if (typeof text !== 'string' || !text.trim() || text.length > 2000) return res.status(400).json({ ok: false, error: 'bad text' });
  const r = botPost(bot, chat, text.trim());
  if (r.error) return res.status(400).json({ ok: false, error: r.error });
  res.json({ ok: true, message_id: r.msg.id });
});

// ---------- Socket.IO ----------
io.use((s, next) => {
  const id = userOfToken(s.handshake.auth && s.handshake.auth.token);
  if (!id || !getUser(id)) return next(new Error('auth'));
  s.uid = id; next();
});

io.on('connection', s => {
  const uid = s.uid, me = getUser(uid);
  s.join(room(uid));

  const senders = new Set();
  db.messages.forEach(m => { if (m.to === uid && m.status === 'sent') { m.status = 'delivered'; senders.add(m.from); } });
  senders.forEach(f => io.to(room(f)).emit('msg:status', { peer: uid, status: 'delivered' }));
  if (senders.size) save();

  const myG = groupsOf(uid), gset = new Set(myG.map(g => g.id));
  s.emit('sync', {
    me: { id: uid, name: me.name, photo: me.photo || '' },
    contacts: me.contacts.map(getUser).filter(Boolean).map(pub),
    groups: myG.map(gpub),
    messages: db.messages.filter(m => m.from === uid || m.to === uid || gset.has(m.to)).slice(-1500),
    catalog: catalog(),
    myBots: Object.values(db.users).filter(u => u.owner === uid).map(u => ({ id: u.id, name: u.name }))
  });
  if (io.sockets.adapter.rooms.get(room(uid)).size === 1)
    watchers(uid).forEach(w => io.to(room(w)).emit('presence', { id: uid, online: true }));

  s.on('contact:add', (raw, ack) => {
    if (typeof ack !== 'function') return;
    const id = String(raw).replace(/\D/g, '');
    if (id.length !== 15) return ack({ ok: false, error: 'الرقم لازم يكون 15 رقم' });
    if (id === uid) return ack({ ok: false, error: 'ده رقمك أنت' });
    const t = getUser(id);
    if (!t) return ack({ ok: false, error: 'مفيش حساب بالرقم ده' });
    if (!me.contacts.includes(id)) { me.contacts.push(id); save(); }
    ack({ ok: true, contact: pub(t) });
  });

  s.on('msg:send', (d, ack) => {
    if (typeof ack !== 'function') return;
    if (limited('m' + uid, 30, 10e3)) return ack({ ok: false, error: 'بتبعت بسرعة، استنى شوية' });
    d = d || {};
    const type = ['text', 'image', 'video', 'audio'].includes(d.type) ? d.type : 'text';
    const text = typeof d.text === 'string' ? d.text.trim() : '';
    if (text.length > 2000) return ack({ ok: false, error: 'الرسالة طويلة جدًا' });
    const p = { type, text };
    if (type === 'text') { if (!text) return ack({ ok: false, error: 'الرسالة فاضية' }); }
    else {
      const mt = /^\/files\/([a-f0-9]{32}\.[a-z0-9]{2,4})$/.exec(String(d.url || ''));
      const f = mt && Object.hasOwn(db.files, mt[1]) ? db.files[mt[1]] : null;
      if (!f || f.owner !== uid || f.kind !== type) return ack({ ok: false, error: 'الملف غير صالح' });
      p.url = d.url;
      const dur = Number(d.dur); if (dur > 0 && dur < 7200) p.dur = Math.round(dur);
    }
    const r = postMessage(uid, d.to, p);
    if (r.error) return ack({ ok: false, error: r.error });
    ack({ ok: true, msg: r.msg });
  });

  s.on('msg:read', peer => {
    if (!getUser(peer)) return;
    let n = 0;
    db.messages.forEach(m => { if (m.from === peer && m.to === uid && m.status !== 'read') { m.status = 'read'; n++; } });
    if (n) { save(); io.to(room(peer)).emit('msg:status', { peer: uid, status: 'read' }); }
  });

  s.on('typing', d => {
    if (!d) return;
    const g = getGroup(d.to);
    if (g) { if (g.members.includes(uid)) g.members.forEach(id => id !== uid && io.to(room(id)).emit('typing', { chat: g.id, from: uid, on: !!d.on })); return; }
    if (getUser(d.to)) io.to(room(d.to)).emit('typing', { chat: uid, from: uid, on: !!d.on });
  });

  s.on('profile:update', (d, ack) => {
    if (typeof ack !== 'function') return;
    const name = cleanName(d && d.name);
    if (!name) return ack({ ok: false, error: 'اكتب اسمك' });
    if (!okPhoto(d.photo)) return ack({ ok: false, error: 'الصورة غير صالحة' });
    me.name = name; me.photo = d.photo; save();
    watchers(uid).forEach(w => io.to(room(w)).emit('contact:update', pub(me)));
    ack({ ok: true });
  });

  // ----- جروبات -----
  const adminOf = (d, ack) => {
    const g = getGroup(d && d.id);
    if (!g || !g.members.includes(uid)) { ack({ ok: false, error: 'الجروب غير موجود' }); return null; }
    if (!g.admins.includes(uid)) { ack({ ok: false, error: 'ده للمشرفين فقط' }); return null; }
    return g;
  };

  s.on('group:create', (d, ack) => {
    if (typeof ack !== 'function') return;
    if (limited('gc' + uid, 10, 3600e3)) return ack({ ok: false, error: 'عملت جروبات كتير، جرّب بعد شوية' });
    const name = cleanName(d && d.name);
    if (!name) return ack({ ok: false, error: 'اكتب اسم الجروب' });
    const ids = [...new Set(Array.isArray(d.members) ? d.members.map(x => String(x).replace(/\D/g, '')) : [])]
      .filter(id => id !== uid && getUser(id)).slice(0, 255);
    const g = { id: 'g' + crypto.randomBytes(8).toString('hex'), name, photo: '', admins: [uid], members: [uid, ...ids], onlyAdmins: false, created: Date.now() };
    db.groups[g.id] = g;
    upsert(g);
    sysMsg(g, me.name + ' أنشأ الجروب');
    save();
    ack({ ok: true, group: gpub(g) });
  });

  s.on('group:update', (d, ack) => {
    if (typeof ack !== 'function') return;
    const g = adminOf(d, ack); if (!g) return;
    const notes = [];
    if (d.name !== undefined) {
      const n = cleanName(d.name);
      if (!n) return ack({ ok: false, error: 'اكتب اسم الجروب' });
      if (n !== g.name) { notes.push(me.name + ' غيّر اسم الجروب إلى "' + n + '"'); g.name = n; }
    }
    if (d.photo !== undefined) { if (!okPhoto(d.photo)) return ack({ ok: false, error: 'الصورة غير صالحة' }); g.photo = d.photo; }
    if (d.onlyAdmins !== undefined && !!d.onlyAdmins !== !!g.onlyAdmins) {
      g.onlyAdmins = !!d.onlyAdmins;
      notes.push(g.onlyAdmins ? 'الإرسال بقى للمشرفين فقط' : 'كل الأعضاء يقدروا يرسلوا');
    }
    upsert(g); notes.forEach(n => sysMsg(g, n)); save();
    ack({ ok: true });
  });

  s.on('group:add', (d, ack) => {
    if (typeof ack !== 'function') return;
    const g = adminOf(d, ack); if (!g) return;
    const err = addMember(g, me, String(d.member).replace(/\D/g, ''));
    ack(err ? { ok: false, error: err } : { ok: true });
  });

  s.on('group:remove', (d, ack) => {
    if (typeof ack !== 'function') return;
    const g = adminOf(d, ack); if (!g) return;
    const t = getUser(d.member);
    if (!t || !g.members.includes(t.id)) return ack({ ok: false, error: 'العضو مش في الجروب' });
    if (t.id === uid) return ack({ ok: false, error: 'استخدم "مغادرة الجروب"' });
    if (g.admins.includes(t.id) && !t.bot) return ack({ ok: false, error: 'الغي إشرافه الأول' });
    dropMember(g, t.id);
    if (db.groups[g.id]) sysMsg(g, me.name + ' أزال ' + t.name);
    save(); ack({ ok: true });
  });

  s.on('group:role', (d, ack) => {
    if (typeof ack !== 'function') return;
    const g = adminOf(d, ack); if (!g) return;
    const t = getUser(d.member);
    if (!t || t.bot || !g.members.includes(t.id)) return ack({ ok: false, error: 'عضو غير صالح' });
    if (d.admin) {
      if (!g.admins.includes(t.id)) { g.admins.push(t.id); upsert(g); sysMsg(g, me.name + ' رقّى ' + t.name + ' لمشرف'); }
    } else {
      if (g.admins.length < 2) return ack({ ok: false, error: 'لازم يفضل مشرف واحد على الأقل' });
      g.admins = g.admins.filter(x => x !== t.id); upsert(g); sysMsg(g, me.name + ' ألغى إشراف ' + t.name);
    }
    save(); ack({ ok: true });
  });

  s.on('group:leave', (d, ack) => {
    if (typeof ack !== 'function') return;
    const g = getGroup(d && d.id);
    if (!g || !g.members.includes(uid)) return ack({ ok: false, error: 'الجروب غير موجود' });
    dropMember(g, uid);
    if (db.groups[g.id]) sysMsg(g, me.name + ' غادر الجروب');
    save(); ack({ ok: true });
  });

  // ----- بوتات المستخدم -----
  s.on('bot:create', (d, ack) => {
    if (typeof ack !== 'function') return;
    const name = cleanName(d && d.name);
    if (!name) return ack({ ok: false, error: 'اكتب اسم البوت' });
    if (Object.values(db.users).filter(u => u.owner === uid).length >= 5) return ack({ ok: false, error: 'الحد الأقصى 5 بوتات' });
    const id = newId(), token = id + ':' + crypto.randomBytes(20).toString('hex');
    db.users[id] = { id, name, photo: '', contacts: [], bot: true, owner: uid, created: Date.now() };
    db.botTokens[sha(token)] = id; save();
    ack({ ok: true, bot: { id, name }, token });
  });
  s.on('bot:delete', (d, ack) => {
    if (typeof ack !== 'function') return;
    const b = getUser(d && d.id);
    if (!b || b.owner !== uid) return ack({ ok: false, error: 'مش بوتك' });
    groupsOf(b.id).forEach(g => dropMember(g, b.id));
    for (const k of Object.keys(db.botTokens)) if (db.botTokens[k] === b.id) delete db.botTokens[k];
    delete db.users[b.id]; queues.delete(b.id); save();
    ack({ ok: true });
  });

  s.on('disconnect', () => {
    if (!isOnline(uid)) watchers(uid).forEach(w => io.to(room(w)).emit('presence', { id: uid, online: false }));
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('الشات شغال على http://localhost:' + PORT));
