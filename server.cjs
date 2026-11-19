const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const db = require('./db-sync.cjs');
const HERE = __dirname;

// Load local secrets without a dependency; .env is ignored by Git.
const ENV_FILE = path.join(HERE, '.env');
if (fs.existsSync(ENV_FILE)) {
  const envContent = fs.readFileSync(ENV_FILE, 'utf8');
  for (const line of envContent.split(/\r?\n/)) {
    const match = line.match(/^([^#=]+)=(.*)$/);
    if (match && !process.env[match[1].trim()]) {
      process.env[match[1].trim()] = match[2].trim();
    }
  }
}

// Fallbacks so you don't need to set env vars every time
if (!process.env.TURSO_DATABASE_URL) process.env.TURSO_DATABASE_URL = 'libsql://dilicioso-bassem63.aws-eu-north-1.turso.io';
if (!process.env.TURSO_AUTH_TOKEN) process.env.TURSO_AUTH_TOKEN = 'eyJhbGciOiJFZERTQSIsInR5cCI6IkpXVCJ9.eyJhIjoicnciLCJpYXQiOjE3OTI3ODg5NzMsImlkIjoiMDFhMTZhOGMtODIwMS03MmVjLWEwYjgtNDljNmMwZTliODljIiwia2lkIjoibjh4S0VMUk5RbFlYM25pNnlvdk5SS1ZxZU5pQ3VBV0Q2X0I3ZVJMLWw1byIsInJpZCI6ImRhYjQyYzRmLTI0OWEtNDc4OS1hMzczLTI2OTY5ZjZmMDE1OSJ9.VwT5_1jNk0WmiMJl7j78xQy1v-JkUSEjEdIIjLub7DyBVptHwhA6Hr-_hGYGJYTyX-iTspLa3g6HKryCsMk8BA';
if (!process.env.PORT) process.env.PORT = '3000';
if (!process.env.ADMIN_PASSWORD) process.env.ADMIN_PASSWORD = 'admin';
if (!process.env.GOOGLE_MAPS_API_KEY) process.env.GOOGLE_MAPS_API_KEY = 'AIzaSyB050WfoRSFHz5C5k0xkPmjNIitExCkmNo';

const PORT = +process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin';
const GOOGLE_MAPS_API_KEY = String(process.env.GOOGLE_MAPS_API_KEY || 'AIzaSyB050WfoRSFHz5C5k0xkPmjNIitExCkmNo').trim();
const FEE = 200, FREE_FROM = 2500;
const PUB = path.join(HERE, 'public');
const UPLOADS = process.env.UPLOAD_DIR || path.join(HERE, 'uploads');
fs.mkdirSync(UPLOADS, { recursive: true });

const FLOW = {
  pending: ['accepted', 'cancelled'], accepted: ['preparing', 'cancelled'],
  preparing: ['ready', 'cancelled'], ready: ['completed', 'out_for_delivery'],
  out_for_delivery: ['completed'], completed: [], cancelled: [],
};
const STATUSES = Object.keys(FLOW);
const MODES = ['delivery', 'pickup'];
const DELIVERY_EXTRA = { min: 15, max: 35 };
const DEFAULT_ALLERGENS = [
  { key: 'gluten', label: 'Gluten' }, { key: 'milk', label: 'Lait' }, { key: 'eggs', label: 'Œufs' },
  { key: 'nuts', label: 'Fruits à coque' }, { key: 'peanuts', label: 'Arachides' }, { key: 'soy', label: 'Soja' },
  { key: 'fish', label: 'Poisson' }, { key: 'shellfish', label: 'Crustacés' }, { key: 'sesame', label: 'Sésame' },
  { key: 'mustard', label: 'Moutarde' }, { key: 'celery', label: 'Céleri' },
];
const DEFAULT_DIETARY = [
  { key: 'vegetarian', label: 'Végétarien' }, { key: 'vegan', label: 'Végétalien' }, { key: 'spicy', label: 'Épicé' },
  { key: 'gluten-free', label: 'Sans gluten' }, { key: 'lactose-free', label: 'Sans lactose' }, { key: 'halal', label: 'Halal' },
];
const WEEKDAYS = [0, 1, 2, 3, 4, 5, 6];
const DAY_NAMES = ['Dimanche', 'Lundi', 'Mardi', 'Mercredi', 'Jeudi', 'Vendredi', 'Samedi'];
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

const CONTACT_PHONE = '213670195819';
const RESV_ZONES = { inside: [2, 4, 8], outside: [4] };
const RESV_DEFAULT_TABLES = { inside: { 2: 4, 4: 5, 8: 2 }, outside: { 4: 3 } };
const RESV_SLOT = 30, RESV_DURATION = 90, RESV_LEAD_DAYS = 60;
const RESV_STATUSES = ['pending', 'phone_required', 'approved', 'rejected', 'cancelled', 'completed'];
const RESV_FLOW = {
  pending: ['approved', 'rejected', 'cancelled'],
  phone_required: ['approved', 'rejected', 'cancelled'],
  approved: ['completed', 'cancelled'],
  rejected: [], cancelled: [], completed: [],
};
const RESV_HOLD = ['pending', 'phone_required', 'approved'];

async function settingsMap() {
  const rows = await db.prepare('SELECT key,value FROM settings').all();
  const list = Array.isArray(rows) ? rows : Array.from(rows);
  return Object.fromEntries(list.map(r => {
    let val = r.value;
    try { val = JSON.parse(val); } catch { /* keep as string */ }
    return [r.key, val];
  }));
}

function isTruthy(v) { return v === true || v === 'true' || v === 1 || v === '1'; }

function normalizeHours(raw) {
  const out = {};
  for (const d of WEEKDAYS) {
    const day = raw && typeof raw === 'object' ? raw[String(d)] : null;
    const ranges = day && Array.isArray(day.ranges)
      ? day.ranges.filter(r => Array.isArray(r) && TIME_RE.test(String(r[0] || '')) && TIME_RE.test(String(r[1] || '')))
      : [];
    out[String(d)] = { closed: !day || !!day.closed || ranges.length === 0, ranges };
  }
  return out;
}

async function serviceStatus() {
  const s = await settingsMap();
  const hours = normalizeHours(s.hours || {});
  const configured = hoursConfigured(hours);
  const now = algeriaNow();
  const today = now.day;
  const todayHours = hours[String(today)] || { closed: true, ranges: [] };
  const isPaused = isTruthy(s['orders-paused']) || isTruthy(s.ordersPaused);
  const pauseMessage = String(s['pause-message'] ?? s.pauseMessage ?? '');

  let isOpenNow = false;
  let nextOpen = null;
  const nowTime = now.time; // HH:MM (Africa/Algiers)
  for (const [start, end] of todayHours.ranges || []) {
    if (nowTime >= start && nowTime < end) { isOpenNow = true; break; }
    if (!nextOpen && nowTime < start) {
      nextOpen = { weekday: DAY_NAMES[today], time: start };
    }
  }
  if (!isOpenNow && !nextOpen) {
    for (let i = 1; i <= 7; i++) {
      const dayIdx = (today + i) % 7;
      const dayHours = hours[String(dayIdx)];
      if (dayHours && !dayHours.closed && dayHours.ranges.length) {
        nextOpen = { weekday: DAY_NAMES[dayIdx], time: dayHours.ranges[0][0] };
        break;
      }
    }
  }

  const accepting = !isPaused && configured && isOpenNow;
  let reason = 'ok';
  if (isPaused) reason = 'paused';
  else if (!configured) reason = 'unavailable';
  else if (!isOpenNow) reason = 'closed';

  return {
    accepting,
    reason,
    paused: isPaused,
    pauseMessage,
    hours,
    hoursConfigured: configured,
    nextOpen,
    delivery: s.delivery || { enabled: true, fee: FEE, freeFrom: FREE_FROM, zones: [], notes: '' },
    pickup: s.pickup || { enabled: true, notes: '' },
    orders: accepting ? 'open' : 'closed',
    reservations: 'open'
  };
}

function optionList(type) {
  return DEFAULT_ALLERGENS.concat(DEFAULT_DIETARY).filter(x => x.key.startsWith(type === 'allergens' ? '' : ''));
}

function withUrl(item) {
  return item;
}

async function getHours() {
  return normalizeHours((await settingsMap()).hours || {});
}

function hoursConfigured(hours) {
  return WEEKDAYS.some(d => {
    const day = hours && hours[String(d)];
    return !!(day && !day.closed && Array.isArray(day.ranges) && day.ranges.length);
  });
}

function algeriaDate() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Africa/Algiers', year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(new Date());
}

function algeriaNow() {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Africa/Algiers', weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false
  }).formatToParts(new Date()).map(p => [p.type, p.value]));
  const day = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[parts.weekday];
  const minutes = (+parts.hour) * 60 + (+parts.minute);
  return { day, minutes, time: String(parts.hour).padStart(2, '0') + ':' + String(parts.minute).padStart(2, '0') };
}

