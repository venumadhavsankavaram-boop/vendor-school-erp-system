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

// ---------- Render API (deploy history & rollback) ----------
// Optional — only needed for the Deploys panel on a school's row. Create a
// key at Render → Account Settings → API Keys, and set it here as
// RENDER_API_KEY. This is called only to read/trigger deploys for a
// school's own web service; it never has any path to that school's
// database, which lives entirely in Neon and is untouched by this.
const RENDER_API_KEY = process.env.RENDER_API_KEY;
const RENDER_API_BASE = 'https://api.render.com/v1';
async function renderApi(path, opts = {}) {
  if (!RENDER_API_KEY) {
    const err = new Error('RENDER_API_KEY is not set on this dashboard yet — add it under Environment on this service, then redeploy.');
    err.code = 'RENDER_NOT_CONFIGURED';
    throw err;
  }
  const res = await fetch(RENDER_API_BASE + path, {
    ...opts,
    headers: {
      Authorization: `Bearer ${RENDER_API_KEY}`,
      Accept: 'application/json',
      ...(opts.body ? { 'Content-Type': 'application/json' } : {}),
      ...(opts.headers || {}),
    },
  });
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!res.ok) {
    const err = new Error((data && (data.message || data.error)) || `Render API error (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return data;
}

// ---------- Each school's own ERP (public enquiries, read-only) ----------
// A visitor's admission/contact enquiry on a school's public website is
// stored in THAT SCHOOL'S OWN database (admission_inquiries), never here —
// this dashboard has no database of its own for it. This calls that
// school's ERP directly, authenticated with that school's own api_key (the
// same shared secret already used for reporting and Support Login), so
// enquiries are read live and can never drift out of sync with the school's
// own records.
async function schoolErpApi(school, apiPath) {
  if (!school.erp_url) {
    const err = new Error('This school has no ERP URL on file yet — add one from Edit School.');
    err.code = 'ERP_NOT_CONFIGURED';
    throw err;
  }
  const base = String(school.erp_url).replace(/\/+$/, '');
  const res = await fetch(base + apiPath, {
    headers: { 'X-Vendor-Api-Key': school.api_key, Accept: 'application/json' },
  });
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!res.ok) {
    const err = new Error((data && data.error) || `That school's ERP returned an error (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return data;
}

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
      last_heartbeat_meta JSONB,
      billing_plan TEXT,
      billing_amount NUMERIC(12,2),
      billing_cycle TEXT,
      contact_name TEXT,
      contact_email TEXT,
      contact_phone TEXT
    )
  `;
  // Columns added after the original CREATE TABLE above — IF NOT EXISTS
  // keeps this a safe no-op against a database that already has them.
  await sql`ALTER TABLE schools ADD COLUMN IF NOT EXISTS billing_plan TEXT`;
  await sql`ALTER TABLE schools ADD COLUMN IF NOT EXISTS billing_amount NUMERIC(12,2)`;
  await sql`ALTER TABLE schools ADD COLUMN IF NOT EXISTS billing_cycle TEXT`;
  await sql`ALTER TABLE schools ADD COLUMN IF NOT EXISTS contact_name TEXT`;
  await sql`ALTER TABLE schools ADD COLUMN IF NOT EXISTS contact_email TEXT`;
  await sql`ALTER TABLE schools ADD COLUMN IF NOT EXISTS contact_phone TEXT`;
  // The srv-... id of that school's Render web service — lets the dashboard
  // pull deploy history and trigger a rollback via Render's own API. Never
  // used to reach that school's database; deploys and data stay separate.
  await sql`ALTER TABLE schools ADD COLUMN IF NOT EXISTS render_service_id TEXT`;
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
  await sql`
    CREATE TABLE IF NOT EXISTS vendor_invoices (
      id TEXT PRIMARY KEY,
      school_id TEXT NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
      description TEXT,
      amount NUMERIC(12,2) NOT NULL,
      currency TEXT NOT NULL DEFAULT 'INR',
      status TEXT NOT NULL DEFAULT 'pending',
      due_date DATE,
      paid_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      notes TEXT
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS idx_vendor_invoices_school_id ON vendor_invoices (school_id, created_at DESC)`;
  await sql`
    CREATE TABLE IF NOT EXISTS vendor_queries (
      id TEXT PRIMARY KEY,
      school_id TEXT NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
      subject TEXT NOT NULL,
      message TEXT,
      priority TEXT NOT NULL DEFAULT 'normal',
      status TEXT NOT NULL DEFAULT 'open',
      source TEXT NOT NULL DEFAULT 'manual',
      replies JSONB NOT NULL DEFAULT '[]',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      resolved_at TIMESTAMPTZ
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS idx_vendor_queries_school_id ON vendor_queries (school_id, created_at DESC)`;
  // 'support' (a school reporting a problem) vs 'customization' (a school
  // asking for a change) — same table, same status pipeline, just tagged so
  // the Support tab can filter one from the other.
  await sql`ALTER TABLE vendor_queries ADD COLUMN IF NOT EXISTS type TEXT NOT NULL DEFAULT 'support'`;
  await sql`
    CREATE TABLE IF NOT EXISTS vendor_support_logins (
      id TEXT PRIMARY KEY,
      school_id TEXT NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
      admin_id TEXT,
      admin_name TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      expires_at TIMESTAMPTZ NOT NULL
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS idx_vendor_support_logins_school_id ON vendor_support_logins (school_id, created_at DESC)`;
  // Every rollback triggered from here — which deploy, whose commit, who
  // pulled the trigger — kept for the same accountability reason as
  // vendor_support_logins above. This never touches the school's own
  // database; it's a record of a Render API call, nothing more.
  await sql`
    CREATE TABLE IF NOT EXISTS vendor_deploy_actions (
      id TEXT PRIMARY KEY,
      school_id TEXT NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
      action TEXT NOT NULL,
      target_commit TEXT,
      target_message TEXT,
      admin_id TEXT,
      admin_name TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS idx_vendor_deploy_actions_school_id ON vendor_deploy_actions (school_id, created_at DESC)`;
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
  { path: '/api/ingest/query', methods: ['POST'] },
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
  try {
    const rows = await sql`SELECT id, name, username FROM vendor_admins WHERE id = ${req.authAdmin.id}`;
    if (!rows.length) return res.status(401).json({ error: 'Not logged in.' });
    return res.status(200).json(rows[0]);
  } catch (err) {
    console.error('me error:', err);
    return res.status(500).json({ error: 'Something went wrong on the server.' });
  }
});

// Update the signed-in admin's own display name / username.
app.put('/api/account/profile', async (req, res) => {
  if (!req.authAdmin) return res.status(401).json({ error: 'Not logged in.' });
  try {
    const { name, username } = req.body || {};
    if (!username || !String(username).trim()) return res.status(400).json({ error: 'Username is required.' });
    const cleanUsername = String(username).trim();
    const clash = await sql`
      SELECT id FROM vendor_admins WHERE LOWER(username) = LOWER(${cleanUsername}) AND id != ${req.authAdmin.id}
    `;
    if (clash.length) return res.status(409).json({ error: 'That username is already taken.' });
    await sql`
      UPDATE vendor_admins SET name = ${name != null ? String(name).trim() : null}, username = ${cleanUsername}
      WHERE id = ${req.authAdmin.id}
    `;
    // Keep the active session's display name in sync so it shows up immediately.
    const cookies = parseCookies(req);
    if (cookies.vsid) {
      await sql`UPDATE vendor_sessions SET name = ${name != null ? String(name).trim() : null} WHERE id = ${hashSessionToken(cookies.vsid)}`.catch(() => {});
    }
    const rows = await sql`SELECT id, name, username FROM vendor_admins WHERE id = ${req.authAdmin.id}`;
    return res.status(200).json(rows[0]);
  } catch (err) {
    console.error('update profile error:', err);
    return res.status(500).json({ error: 'Something went wrong on the server.' });
  }
});

// Change the signed-in admin's own password. Requires the current password,
// same as any self-service "change my password" screen should (see the
// comment near the ERP's own login route for why this differs from an
// admin resetting someone else's password outright).
app.post('/api/account/change-password', async (req, res) => {
  if (!req.authAdmin) return res.status(401).json({ error: 'Not logged in.' });
  try {
    const { currentPassword, newPassword } = req.body || {};
    if (!currentPassword || !newPassword) return res.status(400).json({ error: 'Current and new password are required.' });
    if (String(newPassword).length < 8) return res.status(400).json({ error: 'New password must be at least 8 characters.' });
    const rows = await sql`SELECT * FROM vendor_admins WHERE id = ${req.authAdmin.id}`;
    if (!rows.length) return res.status(401).json({ error: 'Not logged in.' });
    const admin = rows[0];
    const ok = await bcrypt.compare(String(currentPassword), admin.password || '');
    if (!ok) return res.status(401).json({ error: 'Current password is incorrect.' });
    const hash = await bcrypt.hash(String(newPassword), 10);
    await sql`UPDATE vendor_admins SET password = ${hash} WHERE id = ${req.authAdmin.id}`;
    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('change password error:', err);
    return res.status(500).json({ error: 'Something went wrong on the server.' });
  }
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
    billingPlan: row.billing_plan,
    billingAmount: row.billing_amount != null ? Number(row.billing_amount) : null,
    billingCycle: row.billing_cycle,
    contactName: row.contact_name,
    contactEmail: row.contact_email,
    contactPhone: row.contact_phone,
    renderServiceId: row.render_service_id,
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
    const {
      name, erpUrl, websiteUrl, status, notes, onboardedDate,
      billingPlan, billingAmount, billingCycle, contactName, contactEmail, contactPhone,
      renderServiceId,
    } = req.body || {};
    if (!name || !String(name).trim()) return res.status(400).json({ error: 'School name is required.' });
    const id = 'sch_' + crypto.randomBytes(8).toString('hex');
    const apiKey = crypto.randomBytes(24).toString('base64url');
    await sql`
      INSERT INTO schools (
        id, name, erp_url, website_url, status, notes, api_key, onboarded_date,
        billing_plan, billing_amount, billing_cycle, contact_name, contact_email, contact_phone,
        render_service_id
      )
      VALUES (
        ${id}, ${String(name).trim()}, ${erpUrl || null}, ${websiteUrl || null}, ${status || 'temporary'}, ${notes || null}, ${apiKey}, ${onboardedDate || null},
        ${billingPlan || null}, ${billingAmount != null && billingAmount !== '' ? Number(billingAmount) : null}, ${billingCycle || null},
        ${contactName || null}, ${contactEmail || null}, ${contactPhone || null}, ${renderServiceId ? String(renderServiceId).trim() : null}
      )
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
    const {
      name, erpUrl, websiteUrl, status, notes, onboardedDate,
      billingPlan, billingAmount, billingCycle, contactName, contactEmail, contactPhone,
      renderServiceId,
    } = req.body || {};
    await sql`
      UPDATE schools SET
        name = ${name != null ? String(name).trim() : cur.name},
        erp_url = ${erpUrl != null ? erpUrl : cur.erp_url},
        website_url = ${websiteUrl != null ? websiteUrl : cur.website_url},
        status = ${status != null ? status : cur.status},
        notes = ${notes != null ? notes : cur.notes},
        onboarded_date = ${onboardedDate != null ? onboardedDate : cur.onboarded_date},
        billing_plan = ${billingPlan != null ? billingPlan : cur.billing_plan},
        billing_amount = ${billingAmount != null && billingAmount !== '' ? Number(billingAmount) : (billingAmount === '' ? null : cur.billing_amount)},
        billing_cycle = ${billingCycle != null ? billingCycle : cur.billing_cycle},
        contact_name = ${contactName != null ? contactName : cur.contact_name},
        contact_email = ${contactEmail != null ? contactEmail : cur.contact_email},
        contact_phone = ${contactPhone != null ? contactPhone : cur.contact_phone},
        render_service_id = ${renderServiceId != null ? (String(renderServiceId).trim() || null) : cur.render_service_id}
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
    const openQueryRows = await sql`SELECT COUNT(*)::int AS cnt FROM vendor_queries WHERE status IN ('open', 'in_progress')`;
    return res.status(200).json({
      total, temporary, permanent, online,
      offline: total - online,
      errors24h: errRows[0].cnt,
      openQueries: openQueryRows[0].cnt,
    });
  } catch (err) {
    console.error('summary error:', err);
    return res.status(500).json({ error: 'Something went wrong on the server.' });
  }
});

// A single feed for the Overview tab: the most recent errors, support
// queries, and support-login events across every school, merged and sorted.
// Kept intentionally lightweight (small per-source limits) — this is a
// glanceable "what's happened lately" list, not a full audit log (each
// source's own tab has the complete history).
app.get('/api/activity', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 20, 100);
    const [errors, queries, logins] = await Promise.all([
      sql`
        SELECT se.id, se.message, se.occurred_at AS at, s.id AS school_id, s.name AS school_name
        FROM school_errors se JOIN schools s ON s.id = se.school_id
        ORDER BY se.occurred_at DESC LIMIT ${limit}
      `,
      sql`
        SELECT q.id, q.subject, q.status, q.created_at AS at, s.id AS school_id, s.name AS school_name
        FROM vendor_queries q JOIN schools s ON s.id = q.school_id
        ORDER BY q.created_at DESC LIMIT ${limit}
      `,
      sql`
        SELECT sl.id, sl.admin_name, sl.created_at AS at, s.id AS school_id, s.name AS school_name
        FROM vendor_support_logins sl JOIN schools s ON s.id = sl.school_id
        ORDER BY sl.created_at DESC LIMIT ${limit}
      `,
    ]);
    const items = [
      ...errors.map(r => ({ type: 'error', id: r.id, at: r.at, schoolId: r.school_id, schoolName: r.school_name, text: r.message })),
      ...queries.map(r => ({ type: 'query', id: r.id, at: r.at, schoolId: r.school_id, schoolName: r.school_name, text: r.subject, status: r.status })),
      ...logins.map(r => ({ type: 'support_login', id: r.id, at: r.at, schoolId: r.school_id, schoolName: r.school_name, text: r.admin_name })),
    ].sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime()).slice(0, limit);
    return res.status(200).json(items);
  } catch (err) {
    console.error('activity error:', err);
    return res.status(500).json({ error: 'Something went wrong on the server.' });
  }
});

// ---------- Billing ----------
function shapeInvoice(row) {
  const dueDate = row.due_date ? new Date(row.due_date) : null;
  const isOverdue = row.status === 'pending' && dueDate && dueDate.getTime() < Date.now();
  return {
    id: row.id,
    schoolId: row.school_id,
    description: row.description,
    amount: Number(row.amount),
    currency: row.currency,
    status: row.status,
    effectiveStatus: isOverdue ? 'overdue' : row.status,
    dueDate: row.due_date,
    paidAt: row.paid_at,
    createdAt: row.created_at,
    notes: row.notes,
  };
}

app.get('/api/invoices', async (req, res) => {
  try {
    const { schoolId, status } = req.query || {};
    let rows;
    if (schoolId && status) {
      rows = await sql`SELECT * FROM vendor_invoices WHERE school_id = ${schoolId} AND status = ${status} ORDER BY created_at DESC`;
    } else if (schoolId) {
      rows = await sql`SELECT * FROM vendor_invoices WHERE school_id = ${schoolId} ORDER BY created_at DESC`;
    } else if (status) {
      rows = await sql`SELECT * FROM vendor_invoices WHERE status = ${status} ORDER BY created_at DESC`;
    } else {
      rows = await sql`SELECT * FROM vendor_invoices ORDER BY created_at DESC`;
    }
    return res.status(200).json(rows.map(shapeInvoice));
  } catch (err) {
    console.error('list invoices error:', err);
    return res.status(500).json({ error: 'Something went wrong on the server.' });
  }
});

app.post('/api/invoices', async (req, res) => {
  try {
    const { schoolId, description, amount, currency, status, dueDate, notes } = req.body || {};
    if (!schoolId) return res.status(400).json({ error: 'schoolId is required.' });
    if (amount == null || isNaN(Number(amount)) || Number(amount) <= 0) return res.status(400).json({ error: 'A positive amount is required.' });
    const school = await sql`SELECT id FROM schools WHERE id = ${schoolId}`;
    if (!school.length) return res.status(404).json({ error: 'School not found.' });
    const id = 'inv_' + crypto.randomBytes(8).toString('hex');
    const finalStatus = status || 'pending';
    await sql`
      INSERT INTO vendor_invoices (id, school_id, description, amount, currency, status, due_date, paid_at, notes)
      VALUES (${id}, ${schoolId}, ${description || null}, ${Number(amount)}, ${currency || 'INR'}, ${finalStatus}, ${dueDate || null}, ${finalStatus === 'paid' ? new Date().toISOString() : null}, ${notes || null})
    `;
    const rows = await sql`SELECT * FROM vendor_invoices WHERE id = ${id}`;
    return res.status(201).json(shapeInvoice(rows[0]));
  } catch (err) {
    console.error('create invoice error:', err);
    return res.status(500).json({ error: 'Something went wrong on the server.' });
  }
});

app.put('/api/invoices/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const existing = await sql`SELECT * FROM vendor_invoices WHERE id = ${id}`;
    if (!existing.length) return res.status(404).json({ error: 'Invoice not found.' });
    const cur = existing[0];
    const { description, amount, currency, status, dueDate, notes } = req.body || {};
    const finalStatus = status != null ? status : cur.status;
    // Stamp paid_at the moment an invoice transitions into 'paid'; clear it if
    // it's ever moved back out of 'paid' (e.g. correcting a mistaken mark).
    let paidAt = cur.paid_at;
    if (finalStatus === 'paid' && cur.status !== 'paid') paidAt = new Date().toISOString();
    else if (finalStatus !== 'paid') paidAt = null;
    await sql`
      UPDATE vendor_invoices SET
        description = ${description != null ? description : cur.description},
        amount = ${amount != null && amount !== '' ? Number(amount) : cur.amount},
        currency = ${currency != null ? currency : cur.currency},
        status = ${finalStatus},
        due_date = ${dueDate != null ? dueDate : cur.due_date},
        paid_at = ${paidAt},
        notes = ${notes != null ? notes : cur.notes}
      WHERE id = ${id}
    `;
    const rows = await sql`SELECT * FROM vendor_invoices WHERE id = ${id}`;
    return res.status(200).json(shapeInvoice(rows[0]));
  } catch (err) {
    console.error('update invoice error:', err);
    return res.status(500).json({ error: 'Something went wrong on the server.' });
  }
});

app.delete('/api/invoices/:id', async (req, res) => {
  try {
    await sql`DELETE FROM vendor_invoices WHERE id = ${req.params.id}`;
    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('delete invoice error:', err);
    return res.status(500).json({ error: 'Something went wrong on the server.' });
  }
});

app.get('/api/billing/summary', async (req, res) => {
  try {
    const rows = await sql`SELECT status, amount, due_date, paid_at FROM vendor_invoices`;
    const now = Date.now();
    const startOfMonth = new Date(); startOfMonth.setDate(1); startOfMonth.setHours(0, 0, 0, 0);
    let outstandingTotal = 0, overdueTotal = 0, overdueCount = 0, collectedThisMonth = 0;
    for (const r of rows) {
      const amt = Number(r.amount) || 0;
      if (r.status === 'pending') {
        outstandingTotal += amt;
        if (r.due_date && new Date(r.due_date).getTime() < now) { overdueTotal += amt; overdueCount++; }
      }
      if (r.status === 'paid' && r.paid_at && new Date(r.paid_at).getTime() >= startOfMonth.getTime()) {
        collectedThisMonth += amt;
      }
    }
    return res.status(200).json({
      outstandingTotal, overdueTotal, overdueCount, collectedThisMonth, invoiceCount: rows.length,
    });
  } catch (err) {
    console.error('billing summary error:', err);
    return res.status(500).json({ error: 'Something went wrong on the server.' });
  }
});

// ---------- Support Queries (inquiries FROM schools, or logged by the vendor) ----------
function shapeQuery(row) {
  return {
    id: row.id,
    schoolId: row.school_id,
    subject: row.subject,
    message: row.message,
    priority: row.priority,
    status: row.status,
    type: row.type || 'support',
    source: row.source,
    replies: row.replies || [],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    resolvedAt: row.resolved_at,
  };
}

app.get('/api/queries', async (req, res) => {
  try {
    const { schoolId, status, type } = req.query || {};
    let rows;
    if (schoolId && status) {
      rows = await sql`SELECT * FROM vendor_queries WHERE school_id = ${schoolId} AND status = ${status} ORDER BY created_at DESC`;
    } else if (schoolId) {
      rows = await sql`SELECT * FROM vendor_queries WHERE school_id = ${schoolId} ORDER BY created_at DESC`;
    } else if (status) {
      rows = await sql`SELECT * FROM vendor_queries WHERE status = ${status} ORDER BY created_at DESC`;
    } else {
      rows = await sql`SELECT * FROM vendor_queries ORDER BY created_at DESC`;
    }
    // Filtered in JS rather than added as another SQL branch above — the
    // query volume a single vendor deals with never justifies the extra
    // combinatorial WHERE clauses.
    if (type) rows = rows.filter(r => (r.type || 'support') === type);
    return res.status(200).json(rows.map(shapeQuery));
  } catch (err) {
    console.error('list queries error:', err);
    return res.status(500).json({ error: 'Something went wrong on the server.' });
  }
});

app.post('/api/queries', async (req, res) => {
  try {
    const { schoolId, subject, message, priority, type } = req.body || {};
    if (!schoolId) return res.status(400).json({ error: 'schoolId is required.' });
    if (!subject || !String(subject).trim()) return res.status(400).json({ error: 'Subject is required.' });
    const school = await sql`SELECT id FROM schools WHERE id = ${schoolId}`;
    if (!school.length) return res.status(404).json({ error: 'School not found.' });
    const id = 'qry_' + crypto.randomBytes(8).toString('hex');
    await sql`
      INSERT INTO vendor_queries (id, school_id, subject, message, priority, source, type)
      VALUES (${id}, ${schoolId}, ${String(subject).trim()}, ${message || null}, ${priority || 'normal'}, 'manual', ${type === 'customization' ? 'customization' : 'support'})
    `;
    const rows = await sql`SELECT * FROM vendor_queries WHERE id = ${id}`;
    return res.status(201).json(shapeQuery(rows[0]));
  } catch (err) {
    console.error('create query error:', err);
    return res.status(500).json({ error: 'Something went wrong on the server.' });
  }
});

app.put('/api/queries/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const existing = await sql`SELECT * FROM vendor_queries WHERE id = ${id}`;
    if (!existing.length) return res.status(404).json({ error: 'Query not found.' });
    const cur = existing[0];
    const { status, priority, replyMessage, type } = req.body || {};
    let replies = Array.isArray(cur.replies) ? cur.replies.slice() : [];
    if (replyMessage && String(replyMessage).trim()) {
      replies.push({
        by: (req.authAdmin && req.authAdmin.name) || 'Vendor',
        message: String(replyMessage).trim(),
        at: new Date().toISOString(),
      });
    }
    const finalStatus = status != null ? status : cur.status;
    const resolvedAt = (finalStatus === 'resolved' || finalStatus === 'closed')
      ? (cur.resolved_at || new Date().toISOString())
      : null;
    await sql`
      UPDATE vendor_queries SET
        status = ${finalStatus},
        priority = ${priority != null ? priority : cur.priority},
        type = ${type === 'support' || type === 'customization' ? type : cur.type},
        replies = ${JSON.stringify(replies)},
        updated_at = now(),
        resolved_at = ${resolvedAt}
      WHERE id = ${id}
    `;
    const rows = await sql`SELECT * FROM vendor_queries WHERE id = ${id}`;
    return res.status(200).json(shapeQuery(rows[0]));
  } catch (err) {
    console.error('update query error:', err);
    return res.status(500).json({ error: 'Something went wrong on the server.' });
  }
});

app.delete('/api/queries/:id', async (req, res) => {
  try {
    await sql`DELETE FROM vendor_queries WHERE id = ${req.params.id}`;
    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('delete query error:', err);
    return res.status(500).json({ error: 'Something went wrong on the server.' });
  }
});

// A school's own ERP can optionally submit an inquiry the same opt-in way it
// sends heartbeats/errors — see reporting-client/vendor-reporting.js's
// reportVendorQuery(). Authenticates with that school's schoolId+apiKey, the
// same narrow credential the other ingest routes use.
app.post('/api/ingest/query', async (req, res) => {
  try {
    const school = await authenticateSchool(req, res);
    if (!school) return;
    const { subject, message, priority } = req.body || {};
    if (!subject || !String(subject).trim()) return res.status(400).json({ error: 'subject is required.' });
    const id = 'qry_' + crypto.randomBytes(8).toString('hex');
    await sql`
      INSERT INTO vendor_queries (id, school_id, subject, message, priority, source)
      VALUES (${id}, ${school.id}, ${String(subject).trim().slice(0, 300)}, ${String(message || '').slice(0, 4000)}, ${priority || 'normal'}, 'api')
    `;
    return res.status(201).json({ ok: true });
  } catch (err) {
    console.error('query ingest error:', err);
    return res.status(500).json({ error: 'Something went wrong on the server.' });
  }
});

// ---------- Support Login (troubleshooting access into a school's ERP) ----------
// Issues a short-lived, signed token the vendor can use to open a school's
// ERP with a temporary support session — for troubleshooting, without ever
// needing that school's own admin password. The token is verified on the
// ERP side by the companion reporting-client/vendor-support-login.js
// snippet (opt-in per school, same as the reporting client). Every issuance
// is written to vendor_support_logins as an audit trail, since this is a
// meaningfully sensitive capability.
const SUPPORT_LOGIN_TTL_MS = 10 * 60 * 1000; // 10 minutes

function signSupportLoginToken(payload, secret) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', secret).update(body).digest('base64url');
  return `${body}.${sig}`;
}

app.post('/api/schools/:id/support-login', async (req, res) => {
  if (!req.authAdmin) return res.status(401).json({ error: 'Not logged in.' });
  try {
    const rows = await sql`SELECT * FROM schools WHERE id = ${req.params.id}`;
    if (!rows.length) return res.status(404).json({ error: 'School not found.' });
    const school = rows[0];
    if (!school.erp_url) return res.status(400).json({ error: 'This school has no ERP URL on file yet — add one from Edit School first.' });
    const now = Date.now();
    const payload = {
      schoolId: school.id,
      adminId: req.authAdmin.id,
      adminName: req.authAdmin.name,
      iat: now,
      exp: now + SUPPORT_LOGIN_TTL_MS,
    };
    const token = signSupportLoginToken(payload, school.api_key);
    const auditId = 'spl_' + crypto.randomBytes(8).toString('hex');
    await sql`
      INSERT INTO vendor_support_logins (id, school_id, admin_id, admin_name, expires_at)
      VALUES (${auditId}, ${school.id}, ${req.authAdmin.id}, ${req.authAdmin.name}, ${new Date(payload.exp).toISOString()})
    `;
    const base = String(school.erp_url).replace(/\/$/, '');
    const url = `${base}/api/vendor-support-login?token=${encodeURIComponent(token)}`;
    return res.status(200).json({ url, expiresAt: new Date(payload.exp).toISOString() });
  } catch (err) {
    console.error('support login error:', err);
    return res.status(500).json({ error: 'Something went wrong on the server.' });
  }
});

// ---------- Deploy history & one-click rollback ----------
// The safety net for a customization: see what's actually running on a
// school's ERP or website, and undo the last deploy in one click if it
// breaks something — entirely through Render's own API, so it can never
// touch that school's database.
app.get('/api/schools/:id/deploys', async (req, res) => {
  try {
    const rows = await sql`SELECT * FROM schools WHERE id = ${req.params.id}`;
    if (!rows.length) return res.status(404).json({ error: 'School not found.' });
    const school = rows[0];
    if (!school.render_service_id) {
      return res.status(400).json({ error: "This school has no Render Service ID on file yet — add one from Edit School (it's the srv-... id in that service's own Render dashboard URL)." });
    }
    const list = await renderApi(`/services/${encodeURIComponent(school.render_service_id)}/deploys?limit=15`);
    const deploys = (Array.isArray(list) ? list : []).map(d => {
      const deploy = (d && d.deploy) || d || {};
      return {
        id: deploy.id,
        status: deploy.status,
        trigger: deploy.trigger,
        commitId: deploy.commit && deploy.commit.id,
        commitMessage: deploy.commit && deploy.commit.message,
        createdAt: deploy.createdAt,
        finishedAt: deploy.finishedAt,
      };
    });
    return res.status(200).json(deploys);
  } catch (err) {
    console.error('list deploys error:', err);
    if (err.code === 'RENDER_NOT_CONFIGURED') return res.status(400).json({ error: err.message });
    return res.status(502).json({ error: 'Could not reach Render — ' + err.message });
  }
});

app.post('/api/schools/:id/deploys/:deployId/rollback', async (req, res) => {
  try {
    const rows = await sql`SELECT * FROM schools WHERE id = ${req.params.id}`;
    if (!rows.length) return res.status(404).json({ error: 'School not found.' });
    const school = rows[0];
    if (!school.render_service_id) {
      return res.status(400).json({ error: 'This school has no Render Service ID on file yet — add one from Edit School first.' });
    }
    const targetRaw = await renderApi(`/services/${encodeURIComponent(school.render_service_id)}/deploys/${encodeURIComponent(req.params.deployId)}`);
    const target = (targetRaw && targetRaw.deploy) || targetRaw || {};
    const commitId = target.commit && target.commit.id;
    if (!commitId) return res.status(400).json({ error: 'Could not find a commit on that deploy to roll back to.' });
    const createdRaw = await renderApi(`/services/${encodeURIComponent(school.render_service_id)}/deploys`, {
      method: 'POST',
      body: JSON.stringify({ commitId }),
    });
    const created = (createdRaw && createdRaw.deploy) || createdRaw || {};
    const auditId = 'dpa_' + crypto.randomBytes(8).toString('hex');
    await sql`
      INSERT INTO vendor_deploy_actions (id, school_id, action, target_commit, target_message, admin_id, admin_name)
      VALUES (${auditId}, ${school.id}, 'rollback', ${commitId}, ${(target.commit && target.commit.message) || null}, ${req.authAdmin.id}, ${req.authAdmin.name})
    `;
    return res.status(200).json({ ok: true, newDeploy: created });
  } catch (err) {
    console.error('rollback error:', err);
    if (err.code === 'RENDER_NOT_CONFIGURED') return res.status(400).json({ error: err.message });
    return res.status(502).json({ error: "Render couldn't start that rollback (" + err.message + ") — you can always redeploy that same commit from that service's own page on Render instead." });
  }
});

// ---------- Public enquiries (from a school's own website) ----------
// Read-only, live view of a school's admission_inquiries — nothing is
// copied or cached here, so a school's own ERP is always the single source
// of truth. ?date=YYYY-MM-DD filters to enquiries submitted on that date;
// omit it to see everything (most recent first).
app.get('/api/schools/:id/inquiries', async (req, res) => {
  try {
    const rows = await sql`SELECT * FROM schools WHERE id = ${req.params.id}`;
    if (!rows.length) return res.status(404).json({ error: 'School not found.' });
    const school = rows[0];
    const list = await schoolErpApi(school, '/api/vendor/admission-inquiries');
    let inquiries = Array.isArray(list) ? list : [];
    const date = req.query.date;
    if (date) inquiries = inquiries.filter(q => q.submittedDate === date);
    return res.status(200).json(inquiries);
  } catch (err) {
    console.error('list inquiries error:', err);
    if (err.code === 'ERP_NOT_CONFIGURED') return res.status(400).json({ error: err.message });
    if (err.status === 401) return res.status(400).json({ error: "This school's ERP rejected the vendor key — its VENDOR_API_KEY env var may not match this school's API key yet." });
    if (err.status === 404) return res.status(400).json({ error: "This school's ERP doesn't support enquiry sharing yet — it needs the small update that adds the /api/vendor/admission-inquiries route, then a redeploy." });
    return res.status(502).json({ error: "Could not reach this school's ERP — " + err.message });
  }
});

// ---------- Pre-deploy safety guardrail ----------
// Paste a diff or migration snippet before you push it — a plain text scan
// for SQL patterns that could destroy a school's existing data. Reads only
// the text you paste; it never opens a connection to any school's database.
const GUARDRAIL_PATTERNS = [
  { severity: 'critical', re: /\bDROP\s+(TABLE|COLUMN|DATABASE|SCHEMA)\b/i, note: 'DROP permanently deletes a table, column, database or schema — and everything in it.' },
  { severity: 'critical', re: /\bTRUNCATE\b/i, note: 'TRUNCATE wipes every row in a table.' },
  { severity: 'critical', re: /\bDELETE\s+FROM\s+\w+\s*(;|$)/im, note: 'DELETE FROM with no WHERE clause removes every row in the table.' },
  { severity: 'warning', re: /\bALTER\s+TABLE\b[^;]*\bALTER\s+COLUMN\b[^;]*\bTYPE\b/i, note: "Changing a column's type can silently truncate or reject existing values." },
  { severity: 'warning', re: /\bRENAME\s+(COLUMN|TABLE)\b/i, note: 'Renaming breaks any code that still refers to the old name — check every reference first.' },
  { severity: 'warning', re: /\bDROP\s+NOT\s+NULL\b|\bSET\s+NOT\s+NULL\b/i, note: 'Changing a NOT NULL constraint can reject existing rows or silently allow gaps.' },
];
app.post('/api/deploy-guardrail/scan', async (req, res) => {
  try {
    const text = String((req.body && req.body.text) || '');
    const lines = text.split('\n');
    const findings = [];
    lines.forEach((line, i) => {
      GUARDRAIL_PATTERNS.forEach(p => {
        if (p.re.test(line)) findings.push({ severity: p.severity, line: i + 1, snippet: line.trim().slice(0, 200), note: p.note });
      });
    });
    const safe = !findings.some(f => f.severity === 'critical');
    return res.status(200).json({ safe, findings });
  } catch (err) {
    console.error('guardrail scan error:', err);
    return res.status(500).json({ error: 'Something went wrong on the server.' });
  }
});

app.get('/api/support-logins', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 30, 200);
    const rows = await sql`
      SELECT sl.*, s.name AS school_name FROM vendor_support_logins sl
      JOIN schools s ON s.id = sl.school_id
      ORDER BY sl.created_at DESC LIMIT ${limit}
    `;
    return res.status(200).json(rows.map(r => ({
      id: r.id, schoolId: r.school_id, schoolName: r.school_name,
      adminName: r.admin_name, createdAt: r.created_at, expiresAt: r.expires_at,
    })));
  } catch (err) {
    console.error('list support logins error:', err);
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
