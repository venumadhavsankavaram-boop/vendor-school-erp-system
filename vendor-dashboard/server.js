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
  // Groups a main-branch school with its sub-branches (additional physical
  // campuses) for organizing, billing and reporting in this dashboard only —
  // each branch is still its own fully separate ERP deployment + database,
  // created and onboarded individually like any school. Exactly two levels
  // deep: a school that already has sub-branches of its own can never itself
  // be set as someone else's sub-branch (enforced in the POST/PUT handlers
  // below, not just here).
  await sql`ALTER TABLE schools ADD COLUMN IF NOT EXISTS parent_school_id TEXT REFERENCES schools(id)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_schools_parent_school_id ON schools (parent_school_id)`;
  // What this school is actually paying for — drives the Billing Plan /
  // Billing Amount auto-fill in the Add/Edit School modal, and therefore
  // what "Generate Invoices" bills them, since that reads billing_plan /
  // billing_amount directly. plan_type is one of PLAN_TYPES below (or
  // null if never set); plan_modules is always an array of PLAN_MODULE_KEYS
  // — for the two "all modules" plan types it's implied/informational
  // (every key), for 'erp_selected_modules' it's the actual pick.
  await sql`ALTER TABLE schools ADD COLUMN IF NOT EXISTS plan_type TEXT`;
  await sql`ALTER TABLE schools ADD COLUMN IF NOT EXISTS plan_modules JSONB NOT NULL DEFAULT '[]'`;
  // A manual, vendor-triggered access cutoff for non-payment — never
  // automatic (see suspend/restore routes below). When true, that school's
  // own ERP (via vendor-reporting.js's heartbeat, which now round-trips
  // this flag) blocks every login except Admin, showing access_suspended_reason
  // if set. Nothing here ever touches that school's actual data.
  await sql`ALTER TABLE schools ADD COLUMN IF NOT EXISTS access_suspended BOOLEAN NOT NULL DEFAULT false`;
  await sql`ALTER TABLE schools ADD COLUMN IF NOT EXISTS access_suspended_at TIMESTAMPTZ`;
  await sql`ALTER TABLE schools ADD COLUMN IF NOT EXISTS access_suspended_reason TEXT`;
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
  // Sequential, human-readable invoice numbers (SVM-<year>-<0001>) — always
  // increasing, never reused even if an invoice is later deleted.
  await sql`CREATE SEQUENCE IF NOT EXISTS vendor_invoice_seq START 1`;
  await sql`ALTER TABLE vendor_invoices ADD COLUMN IF NOT EXISTS invoice_number TEXT`;
  await sql`ALTER TABLE vendor_invoices ADD COLUMN IF NOT EXISTS billing_period TEXT`;
  // 'manual' = you added it by hand; 'generated' = created by the "Generate
  // Invoices" action, one per school per billing_period.
  await sql`ALTER TABLE vendor_invoices ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'manual'`;
  // GST is off by default (SVM EdTech isn't registered yet) but every
  // invoice keeps its own gst_rate/gst_amount at the time it was raised, so
  // switching GST on later never rewrites older invoices' totals.
  await sql`ALTER TABLE vendor_invoices ADD COLUMN IF NOT EXISTS gst_applicable BOOLEAN NOT NULL DEFAULT false`;
  await sql`ALTER TABLE vendor_invoices ADD COLUMN IF NOT EXISTS gstin TEXT`;
  await sql`ALTER TABLE vendor_invoices ADD COLUMN IF NOT EXISTS gst_rate NUMERIC(5,2)`;
  await sql`ALTER TABLE vendor_invoices ADD COLUMN IF NOT EXISTS gst_amount NUMERIC(12,2) NOT NULL DEFAULT 0`;
  await sql`ALTER TABLE vendor_invoices ADD COLUMN IF NOT EXISTS total_amount NUMERIC(12,2)`;
  // Backfill total_amount for any invoice created before this column existed
  // (GST wasn't a thing yet, so their total is simply their amount).
  await sql`UPDATE vendor_invoices SET total_amount = amount WHERE total_amount IS NULL`;
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
  // SVM EdTech's own running costs (hosting, domains, tools, etc.) — kept
  // here so the Accounting tab can show a real net cash position, not just
  // what schools owe you.
  await sql`
    CREATE TABLE IF NOT EXISTS vendor_expenses (
      id TEXT PRIMARY KEY,
      description TEXT NOT NULL,
      category TEXT,
      amount NUMERIC(12,2) NOT NULL,
      currency TEXT NOT NULL DEFAULT 'INR',
      expense_date DATE NOT NULL DEFAULT CURRENT_DATE,
      notes TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS idx_vendor_expenses_date ON vendor_expenses (expense_date DESC)`;
  // SVM EdTech's own public-facing business contact details — a single row,
  // edited from Account → Business Contact. This is the source of truth
  // Venu updates; the public marketing site is a separate static page and
  // has to be told about changes separately, it doesn't read this live.
  await sql`
    CREATE TABLE IF NOT EXISTS vendor_settings (
      id TEXT PRIMARY KEY,
      contact_email TEXT,
      contact_phone TEXT,
      contact_whatsapp TEXT,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `;
  // Default Billing Amount the Add/Edit School modal fills in when a school
  // is put on one of the two "all modules" plans (see PLAN_TYPES below).
  // 'erp_selected_modules' has no default here — a custom module mix is
  // priced by hand each time, same as before this feature existed.
  await sql`ALTER TABLE vendor_settings ADD COLUMN IF NOT EXISTS default_price_erp_all_modules NUMERIC(12,2)`;
  await sql`ALTER TABLE vendor_settings ADD COLUMN IF NOT EXISTS default_price_erp_all_modules_website NUMERIC(12,2)`;
}