function addDays(dateStr, n) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function minutesOf(t) {
  const [h, m] = String(t).split(':').map(Number);
  return h * 60 + m;
}

function timeOf(mins) {
  return String(Math.floor(mins / 60)).padStart(2, '0') + ':' + String(mins % 60).padStart(2, '0');
}

async function tablesConfig() {
  const s = await settingsMap();
  const t = s.tables;
  if (t && typeof t === 'object') {
    const inv = {};
    for (const [zone, caps] of Object.entries(t)) {
      if (!caps || typeof caps !== 'object') continue;
      inv[zone] = {};
      for (const [cap, n] of Object.entries(caps)) inv[zone][String(cap)] = Math.max(0, +n || 0);
    }
    if (Object.keys(inv).length) return inv;
  }
  return RESV_DEFAULT_TABLES;
}

async function reservationsConfig() {
  const s = await settingsMap();
  const r = s.reservations || {};
  const hours = normalizeHours(s.hours || {});
  return {
    enabled: r.enabled !== false,
    phone: String(r.phone || CONTACT_PHONE),
    leadDays: Math.max(1, Math.min(180, +r.leadDays || RESV_LEAD_DAYS)),
    hours,
    hoursConfigured: hoursConfigured(hours),
    zones: RESV_ZONES,
    inventory: await tablesConfig(),
    today: algeriaDate(),
    timezone: 'Africa/Algiers'
  };
}

/* ---------- sales statistics ---------- */
const SALES_PERIODS = ['daily', 'weekly', 'monthly', 'yearly'];

async function salesSummary(period) {
  if (!SALES_PERIODS.includes(period)) throw new HttpError(400, 'Période invalide.');
  const now = new Date();
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Africa/Algiers', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23'
  }).formatToParts(now).filter(p => p.type !== 'literal').map(p => [p.type, Number(p.value)]));
  const y = parts.year, m = parts.month, d = parts.day;
  let startMs = Date.UTC(y, m - 1, d), count, keys, labels;

  if (period === 'daily') {
    count = 24;
    keys = Array.from({ length: count }, (_, h) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')} ${String(h).padStart(2, '0')}`);
    labels = keys.map((_, h) => `${String(h).padStart(2, '0')}:00`);
  } else if (period === 'weekly') {
    const weekday = new Date(startMs).getUTCDay();
    startMs -= ((weekday + 6) % 7) * 86400000;
    count = 7;
    keys = Array.from({ length: count }, (_, i) => new Date(startMs + i * 86400000).toISOString().slice(0, 10));
    labels = keys.map(k => new Intl.DateTimeFormat('fr-FR', { timeZone: 'Africa/Algiers', weekday: 'short', day: '2-digit' })
      .format(new Date(`${k}T12:00:00Z`)));
  } else if (period === 'monthly') {
    startMs = Date.UTC(y, m - 1, 1);
    count = new Date(Date.UTC(y, m, 0)).getUTCDate();
    keys = Array.from({ length: count }, (_, i) => new Date(startMs + i * 86400000).toISOString().slice(0, 10));
    labels = keys.map(k => k.slice(8, 10));
  } else {
    startMs = Date.UTC(y, 0, 1);
    count = 12;
    keys = Array.from({ length: count }, (_, i) => `${y}-${String(i + 1).padStart(2, '0')}`);
    labels = keys.map((_, i) => new Intl.DateTimeFormat('fr-FR', { timeZone: 'Africa/Algiers', month: 'short' })
      .format(new Date(Date.UTC(y, i, 15, 12))));
  }

  // Algeria is UTC+1 year-round. Convert local calendar bounds to the UTC timestamps stored in SQLite.
  const startUtc = new Date(startMs - 3600000).toISOString().slice(0, 19).replace('T', ' ');
  const endUtc = now.toISOString().slice(0, 19).replace('T', ' ');
  const rows = await db.prepare("SELECT completed_at,total FROM orders WHERE status='completed' AND completed_at IS NOT NULL AND completed_at >= ? AND completed_at <= ?")
    .all(startUtc, endUtc);

  const points = keys.map((key, i) => ({ key, label: labels[i], revenue: 0, orders: 0 }));
  const index = new Map(keys.map((key, i) => [key, i]));
  const dayCount = period === 'yearly'
    ? (Date.UTC(y + 1, 0, 1) - Date.UTC(y, 0, 1)) / 86400000
    : period === 'monthly' ? count : period === 'weekly' ? 7 : 1;
  const days = Array.from({ length: dayCount }, (_, i) => {
    const date = new Date(startMs + i * 86400000).toISOString().slice(0, 10);
    return {
      date,
      label: new Intl.DateTimeFormat('fr-FR', { timeZone: 'Africa/Algiers', weekday: 'short', day: '2-digit', month: 'short' })
        .format(new Date(`${date}T12:00:00Z`)),
      revenue: 0,
      orders: 0
    };
  });
  const dayIndex = new Map(days.map((day, i) => [day.date, i]));

  for (const row of rows) {
    const local = new Date(new Date(`${String(row.completed_at).replace(' ', 'T')}Z`).getTime() + 3600000);
    const day = dayIndex.get(local.toISOString().slice(0, 10));
    if (day !== undefined) { days[day].revenue += row.total; days[day].orders++; }
    const key = period === 'daily'
      ? `${local.getUTCFullYear()}-${String(local.getUTCMonth() + 1).padStart(2, '0')}-${String(local.getUTCDate()).padStart(2, '0')} ${String(local.getUTCHours()).padStart(2, '0')}`
      : period === 'yearly'
        ? `${local.getUTCFullYear()}-${String(local.getUTCMonth() + 1).padStart(2, '0')}`
        : local.toISOString().slice(0, 10);
    const i = index.get(key);
    if (i !== undefined) { points[i].revenue += row.total; points[i].orders++; }
  }

  const revenue = points.reduce((sum, p) => sum + p.revenue, 0);
  const orderCount = points.reduce((sum, p) => sum + p.orders, 0);
  const today = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  return {
    period, today, timeZone: 'Africa/Algiers', currency: 'DA',
    revenue, orders: orderCount,
    averageOrder: orderCount ? Math.round(revenue / orderCount) : 0,
    points, days, startUtc, endUtc
  };
}

