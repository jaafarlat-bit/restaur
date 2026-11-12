const express = require('express'), fs = require('fs'), path = require('path'), crypto = require('crypto');
const DATA = process.env.DATA_DIR || path.join(__dirname, 'data');
fs.mkdirSync(path.join(DATA, 'img'), { recursive: true });
const DB = path.join(DATA, 'db.json');
const SECRET = process.env.SECRET || (() => {
  const f = path.join(DATA, 'secret');
  if (!fs.existsSync(f)) fs.writeFileSync(f, crypto.randomBytes(32).toString('hex'));
  return fs.readFileSync(f, 'utf8');
})();
let db = { restaurants: [] };
try { db = JSON.parse(fs.readFileSync(DB, 'utf8')); } catch (e) {}
const save = () => { fs.writeFileSync(DB + '.tmp', JSON.stringify(db)); fs.renameSync(DB + '.tmp', DB); };
const hash = (p, s) => crypto.scryptSync(p, s, 32).toString('hex');
const mac = b => crypto.createHmac('sha256', SECRET).update(b).digest('hex');
const sign = id => { const b = id + '.' + Date.now(); return b + '.' + mac(b); };
const verify = t => {
  const p = String(t || '').split('.');
  if (p.length !== 3) return null;
  const ok = mac(p[0] + '.' + p[1]);
  if (p[2].length !== ok.length || !crypto.timingSafeEqual(Buffer.from(p[2]), Buffer.from(ok))) return null;
  if (Date.now() - Number(p[1]) > 30 * 864e5) return null;
  return db.restaurants.find(r => r.id === p[0]) || null;
};
const normIg = v => {
  v = String(v || '').trim(); if (!v) return '';
  if (/^@?[A-Za-z0-9._]{1,30}$/.test(v)) return 'https://www.instagram.com/' + v.replace('@', '');
  try { const u = new URL(/^https?:/i.test(v) ? v : 'https://' + v); if (/(^|\.)instagram\.com$/.test(u.hostname)) { u.protocol = 'https:'; return u.href.slice(0, 300); } } catch (e) {}
  return '';
};
const normUrl = v => {
  v = String(v || '').trim(); if (!v) return '';
  try { const u = new URL(/^https?:/i.test(v) ? v : 'https://' + v); if (u.hostname.includes('.')) { u.protocol = 'https:'; return u.href.slice(0, 300); } } catch (e) {}
  return '';
};
const cleanSlug = v => String(v || '').toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 40);
const IMG_RE = /^[a-f0-9]{32}\.jpg$/;
const str = (v, n) => String(v == null ? '' : v).trim().slice(0, n);
const money = v => Math.max(0, Math.round((Number(v) || 0) * 100) / 100);

