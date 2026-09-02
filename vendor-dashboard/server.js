// Vendor-School-ERP System — a separate service from any individual school's
// ERP. This is where YOU (the software vendor) log in to see every school
// you've onboarded: how many, which are still temporary/trial deployments
// vs. permanent, which are currently online, and what errors they've been
// reporting. It has its own database, its own login, and does not talk to
// any school's data beyond the heartbeat/error reports schools choose to
// send it (see the reporting client snippet in README.md).
//
// Auth follows the exact same tested pattern as the ERP's own session auth
// (httpOnly cookie, hashed session tokens, sliding expiry, bcrypt
// passwords, login rate-limiting) — copied deliberately rather than
// reinvented, since that pattern was already hardened and verified there.

import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import { neon } from '@neondatabase/serverless';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json({ limit: '2mb' }));

const sql = neon(process.env.DATABASE_URL);

// ---------- Schema ----------
async function ensureSchema() {
  await sql`
    CREATE TABLE IF NOT EXISTS vendor_admins (
      id TEXT PRIMARY KEY,
      name TEXT,
      username TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS vendor_sessions (
      id TEXT PRIMARY KEY,
      admin_id TEXT,
      name TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      expires_at TIMESTAMPTZ NOT NULL
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS idx_vendor_sessions_expires_at ON vendor_sessions (expires_at)`;
  await sql`
    CREATE TABLE IF NOT EXISTS schools (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      erp_url TEXT,
      website_url TEXT,
      status TEXT NOT NULL DEFAULT 'temporary',
      notes TEXT,
      api_key TEXT NOT NULL,
      onboarded_date DATE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      last_heartbeat_at TIMESTAMPTZ,
      last_heartbeat_meta JSONB
    )
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS school_errors (
      id TEXT PRIMARY KEY,
      school_id TEXT NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
      message TEXT,
      stack TEXT,
      meta JSONB,
      occurred_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS idx_school_errors_school_id ON school_errors (school_id, occurred_at DESC)`;
}
await ensureSchema();

async function seedDefaultAdminIfEmpty() {
  const rows = await sql`SELECT id FROM vendor_admins LIMIT 1`;
  if (rows.length) return;
  const rawPassword = crypto.randomBytes(9).toString('base64url');
  const hash = await bcrypt.hash(rawPassword, 10);
  await sql`
    INSERT INTO vendor_admins (id, name, username, password)
    VALUES ('va_admin', 'Vendor Admin', 'admin', ${hash})
  `;
  console.log('============================================================');
  console.log('First run: created the default vendor admin account.');
  console.log('  Username: admin');
  console.log(`  Password: ${rawPassword}`);
  console.log('Sign in with this once, then add your own account or change');
  console.log('this password. Printed only this one time — it is not stored');
  console.log('anywhere in plaintext and will not be shown again.');
  console.log('============================================================');
}
await seedDefaultAdminIfEmpty();

// ---------- Session auth (same pattern as the ERP) ----------
function parseCookies(req) {
  const header = req.headers.cookie;
  const cookies = {};
  if (!header) return cookies;
  header.split(';').forEach(pair => {
    const idx = pair.indexOf('=');
    if (idx === -1) return;
    const key = pair.slice(0, idx).trim();
    const val = pair.slice(idx + 1).trim();
    if (key) cookies[key] = decodeURIComponent(val);
  });
  return cookies;
}
function hashSessionToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}
function isHttpsRequest(req) {
  return req.secure || req.headers['x-forwarded-proto'] === 'https';
}

const SESSION_IDLE_MS = 30 * 60 * 1000;
const SESSION_ABSOLUTE_MAX_MS = 12 * 60 * 60 * 1000;

async function createSession(req, res, admin) {
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + SESSION_IDLE_MS);
  await sql`
    INSERT INTO vendor_sessions (id, admin_id, name, expires_at)
    VALUES (${hashSessionToken(token)}, ${admin.id}, ${admin.name}, ${expiresAt.toISOString()})
  `;
  const secureFlag = isHttpsRequest(req) ? '; Secure' : '';
  res.setHeader('Set-Cookie', `vsid=${token}; HttpOnly${secureFlag}; SameSite=Lax; Path=/; Max-Age=${Math.floor(SESSION_ABSOLUTE_MAX_MS / 1000)}`);
}
async function destroySession(req, res) {
  const cookies = parseCookies(req);
  if (cookies.vsid) {
    await sql`DELETE FROM vendor_sessions WHERE id = ${hashSessionToken(cookies.vsid)}`.catch(() => {});
  }
  res.setHeader('Set-Cookie', 'vsid=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0');
}