async function salesDay(date) {
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new HttpError(400, 'Date invalide.');
  const [year, month, day] = date.split('-').map(Number), startMs = Date.UTC(year, month - 1, day);
  if (new Date(startMs).toISOString().slice(0, 10) !== date) throw new HttpError(400, 'Date invalide.');
  const startUtc = new Date(startMs - 3600000).toISOString().slice(0, 19).replace('T', ' ');
  const endUtc = new Date(startMs + 86400000 - 3600000).toISOString().slice(0, 19).replace('T', ' ');
  const orders = await db.prepare("SELECT code,completed_at,total,items FROM orders WHERE status='completed' AND completed_at IS NOT NULL AND completed_at >= ? AND completed_at < ? ORDER BY completed_at")
    .all(startUtc, endUtc);
  const items = new Map();
  for (const order of orders) {
    let list = [];
    try { list = JSON.parse(order.items || '[]'); } catch { list = []; }
    if (!Array.isArray(list)) list = [];
    for (const item of list) {
      const row = items.get(item.id) || { id: item.id, name: item.name, quantity: 0, revenue: 0 };
      row.quantity += +item.qty || 0;
      row.revenue += (+item.price || 0) * (+item.qty || 0);
      items.set(item.id, row);
    }
  }
  return {
    date,
    orders: orders.length,
    revenue: orders.reduce((sum, order) => sum + order.total, 0),
    items: [...items.values()].sort((a, b) => b.quantity - a.quantity || a.name.localeCompare(b.name, 'fr'))
  };
}

async function insightsSummary(period) {
  const summary = await salesSummary(period);
  const rows = await db.prepare("SELECT items FROM orders WHERE status='completed' AND completed_at IS NOT NULL AND completed_at >= ? AND completed_at <= ?")
    .all(summary.startUtc, summary.endUtc);
  const items = new Map();
  for (const order of rows) {
    let list = [];
    try { list = JSON.parse(order.items || '[]'); } catch { list = []; }
    if (!Array.isArray(list)) list = [];
    for (const item of list) {
      const row = items.get(item.id) || { id: item.id, name: item.name, quantity: 0, revenue: 0 };
      row.quantity += +item.qty || 0;
      row.revenue += (+item.price || 0) * (+item.qty || 0);
      items.set(item.id, row);
    }
  }
  const topItems = [...items.values()].sort((a, b) => b.quantity - a.quantity || a.name.localeCompare(b.name, 'fr')).slice(0, 15);
  const unavailable = await db.prepare('SELECT name,category FROM menu WHERE available=0 ORDER BY name').all();
  return { orders: summary.orders, revenue: summary.revenue, averageOrder: summary.averageOrder, topItems, unavailable };
}

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const send = (res, code, data) => {
  res.writeHead(code, { 
    'Content-Type': 'application/json', 
    'X-Content-Type-Options': 'nosniff',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization'
  });
  res.end(JSON.stringify(data));
};

const body = (req, max = 1e5) => new Promise((ok, no) => {
  let s = '';
  req.on('data', c => {
    s += c;
    if (s.length > max) {
      no(new HttpError(413, 'Requête trop volumineuse.'));
      req.destroy();
    }
  });
  req.on('end', () => {
    try {
      ok(s ? JSON.parse(s) : {});
    } catch {
      no(new HttpError(400, 'Invalid JSON'));
    }
  });
});

const hits = new Map();
const limit = (key, max, ms) => {
  const now = Date.now();
  const arr = hits.get(key) || [];
  const recent = arr.filter(t => now - t < ms);
  if (recent.length >= max) return false;
  recent.push(now);
  hits.set(key, recent);
  return true;
};

function serveFile(file, res, headers = {}) {
  const ext = path.extname(file).toLowerCase();
  const types = {
    '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript',
    '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
    '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf'
  };
  const type = types[ext] || 'application/octet-stream';
  res.writeHead(200, { 'Content-Type': type, ...headers });
  fs.createReadStream(file).pipe(res);
}

function serveStatic(p, res) {
  if (p === '/' || p === '/index.html') p = '/index.html';
  if (p === '/admin') p = '/admin.html';
  const f = path.join(PUB, path.normalize(p));
  if (!f.startsWith(PUB + path.sep) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) {
    throw new HttpError(404, 'Not found');
  }
  // No cache for HTML files to ensure updates are picked up
  const headers = f.endsWith('.html') ? { 'Cache-Control': 'no-cache, no-store, must-revalidate' } : {};
  serveFile(f, res, headers);
}

// Admin password hashing (scrypt)
const hashPw = (pw, salt) => crypto.scryptSync(pw, salt, 64).toString('hex');
const checkPw = (pw, salt, hash) => crypto.timingSafeEqual(Buffer.from(hashPw(pw, salt), 'hex'), Buffer.from(hash, 'hex'));

// Admin session store (token -> expiry)
const adminSessions = new Map();
const adminStreams = new Set();
const resvStreams = new Set();

function broadcastReservation(row) {
  if (!row) return;
  const payload = `event: reservation\ndata: ${JSON.stringify(publicReservation(row))}\n\n`;
  for (const client of resvStreams) {
    if (client.code === row.code && client.phone === row.phone) {
      try { client.res.write(payload); }
      catch { resvStreams.delete(client); }
    }
  }
}