// ---------- Catégories, plats, horaires (nettoyage de ce qui arrive du navigateur) ----------
const DEF_CATS = [
  { id: 'ent', fr: 'Entrées', ar: 'المقبلات', en: 'Starters' },
  { id: 'pla', fr: 'Plats', ar: 'الأطباق', en: 'Mains' },
  { id: 'des', fr: 'Desserts', ar: 'الحلويات', en: 'Desserts' },
  { id: 'boi', fr: 'Boissons', ar: 'المشروبات', en: 'Drinks' }
];
const catsOf = r => (Array.isArray(r.cats) && r.cats.length ? r.cats : DEF_CATS);
const cleanCats = list => {
  const out = [], seen = new Set();
  for (const c of Array.isArray(list) ? list.slice(0, 20) : []) {
    let id = /^[a-z0-9]{1,12}$/.test(c && c.id) ? c.id : crypto.randomBytes(4).toString('hex');
    if (seen.has(id)) continue; seen.add(id);
    out.push({ id, fr: str(c.fr, 40) || 'Catégorie', ar: str(c.ar, 40), en: str(c.en, 40) });
  }
  return out.length ? out : DEF_CATS.map(c => Object.assign({}, c));
};
// Jours de disponibilité d'un plat : 0 = dimanche … 6 = samedi. Liste vide = tous les jours.
const cleanDays = d => Array.isArray(d) ? [...new Set(d.map(Number).filter(n => Number.isInteger(n) && n >= 0 && n <= 6))].sort() : [];
const cleanItem = (i, cats) => ({
  id: str(i.id, 40) || crypto.randomUUID(),
  cat: cats.some(c => c.id === i.cat) ? i.cat : cats[0].id,
  fr: str(i.fr, 80), ar: str(i.ar, 80), en: str(i.en, 80),
  price: money(i.price), on: i.on !== false,
  img: IMG_RE.test(i.img || '') ? i.img : '',
  days: cleanDays(i.days),
  // Tailles (ex. Moyen / Grand) avec leur prix, options gratuites (ex. Sans oignon), suppléments payants.
  sizes: (Array.isArray(i.sizes) ? i.sizes.slice(0, 4) : []).map(s => ({ n: str(s && s.n, 20), p: money(s && s.p) })).filter(s => s.n),
  opts: (Array.isArray(i.opts) ? i.opts.slice(0, 10) : []).map(o => str(o, 30)).filter(Boolean),
  extras: (Array.isArray(i.extras) ? i.extras.slice(0, 10) : []).map(e => ({ n: str(e && e.n, 30), p: money(e && e.p) })).filter(e => e.n)
});
const HM = /^([01]\d|2[0-3]):[0-5]\d$/;
const cleanHours = h => {
  const out = {};
  if (h && typeof h === 'object') for (let d = 0; d < 7; d++) {
    const v = h[d];
    if (v === null) out[d] = null;
    else if (v && HM.test(v.o) && HM.test(v.c)) out[d] = { o: v.o, c: v.c };
  }
  return Object.keys(out).length === 7 ? out : {};
};
const cleanColor = v => (/^#[0-9a-fA-F]{6}$/.test(v || '') ? v : '');
const findSlug = sl => db.restaurants.find(x => x.slug === sl || (x.oldSlugs || []).includes(sl));

// ---------- Photos des plats ----------
// photos/ = vraies photos (prioritaires), photos/illustrations/ = dessins de secours.
// Le nom du fichier est comparé au nom du plat (accents, majuscules, espaces et _ ignorés).
const PHOTOS = path.join(__dirname, 'photos'), ILLUS = path.join(PHOTOS, 'illustrations');
const IMG_EXT = /\.(jpe?g|jfif|png|webp|avif|gif)$/i;
const STOP = new Set(['de', 'du', 'des', 'au', 'aux', 'a', 'la', 'le', 'les', 'et', 'd', 'l', 'en', 'with']);
const slugify = t => String(t || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
const words = sl => sl.split('-').filter(w => w && !STOP.has(w));
let photoIdx = null, photoStamp = '';
const scanDir = (dir, url) => { try { return fs.readdirSync(dir).filter(f => IMG_EXT.test(f)).map(f => ({ url: url + encodeURIComponent(f), sl: slugify(f.replace(IMG_EXT, '')), size: fs.statSync(path.join(dir, f)).size })); } catch (e) { return []; } };
const photoIndex = () => {
  let stamp = ''; try { stamp = fs.statSync(PHOTOS).mtimeMs + '/' + fs.statSync(ILLUS).mtimeMs; } catch (e) {}
  if (!photoIdx || stamp !== photoStamp) {
    photoIdx = { real: scanDir(PHOTOS, '/photos/').map(p => Object.assign(p, { w: words(p.sl) })), illus: scanDir(ILLUS, '/photos/illustrations/') };
    photoStamp = stamp;
  }
  return photoIdx;
};
const photoFor = name => {
  const sl = slugify(name); if (!sl) return '';
  const { real, illus } = photoIndex(), dw = words(sl), big = (a, b) => b.size - a.size;
  const exact = real.filter(p => p.sl === sl).sort(big)[0];
  if (exact) return exact.url;
  // Correspondance souple : chaque mot du fichier doit commencer un mot du plat (ex. « taj_kefta » → « Tajine kefta aux œufs »).
  let best = null, bestN = 0;
  for (const p of real) {
    if (!p.w.length || !p.w.every(w => dw.some(d => d.startsWith(w)))) continue;
    if (p.w.length > bestN || (p.w.length === bestN && p.size > best.size)) { best = p; bestN = p.w.length; }
  }
  if (best) return best.url;
  const ill = illus.find(p => p.sl === sl);
  return ill ? ill.url : '';
};

const pub = r => ({
  name: r.name, slug: r.slug, wa: r.wa, ig: r.ig || '', review: r.review || '',
  logo: r.logo || '', color: r.color || '', addr: r.addr || '', hours: r.hours || {}, cats: catsOf(r),
  items: r.items.map(i => i.img ? i : Object.assign({}, i, { ph: photoFor(i.fr) }))
});
const mine = r => Object.assign(pub(r), { email: r.email });

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);
const jsonSmall = express.json({ limit: '3mb' }), jsonBig = express.json({ limit: '25mb' });
app.use((q, s, n) => (q.path === '/api/import' ? n() : jsonSmall(q, s, n)));
const auth = (q, s, n) => {
  const r = verify((q.headers.authorization || '').replace('Bearer ', ''));
  if (!r) return s.status(401).json({ error: 'auth' });
  q.r = r; n();
};
const sha = x => crypto.createHash('sha256').update(x).digest('hex');
const hits = {};
const limited = (k, max, ms) => {
  const n = Date.now(), a = hits[k] = (hits[k] || []).filter(t => n - t < ms);
  if (a.length >= max) return true;
  a.push(n); return false;
};

app.post('/api/signup', (q, s) => {
  const { name, slug, wa, email, password } = q.body || {};
  const sl = cleanSlug(slug);
  if (!name || !sl || !email || String(password || '').length < 6) return s.status(400).json({ error: 'invalid' });
  if (findSlug(sl) || db.restaurants.some(r => r.email === email)) return s.status(409).json({ error: 'exists' });
  const salt = crypto.randomBytes(16).toString('hex');
  const r = { id: crypto.randomUUID(), name: str(name, 80), slug: sl, wa: str(wa, 20), email: str(email, 120), salt, pw: hash(String(password), salt), cats: DEF_CATS.map(c => Object.assign({}, c)), items: [] };
  db.restaurants.push(r); save();
  s.json({ token: sign(r.id) });
});
app.post('/api/login', (q, s) => {
  const b = q.body || {};
  if (limited('li:' + q.ip, 30, 15 * 60e3)) return s.status(429).json({ error: 'many' });
  const r = db.restaurants.find(x => x.email === b.email);
  if (!r || hash(String(b.password || ''), r.salt) !== r.pw) return s.status(401).json({ error: 'login' });
  s.json({ token: sign(r.id) });
});
async function sendMail(to, subject, text, html) {
  const key = process.env.BREVO_API_KEY, from = process.env.MAIL_FROM;
  if (!key || !from) { console.log('Email non configuré : définissez BREVO_API_KEY et MAIL_FROM'); return false; }
  const r = await fetch(process.env.MAIL_API_URL || 'https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: { 'api-key': key, 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ sender: { name: process.env.MAIL_NAME || 'Orderely', email: from }, to: [{ email: to }], subject, textContent: text, htmlContent: html })
  });
  if (!r.ok) console.log('Erreur envoi email', r.status, await r.text());
  return r.ok;
}
const baseUrl = q => (process.env.APP_URL || process.env.RENDER_EXTERNAL_URL || (q ? q.protocol + '://' + q.get('host') : 'http://localhost:' + (process.env.PORT || 3000))).replace(/\/$/, '');
app.post('/api/forgot', async (q, s) => {
  if (limited('fi:' + q.ip, 10, 3600e3)) return s.status(429).json({ error: 'many' });
  const email = String((q.body || {}).email || '').trim().toLowerCase();
  const r = email && db.restaurants.find(x => x.email.toLowerCase() === email);
  if (r && !limited('fe:' + email, 3, 3600e3)) {
    try {
      const tok = crypto.randomBytes(32).toString('hex');
      r.resetHash = sha(tok); r.resetExp = Date.now() + 3600e3; save();
      const link = baseUrl(q) + '/nouveau-mot-de-passe?t=' + tok;
      await sendMail(r.email, 'Réinitialisation de votre mot de passe',
        'Bonjour,\n\nPour choisir un nouveau mot de passe, ouvrez ce lien (valable 1 heure) :\n' + link + '\n\nSi vous n’avez pas fait cette demande, ignorez ce message.',
        '<p>Bonjour,</p><p>Pour choisir un nouveau mot de passe, cliquez sur ce lien (valable 1 heure) :</p><p><a href="' + link + '">Choisir un nouveau mot de passe</a></p><p>Si vous n’avez pas fait cette demande, ignorez ce message.</p>');
    } catch (e) { console.log('Erreur mot de passe oublié :', e.message); }
  }
  s.json({ ok: true });
});
app.post('/api/reset-password', (q, s) => {
  if (limited('rp:' + q.ip, 20, 3600e3)) return s.status(429).json({ error: 'many' });
  const b = q.body || {};
  if (String(b.password || '').length < 6) return s.status(400).json({ error: 'invalid' });
  const h = sha(String(b.token || ''));
  const r = db.restaurants.find(x => x.resetHash === h && x.resetExp > Date.now());
  if (!r) return s.status(400).json({ error: 'token' });
  r.salt = crypto.randomBytes(16).toString('hex');
  r.pw = hash(String(b.password), r.salt);
  delete r.resetHash; delete r.resetExp;
  save(); s.json({ ok: true });
});
const fails = {};
app.post('/api/reset', (q, s) => {
  const now = Date.now();
  const f = fails[q.ip] = (fails[q.ip] || []).filter(t => now - t < 15 * 60e3);
  if (f.length >= 5) return s.status(429).json({ error: 'many' });
  const key = process.env.ADMIN_KEY || '';
  if (key.length < 12) return s.status(503).json({ error: 'noadmin' });
  const b = q.body || {};
  const A = Buffer.from(String(b.adminKey || '')), B = Buffer.from(key);
  if (A.length !== B.length || !crypto.timingSafeEqual(A, B)) { f.push(now); return s.status(403).json({ error: 'key' }); }
  const r = db.restaurants.find(x => x.email === b.email);
  if (!r) return s.status(404).json({ error: 'none' });
  if (String(b.password || '').length < 6) return s.status(400).json({ error: 'invalid' });
  r.salt = crypto.randomBytes(16).toString('hex');
  r.pw = hash(String(b.password), r.salt);
  save(); s.json({ ok: true });
});

