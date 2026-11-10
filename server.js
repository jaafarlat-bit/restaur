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
const pub = r => ({ name: r.name, slug: r.slug, wa: r.wa, items: r.items });
const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '3mb' }));
const auth = (q, s, n) => {
  const r = verify((q.headers.authorization || '').replace('Bearer ', ''));
  if (!r) return s.status(401).json({ error: 'auth' });
  q.r = r; n();
};

app.post('/api/signup', (q, s) => {
  const { name, slug, wa, email, password } = q.body || {};
  const sl = String(slug || '').toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 40);
  if (!name || !sl || !email || String(password || '').length < 6) return s.status(400).json({ error: 'invalid' });
  if (db.restaurants.some(r => r.slug === sl || r.email === email)) return s.status(409).json({ error: 'exists' });
  const salt = crypto.randomBytes(16).toString('hex');
  const r = { id: crypto.randomUUID(), name: String(name).slice(0, 80), slug: sl, wa: String(wa || '').slice(0, 20), email: String(email).slice(0, 120), salt, pw: hash(String(password), salt), items: [] };
  db.restaurants.push(r); save();
  s.json({ token: sign(r.id) });
});
app.post('/api/login', (q, s) => {
  const b = q.body || {};
  const r = db.restaurants.find(x => x.email === b.email);
  if (!r || hash(String(b.password || ''), r.salt) !== r.pw) return s.status(401).json({ error: 'login' });
  s.json({ token: sign(r.id) });
});
app.get('/api/me', auth, (q, s) => s.json(pub(q.r)));
app.put('/api/me', auth, (q, s) => {
  const { name, wa } = q.body || {};
  if (name) q.r.name = String(name).slice(0, 80);
  if (wa !== undefined) q.r.wa = String(wa).slice(0, 20);
  save(); s.json(pub(q.r));
});
app.put('/api/items', auth, (q, s) => {
  const list = Array.isArray(q.body && q.body.items) ? q.body.items.slice(0, 300) : [];
  q.r.items = list.map(i => ({
    id: String(i.id || crypto.randomUUID()).slice(0, 40),
    cat: ['ent', 'pla', 'des', 'boi'].includes(i.cat) ? i.cat : 'pla',
    fr: String(i.fr || '').slice(0, 80), ar: String(i.ar || '').slice(0, 80),
    price: Math.max(0, Number(i.price) || 0), on: i.on !== false,
    img: /^[a-f0-9]{32}\.jpg$/.test(i.img || '') ? i.img : ''
  }));
  save(); s.json(pub(q.r));
});
app.post('/api/photo', auth, (q, s) => {
  const m = /^data:image\/jpeg;base64,(.+)$/.exec((q.body || {}).data || '');
  if (!m) return s.status(400).json({ error: 'img' });
  const buf = Buffer.from(m[1], 'base64');
  if (buf.length > 600e3) return s.status(413).json({ error: 'big' });
  const f = crypto.randomBytes(16).toString('hex') + '.jpg';
  fs.writeFileSync(path.join(DATA, 'img', f), buf);
  s.json({ img: f });
});
app.get('/api/menu/:slug', (q, s) => {
  const r = db.restaurants.find(x => x.slug === q.params.slug);
  r ? s.json(pub(r)) : s.status(404).json({ error: '404' });
});
app.use('/img', express.static(path.join(DATA, 'img'), { maxAge: '30d' }));
app.get(['/', '/admin', '/r/:slug'], (q, s) => s.sendFile(path.join(__dirname, 'app.html')));
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('http://localhost:' + PORT));