function broadcastAdmin(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of adminStreams) {
    try { res.write(payload); }
    catch { adminStreams.delete(res); }
  }
}

function publicReservation(row) {
  if (!row) return row;
  return { ...row, adminNote: row.admin_note || '' };
}

// Customer account functions
function normPhone(v) {
  let d = String(v ?? '').replace(/[\u0660-\u0669]/g, c => c.charCodeAt(0) - 0x660).replace(/[^\d+]/g, '');
  d = d.replace(/^\+?213/, '0').replace(/\D/g, '');
  if (!/^0\d{8,9}$/.test(d)) throw new HttpError(400, 'Numéro de téléphone invalide.');
  return d;
}
function str(v, max, min = 0) {
  const s = String(v ?? '').trim();
  if (s.length < min || s.length > max) throw new HttpError(400, `Longueur invalide (${min}-${max})`);
  return s;
}

function reservationPhone(url) {
  try { return normPhone(url.searchParams.get('phone')); }
  catch { throw new HttpError(401, 'Numéro de téléphone requis.'); }
}

async function reservationInput(cfg, b, excludeCode = '') {
  const name = str(b.name, 60, 2);
  const phone = normPhone(b.phone);
  const date = String(b.date || '').trim();
  const time = String(b.time || '').trim();
  const party = Math.max(1, +b.party || 1);
  const zone = String(b.zone || '').trim();
  const capacity = Math.max(1, +b.capacity || 2);
  const note = str(b.note ?? '', 200);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new HttpError(400, 'Date invalide.');
  if (!TIME_RE.test(time)) throw new HttpError(400, 'Heure invalide.');
  if (!RESV_ZONES[zone] || !RESV_ZONES[zone].includes(capacity)) throw new HttpError(400, 'Zone ou capacité invalide.');
  if (party > capacity) throw new HttpError(400, 'Le nombre de personnes dépasse la capacité de la table.');
  if (date < cfg.today) throw new HttpError(400, 'La date doit être aujourd’hui ou dans le futur.');
  if (date > addDays(cfg.today, cfg.leadDays)) throw new HttpError(400, 'Cette date est trop éloignée.');
  const day = cfg.hours[String(new Date(date + 'T00:00:00Z').getUTCDay())];
  const start = minutesOf(time);
  const inHours = !!(day && !day.closed && day.ranges.some(([a, z]) => start >= minutesOf(a) && start + RESV_DURATION <= minutesOf(z)));
  if (!cfg.hoursConfigured || !inHours) throw new HttpError(400, 'Ce créneau est en dehors des horaires d’ouverture.');
  if (date === cfg.today) {
    const now = algeriaNow();
    if (start < now.minutes + 30) throw new HttpError(400, 'Horaires trop proches.');
  }
  const sameDay = await db.prepare('SELECT time FROM reservations WHERE date=? AND zone=? AND capacity=? AND status IN (?,?,?) AND code<>?')
    .all(date, zone, capacity, ...RESV_HOLD, excludeCode);
  const used = sameDay.filter(r => minutesOf(r.time) < start + RESV_DURATION && minutesOf(r.time) + RESV_DURATION > start).length;
  const totalTables = +(cfg.inventory[zone]?.[capacity] ?? 0);
  if (used >= totalTables) throw new HttpError(409, 'Ce créneau vient d’être réservé. Choisissez-en un autre.');
  return { name, phone, date, time, zone, capacity, party, note };
}