// Routes that stay open with no vendor login at all: logging in/out, and the
// two ingestion endpoints a SCHOOL's own server calls (those authenticate
// with that school's own api_key, checked inside the handler — a
// fundamentally different, narrower credential than a vendor session, and
// one school's key can never see or touch another school's data).
const PUBLIC_API_ROUTES = [
  { path: '/api/login', methods: ['POST'] },
  { path: '/api/logout', methods: ['POST'] },
  { path: '/api/ingest/heartbeat', methods: ['POST'] },
  { path: '/api/ingest/error', methods: ['POST'] },
];
function isPublicApiRoute(req) {
  return PUBLIC_API_ROUTES.some(r => r.path === req.path && r.methods.includes(req.method));
}

app.use(async (req, res, next) => {
  if (!req.path.startsWith('/api/')) return next();
  if (req.method === 'OPTIONS' || isPublicApiRoute(req)) return next();
  try {
    const token = parseCookies(req).vsid;
    if (!token) return res.status(401).json({ error: 'Not logged in.' });
    const idHash = hashSessionToken(token);
    const rows = await sql`SELECT * FROM vendor_sessions WHERE id = ${idHash}`;
    if (!rows.length) return res.status(401).json({ error: 'Session expired. Please log in again.' });
    const session = rows[0];
    const now = Date.now();
    const createdAt = new Date(session.created_at).getTime();
    if (new Date(session.expires_at).getTime() < now || now - createdAt > SESSION_ABSOLUTE_MAX_MS) {
      await sql`DELETE FROM vendor_sessions WHERE id = ${idHash}`.catch(() => {});
      return res.status(401).json({ error: 'Session expired. Please log in again.' });
    }
    const newExpires = new Date(Math.min(now + SESSION_IDLE_MS, createdAt + SESSION_ABSOLUTE_MAX_MS));
    sql`UPDATE vendor_sessions SET expires_at = ${newExpires.toISOString()}, last_seen_at = now() WHERE id = ${idHash}`.catch(() => {});
    req.authAdmin = { id: session.admin_id, name: session.name };
    next();
  } catch (err) {
    console.error('auth check error:', err);
    return res.status(500).json({ error: 'Something went wrong on the server.' });
  }
});

// ---------- Login rate limiting (same pattern as the ERP) ----------
const LOGIN_MAX_ATTEMPTS = 5;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const loginAttempts = new Map();
function loginRateKey(req, username) {
  const fwd = req.headers['x-forwarded-for'];
  const ip = (fwd ? String(fwd).split(',')[0].trim() : '') || req.socket.remoteAddress || 'unknown';
  return ip + '|' + String(username || '').toLowerCase();
}
function checkLoginRateLimit(key) {
  const rec = loginAttempts.get(key);
  if (!rec) return null;
  if (rec.blockedUntil && Date.now() < rec.blockedUntil) {
    return Math.ceil((rec.blockedUntil - Date.now()) / 1000);
  }
  if (rec.blockedUntil && Date.now() >= rec.blockedUntil) loginAttempts.delete(key);
  return null;
}
function recordLoginFailure(key) {
  const now = Date.now();
  let rec = loginAttempts.get(key);
  if (!rec || now - rec.firstAttempt > LOGIN_WINDOW_MS) rec = { count: 0, firstAttempt: now, blockedUntil: null };
  rec.count++;
  if (rec.count >= LOGIN_MAX_ATTEMPTS) rec.blockedUntil = now + LOGIN_WINDOW_MS;
  loginAttempts.set(key, rec);
}
function recordLoginSuccess(key) { loginAttempts.delete(key); }
setInterval(() => {
  const now = Date.now();
  for (const [key, rec] of loginAttempts) {
    if ((!rec.blockedUntil || now > rec.blockedUntil) && now - rec.firstAttempt > LOGIN_WINDOW_MS) loginAttempts.delete(key);
  }
}, 10 * 60 * 1000).unref();

app.post('/api/login', async (req, res) => {
  try {
    const { username, password } = req.body || {};
    if (!username || !password) return res.status(400).json({ error: 'Username and password are required.' });
    const rateKey = loginRateKey(req, username);
    const blockedForSeconds = checkLoginRateLimit(rateKey);
    if (blockedForSeconds) {
      const mins = Math.ceil(blockedForSeconds / 60);
      return res.status(429).json({ error: `Too many failed attempts. Try again in ${mins} minute${mins === 1 ? '' : 's'}.` });
    }
    const rows = await sql`SELECT * FROM vendor_admins WHERE LOWER(username) = LOWER(${String(username)})`;
    if (!rows.length) { recordLoginFailure(rateKey); return res.status(401).json({ error: 'Invalid username or password.' }); }
    const admin = rows[0];
    const ok = await bcrypt.compare(String(password), admin.password || '');
    if (!ok) { recordLoginFailure(rateKey); return res.status(401).json({ error: 'Invalid username or password.' }); }
    recordLoginSuccess(rateKey);
    await createSession(req, res, admin);
    return res.status(200).json({ id: admin.id, name: admin.name, username: admin.username });
  } catch (err) {
    console.error('login error:', err);
    return res.status(500).json({ error: 'Something went wrong on the server.' });
  }
});