// A school's plan — what it's actually entitled to — as distinct from its
// billing_plan (free text) / billing_amount (the actual price charged).
// Picking one of these in the UI auto-fills billing_plan/billing_amount as
// a starting point (see PUT/POST /api/schools below have no server-side
// auto-fill — that happens client-side so the vendor sees it before saving
// and can still hand-edit it for a custom deal).
const PLAN_TYPES = ['erp_selected_modules', 'erp_all_modules', 'erp_all_modules_website'];
const PLAN_MODULE_KEYS = ['fees', 'attendance', 'exams', 'transport_library'];
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

// ---------- Business contact settings (Account → Business Contact) ----------
// A single row, id 'default'. This is what SVM EdTech shows as its own
// email/phone/WhatsApp — separate from any school's own contact details.
function shapeSettings(row) {
  return {
    contactEmail: row ? row.contact_email : null,
    contactPhone: row ? row.contact_phone : null,
    contactWhatsapp: row ? row.contact_whatsapp : null,
    defaultPriceErpAllModules: row && row.default_price_erp_all_modules != null ? Number(row.default_price_erp_all_modules) : null,
    defaultPriceErpAllModulesWebsite: row && row.default_price_erp_all_modules_website != null ? Number(row.default_price_erp_all_modules_website) : null,
    updatedAt: row ? row.updated_at : null,
  };
}

app.get('/api/settings', async (req, res) => {
  try {
    const rows = await sql`SELECT * FROM vendor_settings WHERE id = 'default'`;
    return res.status(200).json(shapeSettings(rows[0]));
  } catch (err) {
    console.error('get settings error:', err);
    return res.status(500).json({ error: 'Something went wrong on the server.' });
  }
});