async function initDB() {
  // Create tables
  await db.exec(`
CREATE TABLE IF NOT EXISTS menu(
  id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, category TEXT NOT NULL,
  price INTEGER NOT NULL, description TEXT NOT NULL DEFAULT '', available INTEGER NOT NULL DEFAULT 1,
  image TEXT NOT NULL DEFAULT '', prep_minutes INTEGER NOT NULL DEFAULT 15,
  portion TEXT NOT NULL DEFAULT '', allergens TEXT NOT NULL DEFAULT '', dietary TEXT NOT NULL DEFAULT '');
CREATE TABLE IF NOT EXISTS item_sizes(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  menu_id INTEGER NOT NULL REFERENCES menu(id) ON DELETE CASCADE,
  size_code TEXT NOT NULL,
  size_label TEXT NOT NULL,
  price INTEGER NOT NULL,
  is_default INTEGER NOT NULL DEFAULT 0,
  sort_order INTEGER NOT NULL DEFAULT 0,
  UNIQUE(menu_id, size_code));
CREATE TABLE IF NOT EXISTS orders(
  id INTEGER PRIMARY KEY AUTOINCREMENT, code TEXT UNIQUE NOT NULL, customer TEXT NOT NULL, phone TEXT NOT NULL,
  mode TEXT NOT NULL, address TEXT NOT NULL DEFAULT '', note TEXT NOT NULL DEFAULT '', items TEXT NOT NULL,
  subtotal INTEGER NOT NULL DEFAULT 0, fee INTEGER NOT NULL DEFAULT 0, zone TEXT NOT NULL DEFAULT '',
  total INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'pending', customer_id INTEGER,
  address_lat REAL, address_lng REAL, eta_min INTEGER, eta_max INTEGER, eta_updated_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')), completed_at TEXT);
CREATE TABLE IF NOT EXISTS customers(
  id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, phone TEXT UNIQUE NOT NULL,
  salt TEXT NOT NULL, hash TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS customer_sessions(token TEXT PRIMARY KEY, customer_id INTEGER NOT NULL, expires INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS admin_credentials(id INTEGER PRIMARY KEY CHECK(id=1), salt TEXT NOT NULL, hash TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS app_meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS reservations(
  id INTEGER PRIMARY KEY AUTOINCREMENT, code TEXT UNIQUE NOT NULL, name TEXT NOT NULL, phone TEXT NOT NULL,
  date TEXT NOT NULL, time TEXT NOT NULL, duration INTEGER NOT NULL DEFAULT 90, zone TEXT NOT NULL,
  capacity INTEGER NOT NULL, party INTEGER NOT NULL, note TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending', admin_note TEXT NOT NULL DEFAULT '', customer_id INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')), edited_at TEXT);
CREATE INDEX IF NOT EXISTS idx_reservations_slot ON reservations(date, zone, capacity, status);`);

  // upgrade databases created by earlier versions
  const hasCol = async (t, c) => {
    try {
      let r = await db.prepare(`PRAGMA table_info(${t})`).all();
      if (r && typeof r.then === 'function') return false;
      return Array.isArray(r) ? r.some(x => x && x.name === c) : false;
    } catch (e) {
      return false;
    }
  };

  if (!await hasCol('menu', 'image')) await db.exec("ALTER TABLE menu ADD COLUMN image TEXT NOT NULL DEFAULT ''");
  if (!await hasCol('menu', 'prep_minutes')) await db.exec('ALTER TABLE menu ADD COLUMN prep_minutes INTEGER NOT NULL DEFAULT 15');
  if (!await hasCol('menu', 'portion')) await db.exec("ALTER TABLE menu ADD COLUMN portion TEXT NOT NULL DEFAULT ''");
  if (!await hasCol('menu', 'allergens')) await db.exec("ALTER TABLE menu ADD COLUMN allergens TEXT NOT NULL DEFAULT ''");
  if (!await hasCol('menu', 'dietary')) await db.exec("ALTER TABLE menu ADD COLUMN dietary TEXT NOT NULL DEFAULT ''");
  if (!await hasCol('orders', 'customer_id')) await db.exec('ALTER TABLE orders ADD COLUMN customer_id INTEGER');
  if (!await hasCol('orders', 'address_lat')) await db.exec('ALTER TABLE orders ADD COLUMN address_lat REAL');
  if (!await hasCol('orders', 'address_lng')) await db.exec('ALTER TABLE orders ADD COLUMN address_lng REAL');
  if (!await hasCol('orders', 'subtotal')) {
    await db.exec('ALTER TABLE orders ADD COLUMN subtotal INTEGER NOT NULL DEFAULT 0');
    await db.exec('UPDATE orders SET subtotal=total WHERE subtotal=0');
  }
  if (!await db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='item_sizes'").get()) {
    await db.exec(`CREATE TABLE item_sizes(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      menu_id INTEGER NOT NULL REFERENCES menu(id) ON DELETE CASCADE,
      size_code TEXT NOT NULL,
      size_label TEXT NOT NULL,
      price INTEGER NOT NULL,
      is_default INTEGER NOT NULL DEFAULT 0,
      sort_order INTEGER NOT NULL DEFAULT 0,
      UNIQUE(menu_id, size_code))`);
  }
  if (!await hasCol('orders', 'fee')) await db.exec('ALTER TABLE orders ADD COLUMN fee INTEGER NOT NULL DEFAULT 0');
  if (!await hasCol('orders', 'zone')) await db.exec("ALTER TABLE orders ADD COLUMN zone TEXT NOT NULL DEFAULT ''");
  if (!await hasCol('orders', 'eta_min')) await db.exec('ALTER TABLE orders ADD COLUMN eta_min INTEGER');
  if (!await hasCol('orders', 'eta_max')) await db.exec('ALTER TABLE orders ADD COLUMN eta_max INTEGER');
  if (!await hasCol('orders', 'eta_updated_at')) await db.exec('ALTER TABLE orders ADD COLUMN eta_updated_at TEXT');
  if (!await hasCol('reservations', 'edited_at')) await db.exec('ALTER TABLE reservations ADD COLUMN edited_at TEXT');
  if (!await hasCol('orders', 'completed_at')) {
    await db.exec('ALTER TABLE orders ADD COLUMN completed_at TEXT');
    await db.exec("UPDATE orders SET completed_at=updated_at WHERE status='completed'");
  }
  await db.prepare('DELETE FROM customer_sessions WHERE expires < ?').run(Date.now());

  const DEMO = ['Cappuccino', 'Gaufre Nutella', 'Crêpe Nutella', 'Panini Poulet', 'Milkshake Fraise'];
  const cur = (await db.prepare('SELECT name FROM menu').all()).map(r => r.name);
  if (cur.length === DEMO.length && cur.every(n => DEMO.includes(n))) await db.exec('DELETE FROM menu');

  if ((await db.prepare('SELECT value FROM app_meta WHERE key=?').get('menu-catalog'))?.value !== 'italian-v1') {
    const seed = JSON.parse(fs.readFileSync(path.join(HERE, 'seed.json'), 'utf8'));
    try { await db.exec('BEGIN'); } catch { try { await db.exec('BEGIN IMMEDIATE'); } catch {} }
    try {
      await db.exec('DELETE FROM menu');
      await db.exec('DELETE FROM item_sizes');
      const ins = db.prepare('INSERT INTO menu(name,category,price,description,prep_minutes,image) VALUES(?,?,?,?,?,?)');
      const insSize = db.prepare('INSERT INTO item_sizes(menu_id,size_code,size_label,price,is_default,sort_order) VALUES(?,?,?,?,?,?)');
      for (const r of seed) {
        const info = await ins.run(r.name, r.category, r.price, r.description || '', r.prepMinutes || 15, r.image || '');
        const menuId = Number(info.lastInsertRowid);
        if (r.category === 'Pizzas') {
          const base = r.price;
          const sizes = [
            { code: 'S', label: 'Petite (25 cm)', price: Math.round(base * 0.8), isDefault: 0, order: 1 },
            { code: 'M', label: 'Moyenne (30 cm)', price: base, isDefault: 1, order: 2 },
            { code: 'L', label: 'Grande (35 cm)', price: Math.round(base * 1.35), isDefault: 0, order: 3 },
            { code: 'XL', label: 'Très grande (40 cm)', price: Math.round(base * 1.65), isDefault: 0, order: 4 },
            { code: 'XXL', label: 'Double XL (45 cm)', price: Math.round(base * 2.0), isDefault: 0, order: 5 }
          ];
          for (const s of sizes) await insSize.run(menuId, s.code, s.label, s.price, s.isDefault, s.order);
        }
      }
      await db.prepare('INSERT OR REPLACE INTO app_meta(key,value) VALUES(?,?)').run('menu-catalog', 'italian-v1');
      await db.exec('COMMIT');
    } catch (e) { await db.exec('ROLLBACK'); throw e; }
  }

  if ((await db.prepare('SELECT value FROM app_meta WHERE key=?').get('menu-photos'))?.value !== 'photos-v1') {
    const seed = JSON.parse(fs.readFileSync(path.join(HERE, 'seed.json'), 'utf8'));
    try { await db.exec('BEGIN'); } catch { try { await db.exec('BEGIN IMMEDIATE'); } catch {} }
    try {
      const update = db.prepare('UPDATE menu SET image=? WHERE name=?');
      for (const r of seed) await update.run(r.image || '', r.name);
      await db.prepare('INSERT OR REPLACE INTO app_meta(key,value) VALUES(?,?)').run('menu-photos', 'photos-v1');
      try { await db.exec('COMMIT'); } catch {}
    } catch (e) { try { await db.exec('ROLLBACK'); } catch {} throw e; }
  }

  // Keep statistics correct for orders completed before completed_at was tracked.
  await db.prepare("UPDATE orders SET completed_at=updated_at WHERE status='completed' AND completed_at IS NULL AND updated_at IS NOT NULL").run();
}