// ---------- Compte : email, mot de passe, lien, suppression (mot de passe actuel obligatoire) ----------
const checkPw = (q, s) => {
  if (limited('pw:' + q.ip, 10, 15 * 60e3)) { s.status(429).json({ error: 'many' }); return false; }
  if (hash(String((q.body || {}).password || ''), q.r.salt) !== q.r.pw) { s.status(401).json({ error: 'pw' }); return false; }
  return true;
};
app.post('/api/account', auth, (q, s) => {
  if (!checkPw(q, s)) return;
  const b = q.body || {}, r = q.r;
  if (b.email !== undefined && b.email !== r.email) {
    const e = str(b.email, 120);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) return s.status(400).json({ error: 'email' });
    if (db.restaurants.some(x => x !== r && x.email === e)) return s.status(409).json({ error: 'emailused' });
    r.email = e;
  }
  if (b.slug !== undefined && b.slug !== r.slug) {
    const sl = cleanSlug(b.slug);
    if (!sl) return s.status(400).json({ error: 'slug' });
    const o = findSlug(sl);
    if (o && o !== r) return s.status(409).json({ error: 'slugused' });
    // L'ancien lien continue de marcher : les QR codes déjà imprimés ne sont pas perdus.
    r.oldSlugs = [...new Set([r.slug, ...(r.oldSlugs || [])])].filter(x => x !== sl).slice(0, 5);
    r.slug = sl;
  }
  if (b.newPassword) {
    if (String(b.newPassword).length < 6) return s.status(400).json({ error: 'newpw' });
    r.salt = crypto.randomBytes(16).toString('hex');
    r.pw = hash(String(b.newPassword), r.salt);
  }
  save(); s.json(mine(r));
});
app.delete('/api/account', auth, (q, s) => {
  if (!checkPw(q, s)) return;
  const r = q.r;
  for (const f of [r.logo, ...r.items.map(i => i.img)]) if (IMG_RE.test(f || '')) { try { fs.unlinkSync(path.join(DATA, 'img', f)); } catch (e) {} }
  db.restaurants = db.restaurants.filter(x => x !== r);
  save(); s.json({ ok: true });
});