app.put('/api/settings', async (req, res) => {
  try {
    const { contactEmail, contactPhone, contactWhatsapp, defaultPriceErpAllModules, defaultPriceErpAllModulesWebsite } = req.body || {};
    const priceAll = defaultPriceErpAllModules != null && defaultPriceErpAllModules !== '' ? Number(defaultPriceErpAllModules) : null;
    const priceAllWebsite = defaultPriceErpAllModulesWebsite != null && defaultPriceErpAllModulesWebsite !== '' ? Number(defaultPriceErpAllModulesWebsite) : null;
    await sql`
      INSERT INTO vendor_settings (id, contact_email, contact_phone, contact_whatsapp, default_price_erp_all_modules, default_price_erp_all_modules_website, updated_at)
      VALUES ('default', ${contactEmail || null}, ${contactPhone || null}, ${contactWhatsapp || null}, ${priceAll}, ${priceAllWebsite}, now())
      ON CONFLICT (id) DO UPDATE SET
        contact_email = ${contactEmail || null},
        contact_phone = ${contactPhone || null},
        contact_whatsapp = ${contactWhatsapp || null},
        default_price_erp_all_modules = ${priceAll},
        default_price_erp_all_modules_website = ${priceAllWebsite},
        updated_at = now()
    `;
    const rows = await sql`SELECT * FROM vendor_settings WHERE id = 'default'`;
    return res.status(200).json(shapeSettings(rows[0]));
  } catch (err) {
    console.error('update settings error:', err);
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
    parentSchoolId: row.parent_school_id,
    planType: row.plan_type,
    planModules: row.plan_modules || [],
    accessSuspended: !!row.access_suspended,
    accessSuspendedAt: row.access_suspended_at,
    accessSuspendedReason: row.access_suspended_reason,
  };
}

// Shared by POST /api/schools and PUT /api/schools/:id. Returns { planType,
// planModules } (both normalized/validated) or throws a 400-worthy message.
function normalizePlanFields(planType, planModules) {
  const finalPlanType = planType || null;
  if (finalPlanType && !PLAN_TYPES.includes(finalPlanType)) {
    throw new Error('Unrecognized plan type.');
  }
  let finalModules = Array.isArray(planModules) ? planModules.filter(m => PLAN_MODULE_KEYS.includes(m)) : [];
  // "All modules" plans always carry every module key, whatever was sent —
  // there's nothing to individually pick for those two plan types.
  if (finalPlanType === 'erp_all_modules' || finalPlanType === 'erp_all_modules_website') {
    finalModules = [...PLAN_MODULE_KEYS];
  }
  return { planType: finalPlanType, planModules: finalModules };
}

// Shared by POST /api/schools and PUT /api/schools/:id. Returns an error
// string if parentSchoolId isn't a valid choice, otherwise null.
// - the parent must exist
// - a school can't be its own parent
// - exactly two levels deep: the parent can't itself be a sub-branch, and a
//   school that already has sub-branches of its own can't become one
async function validateParentSchoolId(parentSchoolId, selfId) {
  if (!parentSchoolId) return null;
  if (selfId && parentSchoolId === selfId) return "A school can't be its own main branch.";
  const parentRows = await sql`SELECT id, parent_school_id FROM schools WHERE id = ${parentSchoolId}`;
  if (!parentRows.length) return 'Parent school not found.';
  if (parentRows[0].parent_school_id) return "That school is itself a sub-branch — pick its main branch instead.";
  if (selfId) {
    const childRows = await sql`SELECT id FROM schools WHERE parent_school_id = ${selfId} LIMIT 1`;
    if (childRows.length) return "This school already has its own sub-branches, so it can't be made a sub-branch itself.";
  }
  return null;
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
      renderServiceId, parentSchoolId, planType, planModules,
    } = req.body || {};
    if (!name || !String(name).trim()) return res.status(400).json({ error: 'School name is required.' });
    const parentErr = await validateParentSchoolId(parentSchoolId || null, null);
    if (parentErr) return res.status(400).json({ error: parentErr });
    let normalizedPlan;
    try { normalizedPlan = normalizePlanFields(planType, planModules); }
    catch (e) { return res.status(400).json({ error: e.message }); }
    const id = 'sch_' + crypto.randomBytes(8).toString('hex');
    const apiKey = crypto.randomBytes(24).toString('base64url');
    await sql`
      INSERT INTO schools (
        id, name, erp_url, website_url, status, notes, api_key, onboarded_date,
        billing_plan, billing_amount, billing_cycle, contact_name, contact_email, contact_phone,
        render_service_id, parent_school_id, plan_type, plan_modules
      )
      VALUES (
        ${id}, ${String(name).trim()}, ${erpUrl || null}, ${websiteUrl || null}, ${status || 'temporary'}, ${notes || null}, ${apiKey}, ${onboardedDate || null},
        ${billingPlan || null}, ${billingAmount != null && billingAmount !== '' ? Number(billingAmount) : null}, ${billingCycle || null},
        ${contactName || null}, ${contactEmail || null}, ${contactPhone || null}, ${renderServiceId ? String(renderServiceId).trim() : null},
        ${parentSchoolId || null}, ${normalizedPlan.planType}, ${JSON.stringify(normalizedPlan.planModules)}
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
      renderServiceId, parentSchoolId, planType, planModules,
    } = req.body || {};
    // parentSchoolId: undefined means "not sent, leave as-is"; '' or null
    // means "clear it"; anything else is a candidate parent id to validate.
    let nextParentSchoolId = cur.parent_school_id;
    if (parentSchoolId !== undefined) {
      nextParentSchoolId = parentSchoolId || null;
      const parentErr = await validateParentSchoolId(nextParentSchoolId, id);
      if (parentErr) return res.status(400).json({ error: parentErr });
    }
    // planType/planModules: undefined means "not sent, leave as-is"; any
    // other value (including an explicit null/'') re-normalizes both fields
    // together, since planModules only makes sense alongside its planType.
    let nextPlanType = cur.plan_type;
    let nextPlanModules = cur.plan_modules || [];
    if (planType !== undefined || planModules !== undefined) {
      let normalizedPlan;
      try { normalizedPlan = normalizePlanFields(planType !== undefined ? planType : cur.plan_type, planModules !== undefined ? planModules : cur.plan_modules); }
      catch (e) { return res.status(400).json({ error: e.message }); }
      nextPlanType = normalizedPlan.planType;
      nextPlanModules = normalizedPlan.planModules;
    }
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
        render_service_id = ${renderServiceId != null ? (String(renderServiceId).trim() || null) : cur.render_service_id},
        parent_school_id = ${nextParentSchoolId},
        plan_type = ${nextPlanType},
        plan_modules = ${JSON.stringify(nextPlanModules)}
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
    const children = await sql`SELECT id FROM schools WHERE parent_school_id = ${req.params.id} LIMIT 1`;
    if (children.length) {
      return res.status(400).json({ error: 'This school has sub-branches. Delete or reassign them first.' });
    }
    await sql`DELETE FROM schools WHERE id = ${req.params.id}`;
    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('delete school error:', err);
    return res.status(500).json({ error: 'Something went wrong on the server.' });
  }
});

// ---------- Access suspension (manual only — never automatic) ----------
// A deliberate cutoff for non-payment. This never runs on a timer and never
// fires from an invoice going overdue on its own — a vendor admin has to
// click it. That school's own ERP picks this up the next time its
// vendor-reporting.js heartbeat lands (see /api/ingest/heartbeat below) and
// blocks every login except Admin. Nothing here touches that school's data.
app.post('/api/schools/:id/suspend-access', async (req, res) => {
  try {
    const { reason } = req.body || {};
    const rows = await sql`
      UPDATE schools SET access_suspended = true, access_suspended_at = now(), access_suspended_reason = ${reason ? String(reason).trim().slice(0, 500) : null}
      WHERE id = ${req.params.id} RETURNING *
    `;
    if (!rows.length) return res.status(404).json({ error: 'School not found.' });
    return res.status(200).json(shapeSchool(rows[0], 0));
  } catch (err) {
    console.error('suspend access error:', err);
    return res.status(500).json({ error: 'Something went wrong on the server.' });
  }
});

app.post('/api/schools/:id/restore-access', async (req, res) => {
  try {
    const rows = await sql`
      UPDATE schools SET access_suspended = false, access_suspended_at = null, access_suspended_reason = null
      WHERE id = ${req.params.id} RETURNING *
    `;
    if (!rows.length) return res.status(404).json({ error: 'School not found.' });
    return res.status(200).json(shapeSchool(rows[0], 0));
  } catch (err) {
    console.error('restore access error:', err);
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
    invoiceNumber: row.invoice_number,
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
    billingPeriod: row.billing_period,
    source: row.source,
    gstApplicable: !!row.gst_applicable,
    gstin: row.gstin,
    gstRate: row.gst_rate != null ? Number(row.gst_rate) : null,
    gstAmount: Number(row.gst_amount) || 0,
    totalAmount: row.total_amount != null ? Number(row.total_amount) : Number(row.amount),
  };
}

// Next sequential invoice number, e.g. SVM-2026-0001 — shared by manual
// invoices and the generate-invoices action so numbering never collides or
// skips regardless of which path created the invoice.
async function nextInvoiceNumber() {
  const rows = await sql`SELECT nextval('vendor_invoice_seq') AS n`;
  const n = Number(rows[0].n);
  return `SVM-${new Date().getFullYear()}-${String(n).padStart(4, '0')}`;
}

// GST is off by default — SVM EdTech isn't registered yet (see the
// Accounting/Billing UI). When it is switched on for an invoice, this
// computes gst_amount and total_amount from the taxable amount and rate;
// otherwise the total is simply the amount.
function computeInvoiceTotals({ amount, gstApplicable, gstRate }) {
  const base = Number(amount) || 0;
  if (gstApplicable && gstRate != null && !isNaN(Number(gstRate))) {
    const rate = Number(gstRate);
    const gstAmount = Math.round(base * (rate / 100) * 100) / 100;
    return { gstAmount, totalAmount: Math.round((base + gstAmount) * 100) / 100 };
  }
  return { gstAmount: 0, totalAmount: base };
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
    const { schoolId, description, amount, currency, status, dueDate, notes, gstApplicable, gstin, gstRate } = req.body || {};
    if (!schoolId) return res.status(400).json({ error: 'schoolId is required.' });
    if (amount == null || isNaN(Number(amount)) || Number(amount) <= 0) return res.status(400).json({ error: 'A positive amount is required.' });
    const school = await sql`SELECT id FROM schools WHERE id = ${schoolId}`;
    if (!school.length) return res.status(404).json({ error: 'School not found.' });
    const id = 'inv_' + crypto.randomBytes(8).toString('hex');
    const finalStatus = status || 'pending';
    const invoiceNumber = await nextInvoiceNumber();
    const { gstAmount, totalAmount } = computeInvoiceTotals({ amount, gstApplicable, gstRate });
    await sql`
      INSERT INTO vendor_invoices
        (id, invoice_number, school_id, description, amount, currency, status, due_date, paid_at, notes,
         source, gst_applicable, gstin, gst_rate, gst_amount, total_amount)
      VALUES
        (${id}, ${invoiceNumber}, ${schoolId}, ${description || null}, ${Number(amount)}, ${currency || 'INR'}, ${finalStatus},
         ${dueDate || null}, ${finalStatus === 'paid' ? new Date().toISOString() : null}, ${notes || null},
         'manual', ${!!gstApplicable}, ${gstin || null}, ${gstApplicable ? (gstRate != null ? Number(gstRate) : null) : null},
         ${gstAmount}, ${totalAmount})
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
    const { description, amount, currency, status, dueDate, notes, gstApplicable, gstin, gstRate } = req.body || {};
    const finalStatus = status != null ? status : cur.status;
    // Stamp paid_at the moment an invoice transitions into 'paid'; clear it if
    // it's ever moved back out of 'paid' (e.g. correcting a mistaken mark).
    let paidAt = cur.paid_at;
    if (finalStatus === 'paid' && cur.status !== 'paid') paidAt = new Date().toISOString();
    else if (finalStatus !== 'paid') paidAt = null;
    const finalAmount = amount != null && amount !== '' ? Number(amount) : Number(cur.amount);
    const finalGstApplicable = gstApplicable != null ? !!gstApplicable : cur.gst_applicable;
    const finalGstRate = finalGstApplicable ? (gstRate != null ? Number(gstRate) : (cur.gst_rate != null ? Number(cur.gst_rate) : null)) : null;
    const { gstAmount, totalAmount } = computeInvoiceTotals({ amount: finalAmount, gstApplicable: finalGstApplicable, gstRate: finalGstRate });
    await sql`
      UPDATE vendor_invoices SET
        description = ${description != null ? description : cur.description},
        amount = ${finalAmount},
        currency = ${currency != null ? currency : cur.currency},
        status = ${finalStatus},
        due_date = ${dueDate != null ? dueDate : cur.due_date},
        paid_at = ${paidAt},
        notes = ${notes != null ? notes : cur.notes},
        gst_applicable = ${finalGstApplicable},
        gstin = ${gstin != null ? gstin : cur.gstin},
        gst_rate = ${finalGstRate},
        gst_amount = ${gstAmount},
        total_amount = ${totalAmount}
      WHERE id = ${id}
    `;
    const rows = await sql`SELECT * FROM vendor_invoices WHERE id = ${id}`;
    return res.status(200).json(shapeInvoice(rows[0]));
  } catch (err) {
    console.error('update invoice error:', err);
    return res.status(500).json({ error: 'Something went wrong on the server.' });
  }
});