app.post('/api/logout', async (req, res) => {
  try {
    await destroySession(req, res);
    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('logout error:', err);
    return res.status(500).json({ error: 'Something went wrong on the server.' });
  }
});

app.get('/api/me', async (req, res) => {
  if (!req.authAdmin) return res.status(401).json({ error: 'Not logged in.' });
  return res.status(200).json(req.authAdmin);
});

// ---------- Schools registry ----------
const ONLINE_WINDOW_MS = 10 * 60 * 1000; // heartbeat within this window = "online"
const IDLE_WINDOW_MS = 60 * 60 * 1000;   // within this window (but past online) = "idle"

function heartbeatStatus(lastHeartbeatAt) {
  if (!lastHeartbeatAt) return 'never';
  const age = Date.now() - new Date(lastHeartbeatAt).getTime();
  if (age <= ONLINE_WINDOW_MS) return 'online';
  if (age <= IDLE_WINDOW_MS) return 'idle';
  return 'offline';
}

function shapeSchool(row, errorCount24h) {
  return {
    id: row.id,
    name: row.name,
    erpUrl: row.erp_url,
    websiteUrl: row.website_url,
    status: row.status,
    notes: row.notes,
    apiKey: row.api_key,
    onboardedDate: row.onboarded_date,
    createdAt: row.created_at,
    lastHeartbeatAt: row.last_heartbeat_at,
    lastHeartbeatMeta: row.last_heartbeat_meta,
    health: heartbeatStatus(row.last_heartbeat_at),
    errorCount24h: errorCount24h || 0,
  };
}

app.get('/api/schools', async (req, res) => {
  try {
    const schools = await sql`SELECT * FROM schools ORDER BY created_at DESC`;
    const errorCounts = await sql`
      SELECT school_id, COUNT(*)::int AS cnt FROM school_errors
      WHERE occurred_at > now() - interval '24 hours'
      GROUP BY school_id
    `;
    const countMap = Object.fromEntries(errorCounts.map(r => [r.school_id, r.cnt]));
    return res.status(200).json(schools.map(s => shapeSchool(s, countMap[s.id])));
  } catch (err) {
    console.error('list schools error:', err);
    return res.status(500).json({ error: 'Something went wrong on the server.' });
  }
});

app.post('/api/schools', async (req, res) => {
  try {
    const { name, erpUrl, websiteUrl, status, notes, onboardedDate } = req.body || {};
    if (!name || !String(name).trim()) return res.status(400).json({ error: 'School name is required.' });
    const id = 'sch_' + crypto.randomBytes(8).toString('hex');
    const apiKey = crypto.randomBytes(24).toString('base64url');
    await sql`
      INSERT INTO schools (id, name, erp_url, website_url, status, notes, api_key, onboarded_date)
      VALUES (${id}, ${String(name).trim()}, ${erpUrl || null}, ${websiteUrl || null}, ${status || 'temporary'}, ${notes || null}, ${apiKey}, ${onboardedDate || null})
    `;
    const rows = await sql`SELECT * FROM schools WHERE id = ${id}`;
    return res.status(201).json(shapeSchool(rows[0], 0));
  } catch (err) {
    console.error('create school error:', err);
    return res.status(500).json({ error: 'Something went wrong on the server.' });
  }
});

app.put('/api/schools/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const existing = await sql`SELECT * FROM schools WHERE id = ${id}`;
    if (!existing.length) return res.status(404).json({ error: 'School not found.' });
    const cur = existing[0];
    const { name, erpUrl, websiteUrl, status, notes, onboardedDate } = req.body || {};
    await sql`
      UPDATE schools SET
        name = ${name != null ? String(name).trim() : cur.name},
        erp_url = ${erpUrl != null ? erpUrl : cur.erp_url},
        website_url = ${websiteUrl != null ? websiteUrl : cur.website_url},
        status = ${status != null ? status : cur.status},
        notes = ${notes != null ? notes : cur.notes},
        onboarded_date = ${onboardedDate != null ? onboardedDate : cur.onboarded_date}
      WHERE id = ${id}
    `;
    const rows = await sql`SELECT * FROM schools WHERE id = ${id}`;
    const errRows = await sql`SELECT COUNT(*)::int AS cnt FROM school_errors WHERE school_id = ${id} AND occurred_at > now() - interval '24 hours'`;
    return res.status(200).json(shapeSchool(rows[0], errRows[0].cnt));
  } catch (err) {
    console.error('update school error:', err);
    return res.status(500).json({ error: 'Something went wrong on the server.' });
  }
});