async function handleRequest(req, res) {
  console.log(`${req.method} ${req.url}`, req.headers.origin ? `Origin: ${req.headers.origin}` : '', req.headers['user-agent'] ? `UA: ${req.headers['user-agent'].slice(0,50)}...` : '');
  try {
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;
    const m = req.method;
    const ip = req.socket.remoteAddress;

    if (!p.startsWith('/api/')) return serveStatic(p, res);

    // CORS preflight
    if (m === 'OPTIONS') {
      return send(res, 204, null);
    }

    // public: browsing needs no account
    if (m === 'GET' && p === '/api/config') {
      return send(res, 200, {
        googleMapsApiKey: GOOGLE_MAPS_API_KEY,
        service: await serviceStatus(),
        menuOptions: { allergens: DEFAULT_ALLERGENS, dietary: DEFAULT_DIETARY }
      });
    }

    if (m === 'GET' && p === '/api/menu') {
      const includeUnavailable = url.searchParams.get('includeUnavailable') === '1';
      const rows = includeUnavailable
        ? await db.prepare('SELECT id,name,category,price,description,image,available,prep_minutes,portion,allergens,dietary FROM menu ORDER BY id').all()
        : await db.prepare('SELECT id,name,category,price,description,image,available,prep_minutes,portion,allergens,dietary FROM menu WHERE available=1 ORDER BY id').all();
      const sizesByItem = new Map();
      for (const row of rows) {
        const sizes = await db.prepare('SELECT size_code,size_label,price,is_default,sort_order FROM item_sizes WHERE menu_id=? ORDER BY sort_order,size_code').all(row.id);
        if (sizes.length) sizesByItem.set(row.id, sizes);
      }
      return send(res, 200, rows.map(r => withUrl({ ...r, sizes: sizesByItem.get(r.id) || [] })));
    }

    // Guest checkout: no account required, just a name and a phone number.
    if (m === 'POST' && p === '/api/orders') {
      if (!limit('order:' + (req.socket.remoteAddress || 'x'), 20, 10 * 60 * 1000)) {
        throw new HttpError(429, 'Trop de commandes. Réessayez dans quelques minutes.');
      }
      const svc = await serviceStatus();
      if (!svc.accepting) {
        throw new HttpError(403, svc.reason === 'paused'
          ? 'Le restaurant ne prend plus de commandes pour le moment.'
          : 'Le restaurant est fermé en ce moment. Réessayez pendant nos horaires d’ouverture.');
      }
      const b = await body(req);
      const mode = b.mode === 'pickup' ? 'pickup' : 'delivery';
      const name = str(b.customer ?? b.name, 60, 2);
      const phone = normPhone(b.phone);
      const note = str(b.note ?? '', 200);
      const enteredAddress = mode === 'delivery' ? str(b.address ?? '', 200) : '';
      const lat = b.address_lat ?? b.lat ?? null;
      const lng = b.address_lng ?? b.lng ?? null;
      if (mode === 'delivery' && !enteredAddress && (lat == null || lng == null)) {
        throw new HttpError(400, 'Indiquez une adresse ou confirmez un point sur la carte.');
      }

      const requested = Array.isArray(b.items) ? b.items : [];
      if (!requested.length) throw new HttpError(400, 'Ajoutez au moins un plat.');
      if (requested.length > 60) throw new HttpError(400, 'Trop d’articles dans la commande.');

      // Prices always come from the menu, never from the browser.
      const items = [];
      let subtotal = 0;
      for (const it of requested) {
        const row = await db.prepare('SELECT id,name,price,available FROM menu WHERE id=?').get(+it.id);
        if (!row || !row.available) throw new HttpError(409, 'Un article de votre commande n’est plus disponible.');
        const qty = Math.max(1, Math.min(50, +it.qty || 1));
        let price = row.price;
        let sizeLabel = '';
        const sizeCode = String(it.size_code || '');
        if (sizeCode) {
          const size = await db.prepare('SELECT size_label,price FROM item_sizes WHERE menu_id=? AND size_code=?').get(row.id, sizeCode);
          if (!size) throw new HttpError(400, 'Taille invalide pour ' + row.name + '.');
          price = size.price;
          sizeLabel = size.size_label;
        }
        items.push({
          id: row.id,
          name: row.name,
          price,
          qty,
          request: String(it.request || '').slice(0, 120),
          size_code: sizeCode,
          size_label: sizeLabel
        });
        subtotal += price * qty;
      }

      const s = await settingsMap();
      const d = s.delivery || {};
      const zones = Array.isArray(d.zones) ? d.zones : [];
      const zone = mode === 'delivery' ? str(b.zone ?? '', 80) : '';
      const baseFee = mode === 'delivery' ? (+(zones.find(z => z && z.name === zone)?.fee ?? d.fee ?? FEE) || 0) : 0;
      const freeFrom = +(d.freeFrom ?? FREE_FROM) || 0;
      const fee = mode === 'delivery' && !(freeFrom > 0 && subtotal >= freeFrom) ? baseFee : 0;
      const total = subtotal + fee;
      const code = crypto.randomBytes(3).toString('hex').toUpperCase();

      await db.prepare('INSERT INTO orders(code,customer,phone,mode,address,note,items,subtotal,fee,zone,total,status,address_lat,address_lng) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
        .run(code, name, phone, mode, enteredAddress, note, JSON.stringify(items), subtotal, fee, zone, total, 'pending', lat, lng);

      const created = await db.prepare('SELECT * FROM orders WHERE code=?').get(code);
      broadcastAdmin('new', created);
      return send(res, 201, { code, total, subtotal, fee, items });
    }

    // Public order tracking: order code + the phone used at checkout.
    {
      const t = p.match(/^\/api\/orders\/([A-Z0-9]{6})$/);
      if (m === 'GET' && t) {
        if (!limit('track:' + (req.socket.remoteAddress || 'x'), 40, 10 * 60 * 1000)) {
          throw new HttpError(429, 'Trop de tentatives. Réessayez plus tard.');
        }
        let phone;
        try { phone = normPhone(url.searchParams.get('phone')); }
        catch { throw new HttpError(401, 'Numéro de téléphone requis.'); }
        const o = await db.prepare('SELECT * FROM orders WHERE code=? AND phone=?').get(t[1], phone);
        if (!o) throw new HttpError(404, 'Commande introuvable.');
        try { o.items = JSON.parse(o.items); } catch { o.items = []; }
        return send(res, 200, o);
      }
    }

    // Reservations (public - just a name and a phone number)
    if (m === 'GET' && p === '/api/reservations/config') {
      return send(res, 200, await reservationsConfig());
    }
    if (m === 'GET' && p === '/api/reservations/availability') {
      const date = String(url.searchParams.get('date') || '').trim();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new HttpError(400, 'Date invalide.');
      const cfg = await reservationsConfig();
      if (!cfg.enabled) return send(res, 200, { closed: true, reason: 'disabled', slots: [] });
      if (!cfg.hoursConfigured) return send(res, 200, { closed: true, reason: 'hours', slots: [] });
      if (date < cfg.today || date > addDays(cfg.today, cfg.leadDays)) {
        return send(res, 200, { closed: true, reason: 'range', slots: [] });
      }
      const day = cfg.hours[String(new Date(date + 'T00:00:00Z').getUTCDay())];
      if (!day || day.closed || !day.ranges.length) {
        return send(res, 200, { closed: true, reason: 'closed', slots: [] });
      }

      const holds = await db.prepare('SELECT time,zone,capacity FROM reservations WHERE date=? AND status IN (?,?,?)')
        .all(date, ...RESV_HOLD);
      const minStart = date === cfg.today ? algeriaNow().minutes + 30 : -1;
      const slots = [];
      for (const [start, end] of day.ranges) {
        const close = minutesOf(end);
        for (let at = minutesOf(start); at + RESV_DURATION <= close; at += RESV_SLOT) {
          if (at < minStart) continue;
          const winStart = at, winEnd = at + RESV_DURATION;
          const avail = {};
          for (const [zone, caps] of Object.entries(cfg.zones)) {
            avail[zone] = {};
            for (const cap of caps) {
              const totalTables = +(cfg.inventory[zone]?.[cap] ?? 0);
              const used = holds.filter(r =>
                r.zone === zone && +r.capacity === +cap &&
                minutesOf(r.time) < winEnd && minutesOf(r.time) + RESV_DURATION > winStart
              ).length;
              avail[zone][cap] = Math.max(0, totalTables - used);
            }
          }
          slots.push({ time: timeOf(at), avail });
        }
      }
      return send(res, 200, { closed: false, reason: '', date, slots });
    }
    if (m === 'POST' && p === '/api/reservations') {
      const cfg = await reservationsConfig();
      if (!cfg.enabled) throw new HttpError(400, 'Les réservations en ligne sont indisponibles.');
      const input = await reservationInput(cfg, await body(req));
      const code = crypto.randomBytes(3).toString('hex').toUpperCase();
      const status = input.date === cfg.today ? 'phone_required' : 'pending';
      await db.prepare('INSERT INTO reservations(code,name,phone,date,time,duration,zone,capacity,party,note,status) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
        .run(code, input.name, input.phone, input.date, input.time, RESV_DURATION, input.zone, input.capacity, input.party, input.note, status);
      const row = await db.prepare('SELECT * FROM reservations WHERE code=?').get(code);
      broadcastAdmin('reservation', row);
      return send(res, 201, publicReservation(row));
    }
    {
      const t = p.match(/^\/api\/reservations\/([A-Z0-9]{6})$/);
      if (m === 'GET' && t) {
        const phone = reservationPhone(url);
        const row = await db.prepare('SELECT * FROM reservations WHERE code=? AND phone=?').get(t[1], phone);
        if (!row) throw new HttpError(404, 'Réservation introuvable.');
        return send(res, 200, publicReservation(row));
      }
      if (m === 'PATCH' && t) {
        const b = await body(req);
        const phone = normPhone(b.phone);
        const existing = await db.prepare('SELECT * FROM reservations WHERE code=? AND phone=?').get(t[1], phone);
        if (!existing) throw new HttpError(404, 'Réservation introuvable.');
        if (!RESV_HOLD.includes(existing.status)) throw new HttpError(409, 'Cette réservation ne peut plus être modifiée.');
        const cfg = await reservationsConfig();
        const input = await reservationInput(cfg, b, existing.code);
        const status = input.date === cfg.today ? 'phone_required' : 'pending';
        await db.prepare(`UPDATE reservations SET name=?,phone=?,date=?,time=?,zone=?,capacity=?,party=?,note=?,status=?,edited_at=datetime('now'),updated_at=datetime('now') WHERE id=?`)
          .run(input.name, input.phone, input.date, input.time, input.zone, input.capacity, input.party, input.note, status, existing.id);
        const row = await db.prepare('SELECT * FROM reservations WHERE id=?').get(existing.id);
        broadcastReservation(row);
        broadcastAdmin('reservation', row);
        return send(res, 200, publicReservation(row));
      }
    }
    if (m === 'GET' && p === '/api/reservations/stream') {
      const code = String(url.searchParams.get('code') || '');
      const phone = reservationPhone(url);
      const row = await db.prepare('SELECT 1 FROM reservations WHERE code=? AND phone=?').get(code, phone);
      if (!row) throw new HttpError(404, 'Réservation introuvable.');
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      res.write('retry: 5000\n\n');
      const client = { res, code, phone };
      resvStreams.add(client);
      req.on('close', () => resvStreams.delete(client));
      return;
    }

    // Admin login
    if (m === 'POST' && p === '/api/admin/login') {
      const credential = await db.prepare('SELECT salt,hash FROM admin_credentials WHERE id=1').get();
      const { password } = await body(req);
      const pw = String(password ?? '');
      if (!credential || !checkPw(pw, credential.salt, credential.hash)) {
        throw new HttpError(401, 'Mot de passe incorrect');
      }
      const token = crypto.randomBytes(24).toString('hex');
      adminSessions.set(token, Date.now() + 12 * 3600e3);
      return send(res, 200, { token });
    }

    // Admin auth middleware for /api/admin/*
    if (p.startsWith('/api/admin/')) {
      // Allow login and stream without token (stream uses query param)
      if (p === '/api/admin/login' || p.startsWith('/api/admin/stream')) {
        // these handle auth themselves
      } else {
        const authHeader = req.headers.authorization || '';
        const token = authHeader.replace('Bearer ', '');
        if (!token || !adminSessions.has(token) || adminSessions.get(token) < Date.now()) {
          throw new HttpError(401, 'Unauthorized');
        }
      }
    }

    // Admin live updates stream (EventSource)
    if (m === 'GET' && p === '/api/admin/stream') {
      const url = new URL(req.url, 'http://x');
      const token = url.searchParams.get('token');
      if (!token || !adminSessions.has(token) || adminSessions.get(token) < Date.now()) {
        throw new HttpError(401, 'Unauthorized');
      }
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      res.write('retry: 3000\n\n');
      adminStreams.add(res);
      req.on('close', () => adminStreams.delete(res));
      return;
    }

    // Admin password change
    if (m === 'POST' && p === '/api/admin/password') {
      const credential = await db.prepare('SELECT salt,hash FROM admin_credentials WHERE id=1').get();
      const { currentPassword, newPassword } = await body(req);
      const cp = String(currentPassword ?? '');
      const np = String(newPassword ?? '');
      if (!checkPw(cp, credential.salt, credential.hash)) {
        throw new HttpError(403, 'Le mot de passe actuel est incorrect.');
      }
      if (np.length < 8 || np.length > 100) {
        throw new HttpError(400, 'Le nouveau mot de passe doit contenir entre 8 et 100 caractères.');
      }
      const salt = crypto.randomBytes(16).toString('hex');
      await db.prepare('UPDATE admin_credentials SET salt=?,hash=? WHERE id=1').run(salt, hashPw(np, salt));
      return send(res, 200, { ok: true });
    }

    // Admin dashboard data endpoints
    if (m === 'GET' && p === '/api/admin/sales') {
      const period = url.searchParams.get('period') || 'daily';
      const summary = await salesSummary(period);
      return send(res, 200, summary);
    }
    if (m === 'GET' && p === '/api/admin/sales/day') {
      return send(res, 200, await salesDay(url.searchParams.get('date') || ''));
    }
    if (m === 'GET' && p === '/api/admin/insights') {
      const period = url.searchParams.get('period') || 'daily';
      return send(res, 200, await insightsSummary(period));
    }
    if (m === 'GET' && p === '/api/admin/orders') {
      const rows = await db.prepare('SELECT * FROM orders ORDER BY created_at DESC LIMIT 100').all();
      return send(res, 200, rows);
    }
    if (m === 'GET' && p === '/api/admin/orders/export') {
      const rows = await db.prepare('SELECT * FROM orders ORDER BY created_at DESC').all();
      const header = 'Code,Customer,Phone,Mode,Total,Status,Created\n';
      const csv = rows.map(o => `"${o.code}","${o.customer}","${o.phone}","${o.mode}",${o.total},"${o.status}","${o.created_at}"`).join('\n');
      res.writeHead(200, { 'Content-Type': 'text/csv', 'Content-Disposition': 'attachment; filename="orders.csv"' });
      return res.end(header + csv);
    }
    if (m === 'PATCH' && p.startsWith('/api/admin/orders/')) {
      const id = p.split('/').pop();
      const { status, eta_min, eta_max } = await body(req);
      const updates = [];
      const params = [];
      if (status) {
        updates.push('status=?');
        params.push(status);
        if (status === 'completed') updates.push("completed_at=COALESCE(completed_at, datetime('now'))");
        else updates.push('completed_at=NULL');
      }
      if (eta_min !== undefined) { updates.push('eta_min=?'); params.push(eta_min === '' ? null : +eta_min); }
      if (eta_max !== undefined) { updates.push('eta_max=?'); params.push(eta_max === '' ? null : +eta_max); }
      if (updates.length) {
        updates.push("updated_at=datetime('now')");
        params.push(id);
        await db.prepare('UPDATE orders SET ' + updates.join(',') + ' WHERE id=?').run(...params);
      }
      const updated = await db.prepare('SELECT * FROM orders WHERE id=?').get(id);
      if (updated) broadcastAdmin('update', updated);
      return send(res, 200, updated || { ok: true });
    }

    if (m === 'GET' && p === '/api/admin/reservations') {
      const rows = await db.prepare('SELECT * FROM reservations ORDER BY created_at DESC LIMIT 100').all();
      return send(res, 200, rows);
    }
    if (m === 'PATCH' && p.startsWith('/api/admin/reservations/')) {
      const id = p.split('/').pop();
      const { status, adminNote } = await body(req);
      const updates = [];
      const params = [];
      if (status) { updates.push('status=?'); params.push(status); }
      if (adminNote !== undefined) { updates.push('admin_note=?'); params.push(adminNote); }
      if (updates.length) {
        updates.push("updated_at=datetime('now')");
        params.push(id);
        await db.prepare('UPDATE reservations SET ' + updates.join(',') + ' WHERE id=?').run(...params);
      }
      const row = await db.prepare('SELECT * FROM reservations WHERE id=?').get(id);
      broadcastReservation(row);
      broadcastAdmin('reservation', row);
      return send(res, 200, publicReservation(row) || { ok: true });
    }

    if (m === 'GET' && p === '/api/admin/menu') {
      const rows = await db.prepare('SELECT * FROM menu ORDER BY id').all();
      return send(res, 200, rows);
    }
    if (m === 'POST' && p === '/api/admin/menu') {
      const { name, category, price, description, prep_minutes, image, available } = await body(req);
      const info = await db.prepare('INSERT INTO menu(name,category,price,description,prep_minutes,image,available) VALUES(?,?,?,?,?,?,?)')
        .run(name, category, +price, description || '', +prep_minutes || 15, image || '', available ? 1 : 0);
      return send(res, 201, { id: Number(info.lastInsertRowid) });
    }
    if (m === 'PUT' && p.startsWith('/api/admin/menu/')) {
      const id = p.split('/').pop();
      const { name, category, price, description, prep_minutes, image, available } = await body(req);
      await db.prepare('UPDATE menu SET name=?,category=?,price=?,description=?,prep_minutes=?,image=?,available=? WHERE id=?')
        .run(name, category, +price, description || '', +prep_minutes || 15, image || '', available ? 1 : 0, id);
      const updated = await db.prepare('SELECT * FROM menu WHERE id=?').get(id);
      return send(res, 200, updated);
    }
    if (m === 'DELETE' && p.startsWith('/api/admin/menu/')) {
      const id = p.split('/').pop();
      await db.prepare('DELETE FROM menu WHERE id=?').run(id);
      await db.prepare('DELETE FROM item_sizes WHERE menu_id=?').run(id);
      return send(res, 200, { ok: true });
    }

    if (m === 'GET' && p === '/api/admin/settings') {
      const obj = await settingsMap();
      const tables = obj.tables && typeof obj.tables === 'object' && Object.keys(obj.tables).length
        ? obj.tables
        : RESV_DEFAULT_TABLES;
      const reservations = {
        enabled: obj.reservations?.enabled !== false,
        phone: String(obj.reservations?.phone || CONTACT_PHONE),
        leadDays: Math.max(1, Math.min(180, +obj.reservations?.leadDays || RESV_LEAD_DAYS))
      };
      return send(res, 200, {
        service: { ...obj, tables, reservations },
        allergens: Array.isArray(obj.allergens) && obj.allergens.length ? obj.allergens : DEFAULT_ALLERGENS,
        dietary: Array.isArray(obj.dietary) && obj.dietary.length ? obj.dietary : DEFAULT_DIETARY,
        reservations,
        tables
      });
    }
    if (m === 'PUT' && p === '/api/admin/settings') {
      const data = await body(req);
      for (const [key, value] of Object.entries(data)) {
        const str = (typeof value === 'object' && value !== null) ? JSON.stringify(value) : String(value);
        await db.prepare('INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)').run(key, str);
      }
      return send(res, 200, { ok: true });
    }

    // Add more API endpoints here as needed
    throw new HttpError(404, 'Not found');
  } catch (e) {
    if (!e.status) console.error(e);
    if (!res.headersSent) send(res, e.status || 500, { error: e.status ? e.message : 'Server error' });
  }
}

initDB().then(() => {
  console.log('Database initialized');
  http.createServer(handleRequest).listen(PORT, () =>
    console.log(`Delicioso → http://localhost:${PORT}  (admin: /admin)`)
  );
}).catch(e => {
  console.error('Failed to initialize database:', e);
  process.exit(1);
});