// ---------- Sauvegarde ----------
const imgData = f => { try { return 'data:image/jpeg;base64,' + fs.readFileSync(path.join(DATA, 'img', f)).toString('base64'); } catch (e) { return ''; } };
const storeImg = d => {
  const m = /^data:image\/jpeg;base64,([A-Za-z0-9+/=]+)$/.exec(String(d || ''));
  if (!m) return '';
  const buf = Buffer.from(m[1], 'base64');
  if (!buf.length || buf.length > 600e3) return '';
  const f = crypto.randomBytes(16).toString('hex') + '.jpg';
  fs.writeFileSync(path.join(DATA, 'img', f), buf); return f;
};
app.post('/api/import', auth, jsonBig, (q, s) => {
  const b = q.body || {};
  if (!Array.isArray(b.items) || b.items.length > 300) return s.status(400).json({ error: 'invalid' });
  const r = q.r;
  if (b.cats) r.cats = cleanCats(b.cats);
  const cats = catsOf(r);
  r.items = b.items.map(i => Object.assign(cleanItem(Object.assign({}, i, { img: '' }), cats), { img: storeImg(i.imgData) }));
  if (b.name) r.name = str(b.name, 80);
  if (b.wa !== undefined) r.wa = str(b.wa, 20);
  if (b.ig !== undefined) r.ig = normIg(b.ig);
  if (b.review !== undefined) r.review = normUrl(b.review);
  if (b.color !== undefined) r.color = cleanColor(b.color);
  if (b.addr !== undefined) r.addr = str(b.addr, 160);
  if (b.hours !== undefined) r.hours = cleanHours(b.hours);
  if (b.logoData) r.logo = storeImg(b.logoData) || r.logo;
  save(); s.json(mine(r));
});
app.get('/api/export', auth, (q, s) => {
  const r = q.r;
  const items = r.items.map(i => { const o = Object.assign({}, i); if (i.img) o.imgData = imgData(i.img); return o; });
  s.setHeader('Content-Disposition', 'attachment; filename="seed.json"');
  s.json({ name: r.name, slug: r.slug, wa: r.wa, ig: r.ig || '', review: r.review || '', color: r.color || '', addr: r.addr || '', hours: r.hours || {}, cats: catsOf(r), logoData: r.logo ? imgData(r.logo) : '', items });
});