// Creates one invoice per eligible school for a billing period (defaults to
// the current calendar month, "YYYY-MM") — the "Generate Invoices" button.
// Monthly-cycle schools get one every period; annual-cycle schools only get
// one roughly once every 12 months (measured from their last generated
// invoice, or their onboarded date if they've never had one). One-time or
// unset billing cycles are always skipped — those get invoiced by hand.
app.post('/api/invoices/generate', async (req, res) => {
  try {
    const period = (req.body && req.body.period) || new Date().toISOString().slice(0, 7);
    if (!/^\d{4}-\d{2}$/.test(period)) return res.status(400).json({ error: 'period must look like YYYY-MM.' });
    const schools = await sql`SELECT * FROM schools WHERE billing_cycle IN ('monthly', 'annual') AND billing_amount IS NOT NULL AND billing_amount > 0`;
    const created = [];
    const skipped = [];
    for (const school of schools) {
      const already = await sql`SELECT id FROM vendor_invoices WHERE school_id = ${school.id} AND billing_period = ${period} LIMIT 1`;
      if (already.length) { skipped.push({ schoolId: school.id, name: school.name, reason: 'already billed for this period' }); continue; }
      if (school.billing_cycle === 'annual') {
        const last = await sql`SELECT billing_period, created_at FROM vendor_invoices WHERE school_id = ${school.id} AND source = 'generated' ORDER BY created_at DESC LIMIT 1`;
        const anchor = last.length ? new Date(last[0].created_at) : (school.onboarded_date ? new Date(school.onboarded_date) : null);
        if (anchor) {
          const monthsSince = (new Date(period + '-01').getTime() - anchor.getTime()) / (1000 * 60 * 60 * 24 * 30);
          if (monthsSince < 11) { skipped.push({ schoolId: school.id, name: school.name, reason: 'not due yet (annual)' }); continue; }
        }
      }
      const id = 'inv_' + crypto.randomBytes(8).toString('hex');
      const invoiceNumber = await nextInvoiceNumber();
      const amount = Number(school.billing_amount);
      const dueDate = new Date(period + '-01'); dueDate.setDate(dueDate.getDate() + 14);
      const description = `${school.billing_plan ? school.billing_plan + ' — ' : ''}${school.billing_cycle === 'annual' ? 'Annual' : 'Monthly'} billing for ${period}`;
      await sql`
        INSERT INTO vendor_invoices
          (id, invoice_number, school_id, description, amount, currency, status, due_date, notes, source, billing_period, gst_amount, total_amount)
        VALUES
          (${id}, ${invoiceNumber}, ${school.id}, ${description}, ${amount}, 'INR', 'pending', ${dueDate.toISOString().slice(0,10)}, null, 'generated', ${period}, 0, ${amount})
      `;
      created.push({ schoolId: school.id, name: school.name, invoiceNumber, amount });
    }
    return res.status(201).json({ period, created, skipped });
  } catch (err) {
    console.error('generate invoices error:', err);
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

// ---------- Expenses (SVM EdTech's own running costs) ----------
function shapeExpense(row) {
  return {
    id: row.id,
    description: row.description,
    category: row.category,
    amount: Number(row.amount),
    currency: row.currency,
    expenseDate: row.expense_date,
    notes: row.notes,
    createdAt: row.created_at,
  };
}

app.get('/api/expenses', async (req, res) => {
  try {
    const { from, to } = req.query || {};
    let rows;
    if (from && to) {
      rows = await sql`SELECT * FROM vendor_expenses WHERE expense_date >= ${from} AND expense_date <= ${to} ORDER BY expense_date DESC`;
    } else {
      rows = await sql`SELECT * FROM vendor_expenses ORDER BY expense_date DESC`;
    }
    return res.status(200).json(rows.map(shapeExpense));
  } catch (err) {
    console.error('list expenses error:', err);
    return res.status(500).json({ error: 'Something went wrong on the server.' });
  }
});

app.post('/api/expenses', async (req, res) => {
  try {
    const { description, category, amount, currency, expenseDate, notes } = req.body || {};
    if (!description || !String(description).trim()) return res.status(400).json({ error: 'Description is required.' });
    if (amount == null || isNaN(Number(amount)) || Number(amount) <= 0) return res.status(400).json({ error: 'A positive amount is required.' });
    const id = 'exp_' + crypto.randomBytes(8).toString('hex');
    await sql`
      INSERT INTO vendor_expenses (id, description, category, amount, currency, expense_date, notes)
      VALUES (${id}, ${String(description).trim()}, ${category || null}, ${Number(amount)}, ${currency || 'INR'}, ${expenseDate || new Date().toISOString().slice(0,10)}, ${notes || null})
    `;
    const rows = await sql`SELECT * FROM vendor_expenses WHERE id = ${id}`;
    return res.status(201).json(shapeExpense(rows[0]));
  } catch (err) {
    console.error('create expense error:', err);
    return res.status(500).json({ error: 'Something went wrong on the server.' });
  }
});

app.put('/api/expenses/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const existing = await sql`SELECT * FROM vendor_expenses WHERE id = ${id}`;
    if (!existing.length) return res.status(404).json({ error: 'Expense not found.' });
    const cur = existing[0];
    const { description, category, amount, currency, expenseDate, notes } = req.body || {};
    await sql`
      UPDATE vendor_expenses SET
        description = ${description != null && description !== '' ? description : cur.description},
        category = ${category != null ? category : cur.category},
        amount = ${amount != null && amount !== '' ? Number(amount) : cur.amount},
        currency = ${currency != null ? currency : cur.currency},
        expense_date = ${expenseDate != null ? expenseDate : cur.expense_date},
        notes = ${notes != null ? notes : cur.notes}
      WHERE id = ${id}
    `;
    const rows = await sql`SELECT * FROM vendor_expenses WHERE id = ${id}`;
    return res.status(200).json(shapeExpense(rows[0]));
  } catch (err) {
    console.error('update expense error:', err);
    return res.status(500).json({ error: 'Something went wrong on the server.' });
  }
});

app.delete('/api/expenses/:id', async (req, res) => {
  try {
    await sql`DELETE FROM vendor_expenses WHERE id = ${req.params.id}`;
    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('delete expense error:', err);
    return res.status(500).json({ error: 'Something went wrong on the server.' });
  }
});

// ---------- Accounting summary (income actually collected, expenses, net cash) ----------
app.get('/api/accounting/summary', async (req, res) => {
  try {
    const invoiceRows = await sql`SELECT amount, total_amount, status, paid_at FROM vendor_invoices`;
    const expenseRows = await sql`SELECT amount, expense_date FROM vendor_expenses`;

    let incomeCollected = 0;
    for (const r of invoiceRows) {
      if (r.status === 'paid' && r.paid_at) incomeCollected += Number(r.total_amount != null ? r.total_amount : r.amount);
    }
    let expensesTotal = 0;
    for (const r of expenseRows) expensesTotal += Number(r.amount) || 0;
    const netCashPosition = Math.round((incomeCollected - expensesTotal) * 100) / 100;

    // Last 12 months, oldest first, for a simple trend view.
    const months = [];
    const now = new Date();
    for (let i = 11; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      months.push(d.toISOString().slice(0, 7));
    }
    const byMonth = Object.fromEntries(months.map(m => [m, { month: m, income: 0, expenses: 0 }]));
    for (const r of invoiceRows) {
      if (r.status === 'paid' && r.paid_at) {
        const m = new Date(r.paid_at).toISOString().slice(0, 7);
        if (byMonth[m]) byMonth[m].income += Number(r.total_amount != null ? r.total_amount : r.amount);
      }
    }
    for (const r of expenseRows) {
      const m = String(r.expense_date).slice(0, 7);
      if (byMonth[m]) byMonth[m].expenses += Number(r.amount) || 0;
    }
    const monthly = months.map(m => ({ ...byMonth[m], net: Math.round((byMonth[m].income - byMonth[m].expenses) * 100) / 100 }));

    return res.status(200).json({ incomeCollected, expensesTotal, netCashPosition, monthly });
  } catch (err) {
    console.error('accounting summary error:', err);
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
    const { subject, message, priority, type } = req.body || {};
    if (!subject || !String(subject).trim()) return res.status(400).json({ error: 'subject is required.' });
    const id = 'qry_' + crypto.randomBytes(8).toString('hex');
    const safeType = ['support', 'customization'].includes(type) ? type : 'support';
    await sql`
      INSERT INTO vendor_queries (id, school_id, subject, message, priority, source, type)
      VALUES (${id}, ${school.id}, ${String(subject).trim().slice(0, 300)}, ${String(message || '').slice(0, 4000)}, ${priority || 'normal'}, 'api', ${safeType})
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
    // Piggybacks the access-suspension flag — and, likewise, this school's
    // current Plan/Modules selection — on the heartbeat that's already on a
    // timer in every reporting-enabled school's vendor-reporting.js, rather
    // than adding new endpoints/timers just for this. `school` here is the
    // row as of the START of this request — neither suspension nor the plan
    // is changed by this route, only read, so neither is ever stale.
    return res.status(200).json({
      ok: true,
      accessSuspended: !!school.access_suspended,
      accessSuspendedReason: school.access_suspended_reason || null,
      planType: school.plan_type || null,
      planModules: school.plan_modules || [],
    });
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