app.delete('/api/schools/:id', async (req, res) => {
  try {
    await sql`DELETE FROM schools WHERE id = ${req.params.id}`;
    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('delete school error:', err);
    return res.status(500).json({ error: 'Something went wrong on the server.' });
  }
});

app.post('/api/schools/:id/regenerate-key', async (req, res) => {
  try {
    const apiKey = crypto.randomBytes(24).toString('base64url');
    const rows = await sql`UPDATE schools SET api_key = ${apiKey} WHERE id = ${req.params.id} RETURNING *`;
    if (!rows.length) return res.status(404).json({ error: 'School not found.' });
    return res.status(200).json({ apiKey });
  } catch (err) {
    console.error('regenerate key error:', err);
    return res.status(500).json({ error: 'Something went wrong on the server.' });
  }
});

app.get('/api/schools/:id/errors', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
    const rows = await sql`
      SELECT * FROM school_errors WHERE school_id = ${req.params.id}
      ORDER BY occurred_at DESC LIMIT ${limit}
    `;
    return res.status(200).json(rows.map(r => ({
      id: r.id, message: r.message, stack: r.stack, meta: r.meta, occurredAt: r.occurred_at,
    })));
  } catch (err) {
    console.error('list errors error:', err);
    return res.status(500).json({ error: 'Something went wrong on the server.' });
  }
});

app.get('/api/summary', async (req, res) => {
  try {
    const schools = await sql`SELECT status, last_heartbeat_at FROM schools`;
    const total = schools.length;
    const temporary = schools.filter(s => s.status === 'temporary').length;
    const permanent = schools.filter(s => s.status === 'permanent').length;
    const online = schools.filter(s => heartbeatStatus(s.last_heartbeat_at) === 'online').length;
    const errRows = await sql`SELECT COUNT(*)::int AS cnt FROM school_errors WHERE occurred_at > now() - interval '24 hours'`;
    return res.status(200).json({
      total, temporary, permanent, online,
      offline: total - online,
      errors24h: errRows[0].cnt,
    });
  } catch (err) {
    console.error('summary error:', err);
    return res.status(500).json({ error: 'Something went wrong on the server.' });
  }
});

// ---------- Ingestion (called by each school's own server, not the vendor) ----------
// Each school's reporting client sends its OWN schoolId + apiKey (issued when
// that school was added to the registry above) — this is a completely
// separate credential from the vendor's login, scoped to exactly one row.
async function authenticateSchool(req, res) {
  const { schoolId, apiKey } = req.body || {};
  if (!schoolId || !apiKey) { res.status(400).json({ error: 'schoolId and apiKey are required.' }); return null; }
  const rows = await sql`SELECT * FROM schools WHERE id = ${schoolId}`;
  if (!rows.length || rows[0].api_key !== apiKey) { res.status(401).json({ error: 'Invalid schoolId or apiKey.' }); return null; }
  return rows[0];
}

app.post('/api/ingest/heartbeat', async (req, res) => {
  try {
    const school = await authenticateSchool(req, res);
    if (!school) return;
    const { meta } = req.body || {};
    await sql`
      UPDATE schools SET last_heartbeat_at = now(), last_heartbeat_meta = ${meta ? JSON.stringify(meta) : null}
      WHERE id = ${school.id}
    `;
    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('heartbeat ingest error:', err);
    return res.status(500).json({ error: 'Something went wrong on the server.' });
  }
});

app.post('/api/ingest/error', async (req, res) => {
  try {
    const school = await authenticateSchool(req, res);
    if (!school) return;
    const { message, stack, meta } = req.body || {};
    const id = 'err_' + crypto.randomBytes(8).toString('hex');
    await sql`
      INSERT INTO school_errors (id, school_id, message, stack, meta)
      VALUES (${id}, ${school.id}, ${String(message || '').slice(0, 2000)}, ${String(stack || '').slice(0, 8000)}, ${meta ? JSON.stringify(meta) : null})
    `;
    return res.status(201).json({ ok: true });
  } catch (err) {
    console.error('error ingest error:', err);
    return res.status(500).json({ error: 'Something went wrong on the server.' });
  }
});

// ---------- Serve the dashboard itself ----------
app.use(express.static(path.join(__dirname, 'public')));
app.get(/.*/, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Vendor dashboard running on port ${PORT}`);
});