// ---------- Gestion du menu ----------
app.get('/api/me', auth, (q, s) => s.json(mine(q.r)));
app.put('/api/me', auth, (q, s) => {
  const b = q.body || {}, r = q.r;
  if (b.name) r.name = str(b.name, 80);
  if (b.wa !== undefined) r.wa = str(b.wa, 20);
  if (b.ig !== undefined) r.ig = normIg(b.ig);
  if (b.review !== undefined) r.review = normUrl(b.review);
  if (b.color !== undefined) r.color = cleanColor(b.color);
  if (b.addr !== undefined) r.addr = str(b.addr, 160);
  if (b.hours !== undefined) r.hours = cleanHours(b.hours);
  if (b.logo !== undefined) r.logo = IMG_RE.test(b.logo || '') ? b.logo : '';
  if (b.cats !== undefined) {
    r.cats = cleanCats(b.cats);
    const ids = new Set(r.cats.map(c => c.id));
    for (const i of r.items) if (!ids.has(i.cat)) i.cat = r.cats[0].id;
  }
  save(); s.json(mine(r));
});
app.put('/api/items', auth, (q, s) => {
  const list = Array.isArray(q.body && q.body.items) ? q.body.items.slice(0, 300) : [];
  const cats = catsOf(q.r);
  q.r.items = list.map(i => cleanItem(i, cats));
  save(); s.json(mine(q.r));
});
app.post('/api/photo', auth, (q, s) => {
  const f = storeImg((q.body || {}).data);
  if (!f) return s.status(400).json({ error: 'img' });
  s.json({ img: f });
});

// ---------- Historique : chaque commande (ou ajout) et chaque demande d'addition ----------
// Les prix sont repris du menu du serveur (on ne fait pas confiance au téléphone). Conservation : 180 jours.
app.post('/api/order/:slug', (q, s) => {
  const r = findSlug(q.params.slug);
  if (!r) return s.status(404).json({ error: '404' });
  if (limited('ord:' + q.ip, 120, 3600e3)) return s.status(429).json({ error: 'many' });
  const b = q.body || {}, sid = String(b.sid || '');
  if (!/^[A-Za-z0-9-]{8,40}$/.test(sid)) return s.status(400).json({ error: 'invalid' });
  const ev = { t: Date.now(), sid, table: str(b.table, 20) };
  if (b.bill) { ev.kind = 'bill'; ev.pay = b.bill.pay === 'cb' ? 'cb' : 'cash'; }
  else {
    ev.kind = 'order'; ev.lines = []; ev.note = str(b.note, 200);
    for (const l of Array.isArray(b.lines) ? b.lines.slice(0, 100) : []) {
      const it = r.items.find(i => i.id === l.id), qn = Math.min(50, Math.max(0, parseInt(l.q, 10) || 0));
      if (!it || !qn) continue;
      const sz = (it.sizes || [])[parseInt(l.s, 10)];
      const ex = (Array.isArray(l.e) ? l.e : []).map(k => (it.extras || [])[k]).filter(Boolean);
      const op = (Array.isArray(l.o) ? l.o : []).map(k => (it.opts || [])[k]).filter(Boolean);
      const p = (sz ? sz.p : it.price) + ex.reduce((a, e) => a + e.p, 0);
      ev.lines.push({ id: it.id, fr: it.fr, ar: it.ar, p, q: qn, sz: sz ? sz.n : '', op, ex: ex.map(e => e.n), n: str(l.n, 140) });
    }
    if (!ev.lines.length) return s.status(400).json({ error: 'invalid' });
    ev.total = ev.lines.reduce((a, l) => a + l.p * l.q, 0);
  }
  const old = Date.now() - 180 * 864e5;
  r.orders = (r.orders || []).filter(o => o.t > old);
  r.orders.push(ev); save(); s.json({ ok: true });
});
app.get('/api/orders', auth, (q, s) => {
  const from = Number(q.query.from) || Date.now() - 864e5;
  s.json((q.r.orders || []).filter(o => o.t >= from));
});
app.get('/api/menu/:slug', (q, s) => {
  const r = findSlug(q.params.slug);
  r ? s.json(pub(r)) : s.status(404).json({ error: '404' });
});

app.use('/img', express.static(path.join(DATA, 'img'), { maxAge: '30d' }));
app.use('/photos', express.static(PHOTOS, { maxAge: '1d', setHeaders: (s, f) => { if (/\.jfif$/i.test(f)) s.setHeader('Content-Type', 'image/jpeg'); } }));
app.use(express.static(path.join(__dirname, 'public'), { maxAge: '7d', index: false }));

// ---------- Pages ----------
// Le lien du menu partagé sur WhatsApp affiche le nom du restaurant et son logo (balises Open Graph).
const HTML = fs.readFileSync(path.join(__dirname, 'app.html'), 'utf8');
const h = v => String(v).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
app.get('/r/:slug', (q, s) => {
  const r = findSlug(q.params.slug);
  if (!r) return s.send(HTML);
  const base = baseUrl(q), withImg = r.items.find(i => i.img);
  const img = base + (r.logo ? '/img/' + r.logo : withImg ? '/img/' + withImg.img : '/logo.png');
  const title = r.name + ' · Menu', desc = 'Menu avec photos · Commande sur WhatsApp · FR / EN / عربي' + (r.addr ? ' · ' + r.addr : '');
  const tags = `<title>${h(title)}</title><meta name="description" content="${h(desc)}"><meta property="og:type" content="website"><meta property="og:title" content="${h(title)}"><meta property="og:description" content="${h(desc)}"><meta property="og:image" content="${h(img)}"><meta property="og:url" content="${h(base + '/r/' + r.slug)}"><meta name="twitter:card" content="summary">`;
  s.send(HTML.replace(/<title>[^<]*<\/title>/, tags));
});
app.get(['/', '/admin', '/reset', '/nouveau-mot-de-passe'], (q, s) => s.send(HTML));

(function seedDemo() {
  try {
    const f = path.join(__dirname, 'seed.json');
    const email = (process.env.DEMO_EMAIL || '').trim().toLowerCase(), pw = process.env.DEMO_PASSWORD || '';
    if (!fs.existsSync(f) || !email || pw.length < 6) return;
    const d = JSON.parse(fs.readFileSync(f, 'utf8'));
    if (db.restaurants.some(r => r.slug === d.slug || r.email.toLowerCase() === email)) return;
    const salt = crypto.randomBytes(16).toString('hex'), cats = cleanCats(d.cats);
    db.restaurants.push({ id: crypto.randomUUID(), name: d.name, slug: d.slug, wa: d.wa || '', ig: normIg(d.ig), review: normUrl(d.review), color: cleanColor(d.color), addr: str(d.addr, 160), hours: cleanHours(d.hours), logo: d.logoData ? storeImg(d.logoData) : '', cats, email, salt, pw: hash(pw, salt),
      items: (d.items || []).map(i => Object.assign(cleanItem(Object.assign({}, i, { img: '' }), cats), { img: storeImg(i.imgData) })) });
    save(); console.log('Restaurant de démonstration restauré :', d.slug);
  } catch (e) { console.log('Restauration ignorée :', e.message); }
})();
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('http://localhost:' + PORT));
