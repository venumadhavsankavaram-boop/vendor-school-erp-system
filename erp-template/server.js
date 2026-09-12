// Express server for Render — serves the ERP's static files AND handles
// every /api/* request, using the exact same tested resource-handling logic
// that ran on Vercel. Only the "wrapper" around it changed: Vercel routed
// dynamically via api/[resource].js; here, Express does the same job via
// an explicit route parameter (req.params.resource instead of
// req.query.resource) — every SIMPLE_RESOURCES / HYBRID_RESOURCES config
// and every custom handler function below is unchanged from what was
// already tested and confirmed working.

import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import { neon } from '@neondatabase/serverless';
import webpush from 'web-push';
// Fleet reporting + support-login — see ../reporting-client/ for the
// canonical copies and full wiring docs (also README.md, "Reporting
// Client"). Both are opt-in and fail silent: with VENDOR_DASHBOARD_URL /
// VENDOR_SCHOOL_ID / VENDOR_API_KEY unset (the default for a school not
// yet added to the vendor dashboard), this does nothing at all.
import { startVendorReporting, reportVendorError, isAccessSuspended, getModuleAccess } from './vendor-reporting.js';
import { handleVendorSupportLogin } from './vendor-support-login.js';
startVendorReporting();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
// Default body-size limit (100kb) is far too small the moment any record
// carries a photo or document as a base64 data URL (website gallery photos,
// student/staff photos, ID card photos, admit-card signatures, admin
// downloads) — those routinely run several hundred KB to a few MB once
// base64-encoded. Under the old default, a POST/PUT carrying one of those
// was rejected by this middleware with 413 Payload Too Large before it ever
// reached a route handler; the client didn't check the response status (see
// the matching index.html fix), so it looked like a normal save while
// nothing was actually written to the database.
//
// One route needs the opposite treatment: /api/admission-inquiries is the
// only endpoint the public school website can POST to with zero login of
// any kind (see WEBSITE_CORS_RULES below) — it's a plain text form (a
// name, an email, a phone number, a note), so it never needs anything
// close to 25mb. Registering a small-limit JSON parser for that one path
// first means it — and only it — gets capped at 20kb; body-parser marks
// the body as already-parsed, so the 25mb parser below skips it and still
// applies normally to every other route. This keeps a stray or malicious
// caller from using the one unauthenticated write endpoint in the app to
// stuff giant payloads into the database.
app.use('/api/admission-inquiries', express.json({ limit: '20kb' }));
app.use(express.json({ limit: '25mb' }));

// The public school website (a separate static site, on its own domain) talks to
// this ERP straight over the network for a handful of resources — it isn't hosted
// on the same origin, so the browser needs an explicit CORS allowance for each one.
// Listed per-resource (not the whole /api/*) so the rest of the API — which
// includes things like user records — stays inaccessible to any other site's
// frontend code. Methods are scoped to what the website actually does with each:
// it only submits inquiries (POST), and only reads everything else (GET).
// Per-deployment value — set the WEBSITE_ORIGIN environment variable to this
// school's public website URL (e.g. https://<school>-website.onrender.com).
// Deliberately env-driven rather than hardcoded: this file is the shared ERP
// template every school's Render service runs unmodified, so nothing here
// should need a code edit per school. Left unset, these four endpoints simply
// get no CORS header — the website's calls to them will fail closed (safe
// default) until WEBSITE_ORIGIN is configured, rather than silently allowing
// the wrong (or no) origin.
const WEBSITE_ORIGIN = process.env.WEBSITE_ORIGIN || '';
const WEBSITE_CORS_RULES = {
  '/api/admission-inquiries': 'POST, OPTIONS',
  '/api/comms-messages': 'GET, OPTIONS',
  '/api/website-gallery': 'GET, OPTIONS',
  '/api/school-info': 'GET, OPTIONS',
};
app.use((req, res, next) => {
  const allowedMethods = WEBSITE_CORS_RULES[req.path];
  if (allowedMethods && WEBSITE_ORIGIN) {
    res.header('Access-Control-Allow-Origin', WEBSITE_ORIGIN);
    res.header('Access-Control-Allow-Methods', allowedMethods);
    res.header('Access-Control-Allow-Headers', 'Content-Type');
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

const sql = neon(process.env.DATABASE_URL);

// A request header value that came from decodeURIComponent-encoded text
// (see the client's actorHeaders() helper) — falls back to the raw value
// if it isn't actually encoded, so this never throws on a header some
// other caller (e.g. a script, not this app's own UI) sent unencoded.
function decodeHeaderValue(v) {
  if (!v) return '';
  try { return decodeURIComponent(String(v)); } catch (e) { return String(v); }
}

// ---------- Schema bootstrap ----------
// Every table this app needs, created only if missing. This means standing the
// whole ERP up against a brand-new, completely empty Postgres database (a
// fresh Neon project, for a future re-install) is just: set DATABASE_URL and
// start the server — no separate schema.sql to run by hand, no migration
// step to remember. It's a no-op against the current live database (every
// one of these tables already exists there), so this changes nothing about
// how the app behaves today; it only matters the day this ever needs to be
// stood up again from scratch. Column types are the ones this app's own
// read/write code already expects (JSONB where the code does `::jsonb`
// casts and reads the result back as a real array/object; TEXT — not DATE —
// for date-shaped fields, since a couple of them are legitimately sent as an
// empty string before they're filled in, e.g. a discount's approval date
// before it's approved).
async function ensureSchema() {
  await sql`CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY, name TEXT, username TEXT, password TEXT, role TEXT,
    linked_student_id TEXT, recovery_code TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`;
  // Soft delete: a deleted user's row stays put with deleted_at set, instead
  // of being erased outright. This closes two real gaps found after an
  // actual incident — a hard DELETE gave no way back if it was a mistake,
  // and deleting your own logged-in account left that session looking
  // "still logged in" until it naturally expired, since nothing previously
  // re-checked the user still existed mid-session. See handleUsers below
  // for the restore path, the self-delete/last-admin guards, and the
  // immediate session wipe that now comes with every delete.
  await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ`;
  await sql`CREATE TABLE IF NOT EXISTS payments (
    id TEXT PRIMARY KEY, receipt_no TEXT, student_id TEXT, student_name TEXT, category TEXT, mode TEXT,
    amount NUMERIC DEFAULT 0, discount NUMERIC DEFAULT 0, instalment TEXT, date TEXT, note TEXT,
    class_at_payment TEXT, extra_fee_name TEXT, extra_fee_id TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`;
  await sql`CREATE TABLE IF NOT EXISTS student_discounts (
    id TEXT PRIMARY KEY, batch_id TEXT, student_id TEXT, type TEXT, applies_to TEXT, mode TEXT,
    value NUMERIC DEFAULT 0, note TEXT, status TEXT, requested_by TEXT, requested_role TEXT, requested_date TEXT,
    approver_id TEXT, approver_name TEXT, approved_by TEXT, approved_date TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`;
  await sql`CREATE TABLE IF NOT EXISTS student_extra_fees (
    id TEXT PRIMARY KEY, student_id TEXT, name TEXT, amount NUMERIC DEFAULT 0, paid BOOLEAN DEFAULT false,
    paid_amount NUMERIC DEFAULT 0, date TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`;
  await sql`CREATE TABLE IF NOT EXISTS attendance_records (
    id TEXT PRIMARY KEY, student_id TEXT, date TEXT, status TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`;
  await sql`CREATE TABLE IF NOT EXISTS holidays (
    id TEXT PRIMARY KEY, date TEXT, name TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`;
  await sql`CREATE TABLE IF NOT EXISTS exam_results (
    id TEXT PRIMARY KEY, exam_id TEXT, student_id TEXT, subject TEXT, marks NUMERIC, absent BOOLEAN DEFAULT false,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`;
  await sql`CREATE TABLE IF NOT EXISTS staff_attendance_records (
    id TEXT PRIMARY KEY, staff_id TEXT, date TEXT, status TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`;
  // Raw log of every punch the on-site biometric bridge has ever forwarded
  // (see the "Biometric attendance" section below) — kept even for
  // unmatched device user IDs so the Admin's Biometric Sync tab can show
  // them and prompt a mapping fix, and even for matched ones that didn't
  // end up changing staff_attendance_records (e.g. a second punch the same
  // day). id is deterministic (device serial + device user id + timestamp)
  // so the bridge can safely resend the same punch without double-logging.
  await sql`CREATE TABLE IF NOT EXISTS biometric_punches (
    id TEXT PRIMARY KEY, device_serial TEXT, device_user_id TEXT, punched_at TIMESTAMPTZ,
    staff_id TEXT, staff_name TEXT, matched BOOLEAN DEFAULT false, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`;
  await sql`CREATE TABLE IF NOT EXISTS admission_inquiries (
    id TEXT PRIMARY KEY, parent_name TEXT, parent_email TEXT, parent_phone TEXT, student_name TEXT,
    applying_grade TEXT, notes TEXT, submitted_date TEXT, status TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`;
  await sql`CREATE TABLE IF NOT EXISTS website_gallery (
    id TEXT PRIMARY KEY, data_url TEXT, category TEXT, caption TEXT, uploaded_date TEXT, uploaded_by TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`;
  await sql`CREATE TABLE IF NOT EXISTS students (
    id TEXT PRIMARY KEY, first_name TEXT, last_name TEXT, class_name TEXT, section TEXT, status TEXT,
    admission_no TEXT, extra JSONB NOT NULL DEFAULT '{}'::jsonb, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`;
  // Same soft-delete treatment as users — see the ALTER TABLE users comment
  // above and HYBRID_RESOURCES.students' softDelete flag below.
  await sql`ALTER TABLE students ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ`;
  await sql`CREATE TABLE IF NOT EXISTS staff (
    id TEXT PRIMARY KEY, first_name TEXT, last_name TEXT, department TEXT, designation TEXT, status TEXT,
    staff_id TEXT, extra JSONB NOT NULL DEFAULT '{}'::jsonb, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`;
  await sql`CREATE TABLE IF NOT EXISTS staff_payroll (
    id TEXT PRIMARY KEY, staff_id TEXT, month TEXT, status TEXT,
    extra JSONB NOT NULL DEFAULT '{}'::jsonb, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`;
  await sql`CREATE TABLE IF NOT EXISTS comms_messages (
    id TEXT PRIMARY KEY, extra JSONB NOT NULL DEFAULT '{}'::jsonb, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`;
  await sql`CREATE TABLE IF NOT EXISTS rooms (
    id TEXT PRIMARY KEY, extra JSONB NOT NULL DEFAULT '{}'::jsonb, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`;
  await sql`CREATE TABLE IF NOT EXISTS exam_hall_tickets (
    id TEXT PRIMARY KEY, extra JSONB NOT NULL DEFAULT '{}'::jsonb, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`;
  await sql`CREATE TABLE IF NOT EXISTS exam_room_config (
    id TEXT PRIMARY KEY, extra JSONB NOT NULL DEFAULT '{}'::jsonb, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`;
  await sql`CREATE TABLE IF NOT EXISTS subjects (
    id TEXT PRIMARY KEY, name TEXT, code TEXT, class_name TEXT,
    sections JSONB NOT NULL DEFAULT '[]'::jsonb, section_staff JSONB NOT NULL DEFAULT '{}'::jsonb,
    staff_ids JSONB NOT NULL DEFAULT '[]'::jsonb, countable BOOLEAN DEFAULT true, elective BOOLEAN DEFAULT false,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`;
  await sql`CREATE TABLE IF NOT EXISTS exam_defs (
    id TEXT PRIMARY KEY, name TEXT, exam_type TEXT, start_date TEXT, end_date TEXT,
    class_subjects JSONB NOT NULL DEFAULT '{}'::jsonb, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`;
  await sql`CREATE TABLE IF NOT EXISTS custom_roles (
    id TEXT PRIMARY KEY, name TEXT, permissions JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`;
  await sql`CREATE TABLE IF NOT EXISTS fee_structure (
    class_name TEXT PRIMARY KEY, admission NUMERIC DEFAULT 0, fee NUMERIC DEFAULT 0,
    bus NUMERIC DEFAULT 0, stock NUMERIC DEFAULT 0
  )`;
  await sql`CREATE TABLE IF NOT EXISTS attendance_settings (
    id INTEGER PRIMARY KEY, threshold NUMERIC DEFAULT 75, working_days JSONB NOT NULL DEFAULT '[1,2,3,4,5,6]'::jsonb
  )`;
  await sql`CREATE TABLE IF NOT EXISTS school_info (
    id INTEGER PRIMARY KEY, data JSONB NOT NULL DEFAULT '{}'::jsonb
  )`;
  // One row per numbering series per period (e.g. series='income_voucher',
  // period='26-27') — see the "Document numbering" section below for how
  // this is used. Deliberately its own tiny table (not a kv_store entry):
  // issuing a number is a single atomic UPDATE...RETURNING against one row
  // here, which Postgres serializes correctly under concurrent requests.
  // kv_store's whole-value PUT (see handleKv below) has no such guarantee —
  // two staff saving a voucher at the same moment could both compute the
  // same "next" number and silently overwrite each other, which is exactly
  // the bug this table exists to close.
  await sql`CREATE TABLE IF NOT EXISTS doc_counters (
    series TEXT NOT NULL, period TEXT NOT NULL, next_seq INTEGER NOT NULL DEFAULT 1,
    PRIMARY KEY (series, period)
  )`;
  // Accounting: Income (Receipt) and Payment vouchers. These used to live as
  // a single JSON blob per school in kv_store (acct-income / acct-expenses)
  // — every save round-tripped the ENTIRE list, so two staff saving around
  // the same moment could each overwrite the other's entry with no error or
  // warning. Real tables + voucher_no UNIQUE fix both that and the
  // duplicate-numbering problem at once. migrateAccountingFromKv() below
  // copies over anything already recorded the old way, once, at boot.
  // cost_center is a SEPARATE dimension from category: category is the
  // account head (Salaries, Donation, ...); cost_center is the segment this
  // money belongs to (Transport, Inventory, Hostel, School Fees/General) —
  // so income and expenditure can be compared segment-by-segment (e.g. "is
  // running the bus profitable") independently of what account head it's
  // filed under.
  await sql`CREATE TABLE IF NOT EXISTS acct_income (
    id TEXT PRIMARY KEY, voucher_no TEXT UNIQUE, date TEXT, category TEXT, cost_center TEXT, amount NUMERIC DEFAULT 0,
    party TEXT, mode TEXT, reference_no TEXT, description TEXT, added_by TEXT,
    voided BOOLEAN NOT NULL DEFAULT false, void_reason TEXT, voided_by TEXT, voided_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`;
  await sql`CREATE TABLE IF NOT EXISTS acct_expenses (
    id TEXT PRIMARY KEY, voucher_no TEXT UNIQUE, date TEXT, category TEXT, cost_center TEXT, amount NUMERIC DEFAULT 0,
    party TEXT, mode TEXT, reference_no TEXT, description TEXT, added_by TEXT,
    voided BOOLEAN NOT NULL DEFAULT false, void_reason TEXT, voided_by TEXT, voided_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`;
  // A Student/Parent login reaching out to their Class Teacher, a specific
  // Subject Teacher, or Management (Admin/Principal) with a concern.
  // recipient_staff_id is the resolved staff.id for class_teacher/
  // subject_teacher (resolved client-side, the same way the rest of the app
  // already looks up a class/subject teacher — see classTeacherClass and
  // subjectStaffForSection in index.html); it's left null for management,
  // since that's a whole role rather than one specific person. subject_name
  // is only meaningful for subject_teacher (a student may have several). A
  // concern gets at most one reply — reply_* stays null until a staff member
  // answers, at which point status flips from 'open' to 'resolved'.
  await sql`CREATE TABLE IF NOT EXISTS student_concerns (
    id TEXT PRIMARY KEY, student_id TEXT, student_name TEXT, class_name TEXT, section TEXT,
    recipient_type TEXT, recipient_staff_id TEXT, recipient_name TEXT, subject_name TEXT,
    message TEXT, status TEXT NOT NULL DEFAULT 'open',
    reply_message TEXT, replied_by TEXT, replied_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`;
  // Whether a concern is actually solved is a separate decision from
  // whether it's been replied to — a teacher might reply "will check and get
  // back" without the matter being resolved yet, or resolve something over a
  // phone call with no reply logged at all. resolved_at/resolved_by are
  // reset to null on reopening rather than kept as history, so the badge
  // shown always reflects the current solved state, not every past toggle.
  // ADD COLUMN IF NOT EXISTS since student_concerns already existed in
  // production before this pair of columns was added.
  await sql`ALTER TABLE student_concerns ADD COLUMN IF NOT EXISTS resolved_at TIMESTAMPTZ`;
  await sql`ALTER TABLE student_concerns ADD COLUMN IF NOT EXISTS resolved_by TEXT`;
  // A Student/Parent login submitting completed homework or holiday work to
  // their Class Teacher, a Subject Teacher, or Management. homework_id is an
  // optional link back to an existing kv_store homeworkItems entry (see
  // index.html's HOMEWORK_KEY) — left blank for holiday/other work that was
  // never listed as a homework item in the first place. attachment is an
  // optional base64 data URL, same convention as every other file upload in
  // this app (no separate object storage). status starts 'submitted' and
  // becomes 'reviewed' once a staff member leaves feedback.
  await sql`CREATE TABLE IF NOT EXISTS student_submissions (
    id TEXT PRIMARY KEY, student_id TEXT, student_name TEXT, class_name TEXT, section TEXT,
    recipient_type TEXT, recipient_staff_id TEXT, recipient_name TEXT, subject_name TEXT,
    homework_id TEXT, title TEXT, description TEXT, attachment TEXT,
    status TEXT NOT NULL DEFAULT 'submitted',
    feedback TEXT, reviewed_by TEXT, reviewed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`;
  // Widened from a single `attachment` to a JSONB array of {name, dataUrl}
  // so a submission can carry more than one file (a scan of several
  // worksheet pages, or a worksheet plus a cover note) — same base64
  // data-URL convention as every other upload in this app, just several of
  // them per row instead of one. `attachment` (singular) stays on the table
  // for any row saved before this existed; the app reads `attachments` first
  // and falls back to wrapping `attachment` for those older rows.
  await sql`ALTER TABLE student_submissions ADD COLUMN IF NOT EXISTS attachments JSONB NOT NULL DEFAULT '[]'::jsonb`;
  // The generic key/value table backs every module that doesn't need its own
  // dedicated table with real columns — Inventory, Timetable, Library, Transport,
  // Hostel, Accounting, Fee/Exam sub-settings, Report Template signatures, Class
  // & Section setup, Pending Approvals, and a few others (see index.html's
  // OBJECT_BACKED_KEYS registrations for the full list). Each round-trips its
  // whole current value as JSON, keyed by the same string the module already
  // uses as its storage key, rather than needing one more hand-built table.
  await sql`CREATE TABLE IF NOT EXISTS kv_store (
    key TEXT PRIMARY KEY, value JSONB NOT NULL DEFAULT '{}'::jsonb, updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`;
  // Who changed what, when. One row per successful write (POST/PUT/DELETE)
  // to any /api/:resource endpoint, written centrally by the main dispatcher
  // rather than by each individual handler — see the comment there. Actor
  // fields are self-reported by the browser (no server-side sessions exist
  // yet to read them from authoritatively), so treat this as "what the app
  // told us happened," same trust level as everything else here today —
  // still genuinely useful for spotting an accidental bulk-delete or
  // tracking down when a record last changed.
  await sql`CREATE TABLE IF NOT EXISTS audit_log (
    id BIGSERIAL PRIMARY KEY, actor_name TEXT, actor_role TEXT, method TEXT, resource TEXT,
    record_id TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`;

  // One row per signed-in browser session. `id` is a SHA-256 hash of the
  // random token actually sent to the browser (in an httpOnly cookie) —
  // never the raw token itself — so reading this table (a backup export, a
  // database console, a leaked dump) can't be turned into a working login
  // cookie for anyone. See the "Session-based authentication" section below
  // for how this is created, checked, and expired.
  await sql`CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY, user_id TEXT, role TEXT, name TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at TIMESTAMPTZ NOT NULL
  )`;

  // One row per browser/device a Parent or Student login has granted Web
  // Push permission on (a login can have several — phone + laptop, say).
  // endpoint is the unique push service URL the browser handed back from
  // pushManager.subscribe(); p256dh/auth are that subscription's own
  // encryption keys, both required to encrypt a push payload for it. See
  // the "Notifications: Web Push + WhatsApp" section below for how these
  // are written (POST /api/push/subscribe) and used (sendPushToUser).
  await sql`CREATE TABLE IF NOT EXISTS push_subscriptions (
    id BIGSERIAL PRIMARY KEY, user_id TEXT NOT NULL, endpoint TEXT NOT NULL UNIQUE,
    p256dh TEXT NOT NULL, auth TEXT NOT NULL, user_agent TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`;

  // Idempotency log for notifications that a repeated check could otherwise
  // send more than once — right now just the fee-due reminders (the daily
  // scheduler re-evaluates every active student every run) and "results
  // published" (every individual mark save re-checks whether the student's
  // full subject set is now complete). A payment or an attendance mark is
  // its own one-off event and never re-fires, so those aren't logged here.
  // (student_id, kind, ref_key) is unique so a second attempt at the same
  // notification is a no-op via ON CONFLICT DO NOTHING, not a duplicate row.
  await sql`CREATE TABLE IF NOT EXISTS notification_events (
    id BIGSERIAL PRIMARY KEY, student_id TEXT NOT NULL, kind TEXT NOT NULL, ref_key TEXT NOT NULL,
    sent_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (student_id, kind, ref_key)
  )`;

  // ---------- Indexes ----------
  // The tables above are all read by student_id / staff_id / username / date
  // lookups constantly (a student's fee history, a staff member's payroll
  // months, attendance for one student across a year, the login lookup on
  // every sign-in) — without an index Postgres has to scan the whole table
  // for each of those. IF NOT EXISTS makes this idempotent and safe to run
  // on every boot, same as the CREATE TABLE statements above. Non-unique on
  // purpose: this is a performance fix, not a data-integrity change — adding
  // a UNIQUE constraint on username here could fail outright (or silently
  // change behavior) if any duplicate usernames already exist in the live
  // data, which is a separate decision from "make lookups fast."
  await sql`CREATE INDEX IF NOT EXISTS idx_users_username ON users (LOWER(username))`;
  await sql`CREATE INDEX IF NOT EXISTS idx_push_subscriptions_user_id ON push_subscriptions (user_id)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_payments_student_id ON payments (student_id)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_payments_date ON payments (date)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_student_discounts_student_id ON student_discounts (student_id)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_student_discounts_batch_id ON student_discounts (batch_id)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_student_extra_fees_student_id ON student_extra_fees (student_id)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_attendance_records_student_id ON attendance_records (student_id)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_attendance_records_date ON attendance_records (date)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_exam_results_exam_id ON exam_results (exam_id)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_exam_results_student_id ON exam_results (student_id)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_staff_attendance_records_staff_id ON staff_attendance_records (staff_id)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_staff_attendance_records_date ON staff_attendance_records (date)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_biometric_punches_punched_at ON biometric_punches (punched_at DESC)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_staff_payroll_staff_id ON staff_payroll (staff_id)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_admission_inquiries_status ON admission_inquiries (status)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_website_gallery_category ON website_gallery (category)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_audit_log_created_at ON audit_log (created_at DESC)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_audit_log_resource ON audit_log (resource)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions (expires_at)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions (user_id)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_users_deleted_at ON users (deleted_at)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_students_deleted_at ON students (deleted_at)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_acct_income_date ON acct_income (date)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_acct_expenses_date ON acct_expenses (date)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_student_concerns_student_id ON student_concerns (student_id)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_student_concerns_recipient_staff_id ON student_concerns (recipient_staff_id)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_student_concerns_recipient_type ON student_concerns (recipient_type)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_student_submissions_student_id ON student_submissions (student_id)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_student_submissions_recipient_staff_id ON student_submissions (recipient_staff_id)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_student_submissions_recipient_type ON student_submissions (recipient_type)`;
}
await ensureSchema();

// ---------- One-time accounting migration: kv_store blobs -> real tables ----------
// Runs once per table (skips if acct_income / acct_expenses already has rows,
// so a restart doesn't re-copy anything). Old entries may already carry a
// duplicate or missing voucherNo (that's the very bug being fixed here), so
// anything that can't keep its original number safely gets a LEGACY- number
// instead of being silently dropped or crashing the migration on the new
// UNIQUE constraint.
async function migrateAccountingFromKv() {
  async function migrateOne(kvKey, table) {
    const [{ c }] = await sql.query(`SELECT COUNT(*)::int AS c FROM ${table}`);
    if (c > 0) return;
    const kvRows = await sql`SELECT value FROM kv_store WHERE key = ${kvKey}`;
    const items = kvRows.length && Array.isArray(kvRows[0].value) ? kvRows[0].value : [];
    if (!items.length) return;
    const seen = new Set();
    let migrated = 0;
    for (const item of items) {
      if (!item || !item.id) continue;
      let voucherNo = item.voucherNo || null;
      if (!voucherNo || seen.has(voucherNo)) voucherNo = 'LEGACY-' + item.id;
      seen.add(voucherNo);
      // table is always one of our own two hardcoded literals ('acct_income' /
      // 'acct_expenses') passed in by migrateOne's caller below — never user
      // input — so building it into the query text is safe. It has to be done
      // this way (sql.query with $-placeholders) rather than the usual
      // sql`...` tagged template: this driver (@neondatabase/serverless) only
      // allows sql to be called as a tagged template, so the postgres.js-style
      // sql(table) dynamic-identifier helper used here originally doesn't
      // exist and throws at runtime — this is what broke the Sept 4 deploy.
      await sql.query(
        `INSERT INTO ${table} (id, voucher_no, date, category, cost_center, amount, party, mode, reference_no, description, added_by, voided, void_reason, voided_by, voided_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
         ON CONFLICT (id) DO NOTHING`,
        [item.id, voucherNo, item.date || null, item.category || null, item.costCenter || null, Number(item.amount) || 0,
         item.party || null, item.mode || null, item.referenceNo || null, item.description || null,
         item.addedBy || null, !!item.voided, item.voidReason || null, item.voidedBy || null, item.voidedAt || null]
      );
      migrated++;
    }
    if (migrated) console.log(`Migrated ${migrated} legacy record(s) from kv_store["${kvKey}"] into ${table}.`);
  }
  await migrateOne('acct-income', 'acct_income');
  await migrateOne('acct-expenses', 'acct_expenses');
}
await migrateAccountingFromKv();

// ---------- One-time password migration ----------
// Every password in the `users` table has been plain text since this app's
// first version — readable by anyone who could call GET /api/users, which
// (with no server-side login check on any route yet — see the security
// review) meant anyone who could reach this server at all. This hashes any
// password that isn't already a bcrypt hash (those always start with
// "$2") in place, once, right here at startup, before the server accepts
// its first request — so this school's existing live accounts end up hashed
// with no separate manual step. (A fresh install's seeded admin account is
// inserted already hashed — see seedDefaultAdminIfEmpty below.) Running this
// again on a later restart
// finds every row already hashed and does nothing, so it's safe to leave
// in place permanently rather than removing it after the first deploy.
async function migratePlaintextPasswords() {
  const rows = await sql`SELECT id, password FROM users WHERE password IS NOT NULL AND password NOT LIKE '$2%'`;
  for (const row of rows) {
    const hash = await bcrypt.hash(String(row.password), 10);
    await sql`UPDATE users SET password = ${hash} WHERE id = ${row.id}`;
  }
  if (rows.length) console.log(`Migrated ${rows.length} plaintext password(s) to bcrypt hashes.`);
}
await migratePlaintextPasswords();

// ---------- Seed a default admin only when the users table is completely empty ----------
// The client used to seed a hardcoded admin/admin123 account itself, and the login
// screen displayed that literal credential to every visitor, permanently — anyone
// who opened the browser's view-source could read the password straight out of the
// shipped JavaScript, and anyone who simply loaded the login page saw it printed on
// screen, whether or not an admin had ever changed it. This does the seeding here
// instead: it runs once, only when no user rows exist yet, generates a random
// password, hashes it before it ever reaches the database, and prints the plaintext
// exactly once to this server's own console (visible only in the hosting dashboard's
// logs — never sent to any client, never stored anywhere in plaintext).
async function seedDefaultAdminIfEmpty() {
  const rows = await sql`SELECT id FROM users LIMIT 1`;
  if (rows.length) return;
  const rawPassword = crypto.randomBytes(9).toString('base64url');
  const hash = await bcrypt.hash(rawPassword, 10);
  const recoveryCode = crypto.randomBytes(6).toString('hex').toUpperCase();
  await sql`
    INSERT INTO users (id, name, username, password, role, linked_student_id, recovery_code)
    VALUES ('u_admin', 'Administrator', 'admin', ${hash}, 'Admin', '', ${recoveryCode})
  `;
  console.log('============================================================');
  console.log('First run: created the default admin account.');
  console.log('  Username: admin');
  console.log(`  Password: ${rawPassword}`);
  console.log('Sign in with this once, then change the password immediately');
  console.log('(Initial Setup -> Users & Roles). Printed only this one time —');
  console.log('it is not stored anywhere in plaintext and will not be shown again.');
  console.log('============================================================');
}
await seedDefaultAdminIfEmpty();

// ---------- Session-based authentication ----------
// Until now, nothing on the server checked whether a caller was logged in
// before answering an /api/* request — the login screen was purely a
// client-side gate, and a request made straight to the API (curl, a
// script, anything other than this app's own login-gated UI) went through
// unchecked. This closes that gap: /api/login now hands back a random
// session token in an httpOnly cookie, and every /api/* route except the
// short public allowlist below requires a valid, unexpired one.
//
// No new dependency: cookies are parsed by hand (a request has at most a
// handful of small key=value pairs — not worth adding a library for), and
// the session store is one more table in the same Postgres database this
// app already has open, rather than a separate service to run and monitor.
//
// The token in the cookie and the token stored server-side are not the
// same string: the cookie holds a random value the browser presents on
// every request, and only that value's SHA-256 hash is kept in the
// `sessions` table (see ensureSchema above) — so a leak of the database
// (a backup file, a console query, anything read-only) can't be replayed
// as a working login the way a stored raw token could be.
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
// Render terminates TLS at its edge and forwards to this process over
// plain HTTP, so req.secure is never true here on its own; the standard
// signal a proxy leaves behind is this header (same reasoning as the
// x-forwarded-for read already used for login rate-limiting below).
function isHttpsRequest(req) {
  return req.secure || req.headers['x-forwarded-proto'] === 'https';
}

// A session is good for 30 minutes of inactivity (sliding — each
// authenticated request pushes it back out), up to a hard cap of 12 hours
// from login regardless of activity, so a cookie left open on a shared
// front-office computer can't stay valid indefinitely.
const SESSION_IDLE_MS = 30 * 60 * 1000;
const SESSION_ABSOLUTE_MAX_MS = 12 * 60 * 60 * 1000;

async function createSession(req, res, user) {
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + SESSION_IDLE_MS);
  await sql`
    INSERT INTO sessions (id, user_id, role, name, expires_at)
    VALUES (${hashSessionToken(token)}, ${user.id}, ${user.role}, ${user.name}, ${expiresAt.toISOString()})
  `;
  const secureFlag = isHttpsRequest(req) ? '; Secure' : '';
  res.setHeader('Set-Cookie', `sid=${token}; HttpOnly${secureFlag}; SameSite=Lax; Path=/; Max-Age=${Math.floor(SESSION_ABSOLUTE_MAX_MS / 1000)}`);
}
async function destroySession(req, res) {
  const cookies = parseCookies(req);
  if (cookies.sid) {
    await sql`DELETE FROM sessions WHERE id = ${hashSessionToken(cookies.sid)}`.catch(() => {});
  }
  res.setHeader('Set-Cookie', 'sid=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0');
}

// Routes (and only these methods on them) that must keep working with no
// login at all: the public school website submits an inquiry and reads a
// few read-only resources from its own separate domain (see
// WEBSITE_CORS_RULES above — this list is deliberately the same set), plus
// logging in and out are themselves how a session is created or cleared.
const PUBLIC_API_ROUTES = [
  { path: '/api/login', methods: ['POST'] },
  { path: '/api/logout', methods: ['POST'] },
  { path: '/api/vendor-support-login', methods: ['GET'] },
  { path: '/api/vendor/admission-inquiries', methods: ['GET'] },
  { path: '/api/admission-inquiries', methods: ['POST'] },
  { path: '/api/comms-messages', methods: ['GET'] },
  { path: '/api/website-gallery', methods: ['GET'] },
  { path: '/api/school-info', methods: ['GET'] },
  // Called by the on-site biometric bridge (a machine, not a logged-in
  // person) — authenticated by its own BIOMETRIC_API_KEY header check
  // inside the route, same pattern as /api/vendor/admission-inquiries above.
  { path: '/api/biometric/punches', methods: ['POST'] },
];
function isPublicApiRoute(req) {
  return PUBLIC_API_ROUTES.some(r => r.path === req.path && r.methods.includes(req.method));
}

app.use(async (req, res, next) => {
  if (!req.path.startsWith('/api/')) return next(); // static files / the app shell itself stay open
  if (req.method === 'OPTIONS' || isPublicApiRoute(req)) return next();
  try {
    const token = parseCookies(req).sid;
    if (!token) return res.status(401).json({ error: 'Not logged in.' });
    const idHash = hashSessionToken(token);
    const rows = await sql`SELECT * FROM sessions WHERE id = ${idHash}`;
    if (!rows.length) return res.status(401).json({ error: 'Session expired. Please log in again.' });
    const session = rows[0];
    const now = Date.now();
    const createdAt = new Date(session.created_at).getTime();
    if (new Date(session.expires_at).getTime() < now || now - createdAt > SESSION_ABSOLUTE_MAX_MS) {
      await sql`DELETE FROM sessions WHERE id = ${idHash}`.catch(() => {});
      return res.status(401).json({ error: 'Session expired. Please log in again.' });
    }
    // Sliding renewal, capped at the absolute 12-hour ceiling from login —
    // fire-and-forget so a slow write here never delays the actual request.
    const newExpires = new Date(Math.min(now + SESSION_IDLE_MS, createdAt + SESSION_ABSOLUTE_MAX_MS));
    sql`UPDATE sessions SET expires_at = ${newExpires.toISOString()}, last_seen_at = now() WHERE id = ${idHash}`.catch(() => {});
    req.authUser = { id: session.user_id, role: session.role, name: session.name };
    next();
  } catch (err) {
    console.error('auth check error:', err);
    return res.status(500).json({ error: 'Something went wrong on the server.' });
  }
});

async function handleKv(req, res, key) {
  if (!key) return res.status(400).json({ error: 'Missing key.' });
  if (ADMIN_ONLY_KV_KEYS.includes(key) && (!req.authUser || req.authUser.role !== 'Admin')) {
    return res.status(403).json({ error: 'Admin access required.' });
  }
  // See PARENT_SHARED_REFERENCE_KV_KEYS above — same reasoning as the main
  // dispatcher's PARENT_SHARED_REFERENCE_RESOURCES: a Student/Parent login
  // reading shared reference data (right now, the late-fee policy) needs no
  // staff module permission — there's nothing per-student here to leak.
  const parentSharedKvBypass = req.method === 'GET' && req.authUser && PARENT_LOGIN_ROLES.includes(req.authUser.role) && PARENT_SHARED_REFERENCE_KV_KEYS.includes(key);
  if (KV_KEY_TO_MODULE[key]) {
    // Plan gating applies regardless of role (including Admin, and the
    // parent/student shared-reference bypass below) — it's about what the
    // school paid for, not who's asking.
    const planOk = await checkPlanModuleAccess(req, res, KV_KEY_TO_MODULE[key]);
    if (!planOk) return;
  }
  if (KV_KEY_TO_MODULE[key] && !parentSharedKvBypass) {
    const allowed = await checkModuleAccess(req, res, KV_KEY_TO_MODULE[key]);
    if (!allowed) return; // checkModuleAccess already sent the 403
  }
  if (req.method === 'GET') {
    const rows = await sql`SELECT value FROM kv_store WHERE key = ${key}`;
    return res.status(200).json(rows.length ? rows[0].value : {});
  }
  if (req.method === 'PUT') {
    const value = req.body;
    const json = JSON.stringify(value === undefined ? {} : value);
    await sql`
      INSERT INTO kv_store (key, value, updated_at) VALUES (${key}, ${json}::jsonb, now())
      ON CONFLICT (key) DO UPDATE SET value = ${json}::jsonb, updated_at = now()
    `;
    return res.status(200).json({ ok: true });
  }
  return res.status(405).json({ error: 'Method not allowed.' });
}
app.all('/api/kv/:key', async (req, res) => {
  try {
    return await handleKv(req, res, req.params.key);
  } catch (err) {
    console.error(`kv API error (${req.params.key}):`, err);
    return res.status(500).json({ error: 'Something went wrong on the server.' });
  }
});

// ---------- Document numbering (Income/Payment vouchers, and any future series) ----------
// Indian schools run their financial year April -> March; a receipt/payment
// voucher series conventionally restarts at 1 each financial year rather
// than counting up forever. "26-27" means FY starting April 2026.
function currentFinancialYear() {
  const now = new Date();
  const y = now.getFullYear();
  const startY = now.getMonth() + 1 >= 4 ? y : y - 1; // Jan-Mar still belongs to the FY that started the previous April
  return String(startY % 100).padStart(2, '0') + '-' + String((startY + 1) % 100).padStart(2, '0');
}
// Add a series here (and give it a prefix) any time a new numbered-document
// type needs the same guarantee — e.g. Fee Receipts or Inventory bills later —
// nothing else about this endpoint needs to change.
const DOC_SERIES_PREFIX = {
  income_voucher: 'RV',   // Receipt Voucher — money coming in, other than a fee payment
  payment_voucher: 'PV',  // Payment Voucher — money going out
};
app.post('/api/next-doc-number', async (req, res) => {
  try {
    const series = req.body && req.body.series;
    const prefix = DOC_SERIES_PREFIX[series];
    if (!prefix) return res.status(400).json({ error: 'Unknown numbering series: ' + series });
    const period = currentFinancialYear();
    // Single atomic statement: Postgres locks the (series, period) row for
    // the duration of this UPDATE, so two requests arriving at the same
    // instant are still serialized into 1 and 2, never both getting the same
    // number — this is the guarantee kv_store's whole-blob PUT couldn't give.
    const rows = await sql`
      INSERT INTO doc_counters (series, period, next_seq) VALUES (${series}, ${period}, 1)
      ON CONFLICT (series, period) DO UPDATE SET next_seq = doc_counters.next_seq + 1
      RETURNING next_seq
    `;
    const seq = rows[0].next_seq;
    const docNumber = `${prefix}/${period}/${String(seq).padStart(6, '0')}`;
    return res.status(200).json({ docNumber });
  } catch (err) {
    console.error('next-doc-number error:', err);
    return res.status(500).json({ error: 'Could not issue a document number.' });
  }
});

// ---------- Resource configuration (unchanged from the tested version) ----------
const SIMPLE_RESOURCES = {
  users: {
    table: 'users',
    fields: [
      { app: 'id', col: 'id' }, { app: 'name', col: 'name' }, { app: 'username', col: 'username' },
      { app: 'password', col: 'password' }, { app: 'role', col: 'role' },
      { app: 'linkedStudentId', col: 'linked_student_id' }, { app: 'recoveryCode', col: 'recovery_code' },
    ],
  },
  payments: {
    table: 'payments',
    fields: [
      { app: 'id', col: 'id' }, { app: 'receiptNo', col: 'receipt_no' }, { app: 'studentId', col: 'student_id' },
      { app: 'studentName', col: 'student_name' }, { app: 'category', col: 'category' }, { app: 'mode', col: 'mode' },
      { app: 'amount', col: 'amount', numeric: true }, { app: 'discount', col: 'discount', numeric: true }, { app: 'instalment', col: 'instalment' },
      { app: 'date', col: 'date' }, { app: 'note', col: 'note' }, { app: 'classAtPayment', col: 'class_at_payment' },
      { app: 'extraFeeName', col: 'extra_fee_name' }, { app: 'extraFeeId', col: 'extra_fee_id' },
    ],
  },
  discounts: {
    table: 'student_discounts',
    fields: [
      { app: 'id', col: 'id' }, { app: 'batchId', col: 'batch_id' }, { app: 'studentId', col: 'student_id' },
      { app: 'type', col: 'type' }, { app: 'appliesTo', col: 'applies_to' }, { app: 'mode', col: 'mode' },
      { app: 'value', col: 'value', numeric: true }, { app: 'note', col: 'note' }, { app: 'status', col: 'status' },
      { app: 'requestedBy', col: 'requested_by' }, { app: 'requestedRole', col: 'requested_role' },
      { app: 'requestedDate', col: 'requested_date' }, { app: 'approverId', col: 'approver_id' },
      { app: 'approverName', col: 'approver_name' }, { app: 'approvedBy', col: 'approved_by' },
      { app: 'approvedDate', col: 'approved_date' },
    ],
  },
  'extra-fees': {
    table: 'student_extra_fees',
    fields: [
      { app: 'id', col: 'id' }, { app: 'studentId', col: 'student_id' }, { app: 'name', col: 'name' },
      { app: 'amount', col: 'amount', numeric: true }, { app: 'paid', col: 'paid' }, { app: 'paidAmount', col: 'paid_amount', numeric: true },
      { app: 'date', col: 'date' },
    ],
  },
  attendance: {
    table: 'attendance_records',
    fields: [
      { app: 'id', col: 'id' }, { app: 'studentId', col: 'student_id' }, { app: 'date', col: 'date' },
      { app: 'status', col: 'status' },
    ],
  },
  holidays: {
    table: 'holidays',
    fields: [{ app: 'id', col: 'id' }, { app: 'date', col: 'date' }, { app: 'name', col: 'name' }],
  },
  'exam-results': {
    table: 'exam_results',
    fields: [
      { app: 'id', col: 'id' }, { app: 'examId', col: 'exam_id' }, { app: 'studentId', col: 'student_id' },
      { app: 'subject', col: 'subject' }, { app: 'marks', col: 'marks', numeric: true }, { app: 'absent', col: 'absent' },
    ],
  },
  'staff-attendance': {
    table: 'staff_attendance_records',
    fields: [
      { app: 'id', col: 'id' }, { app: 'staffId', col: 'staff_id' }, { app: 'date', col: 'date' },
      { app: 'status', col: 'status' },
    ],
  },
  'admission-inquiries': {
    table: 'admission_inquiries',
    fields: [
      { app: 'id', col: 'id' }, { app: 'parentName', col: 'parent_name' }, { app: 'parentEmail', col: 'parent_email' },
      { app: 'parentPhone', col: 'parent_phone' }, { app: 'studentName', col: 'student_name' },
      { app: 'applyingGrade', col: 'applying_grade' }, { app: 'notes', col: 'notes' },
      { app: 'submittedDate', col: 'submitted_date' }, { app: 'status', col: 'status' },
    ],
  },
  'website-gallery': {
    table: 'website_gallery',
    fields: [
      { app: 'id', col: 'id' }, { app: 'dataUrl', col: 'data_url' }, { app: 'category', col: 'category' },
      { app: 'caption', col: 'caption' }, { app: 'uploadedDate', col: 'uploaded_date' },
      { app: 'uploadedBy', col: 'uploaded_by' },
    ],
  },
  'acct-income': {
    table: 'acct_income',
    fields: [
      { app: 'id', col: 'id' }, { app: 'voucherNo', col: 'voucher_no' }, { app: 'date', col: 'date' },
      { app: 'category', col: 'category' }, { app: 'costCenter', col: 'cost_center' },
      { app: 'amount', col: 'amount', numeric: true }, { app: 'party', col: 'party' }, { app: 'mode', col: 'mode' },
      { app: 'referenceNo', col: 'reference_no' }, { app: 'description', col: 'description' }, { app: 'addedBy', col: 'added_by' },
      { app: 'voided', col: 'voided' }, { app: 'voidReason', col: 'void_reason' },
      { app: 'voidedBy', col: 'voided_by' }, { app: 'voidedAt', col: 'voided_at' },
    ],
  },
  'acct-expenses': {
    table: 'acct_expenses',
    fields: [
      { app: 'id', col: 'id' }, { app: 'voucherNo', col: 'voucher_no' }, { app: 'date', col: 'date' },
      { app: 'category', col: 'category' }, { app: 'costCenter', col: 'cost_center' },
      { app: 'amount', col: 'amount', numeric: true }, { app: 'party', col: 'party' }, { app: 'mode', col: 'mode' },
      { app: 'referenceNo', col: 'reference_no' }, { app: 'description', col: 'description' }, { app: 'addedBy', col: 'added_by' },
      { app: 'voided', col: 'voided' }, { app: 'voidReason', col: 'void_reason' },
      { app: 'voidedBy', col: 'voided_by' }, { app: 'voidedAt', col: 'voided_at' },
    ],
  },
};

const HYBRID_RESOURCES = {
  students: {
    table: 'students',
    // Opts this one resource into handleHybrid's soft-delete path (see
    // below) — every other hybrid resource keeps its existing hard DELETE
    // unchanged, since this fix is scoped to the two record types a real
    // incident actually happened to (students, and users just below).
    softDelete: true,
    core: [
      { app: 'id', col: 'id' }, { app: 'firstName', col: 'first_name' }, { app: 'lastName', col: 'last_name' },
      { app: 'className', col: 'class_name' }, { app: 'section', col: 'section' }, { app: 'status', col: 'status' },
      { app: 'admissionNo', col: 'admission_no' },
    ],
  },
  staff: {
    table: 'staff',
    core: [
      { app: 'id', col: 'id' }, { app: 'firstName', col: 'first_name' }, { app: 'lastName', col: 'last_name' },
      { app: 'department', col: 'department' }, { app: 'designation', col: 'designation' },
      { app: 'status', col: 'status' }, { app: 'staffId', col: 'staff_id' },
    ],
  },
  'staff-payroll': {
    table: 'staff_payroll',
    core: [
      { app: 'id', col: 'id' }, { app: 'staffId', col: 'staff_id' }, { app: 'month', col: 'month' },
      { app: 'status', col: 'status' },
    ],
  },
  // Notice Board / Communications messages — shape varies quite a bit record to
  // record (a "channels" array, an optional "boardRemoved" flag, etc.), so only
  // "id" is a real column; everything else rides in "extra" like the fields above.
  'comms-messages': {
    table: 'comms_messages',
    core: [{ app: 'id', col: 'id' }],
  },
  // Exam room master list (name/capacity) and per-student hall ticket numbers —
  // both are small, free-form records, so only "id" is a real column.
  rooms: {
    table: 'rooms',
    core: [{ app: 'id', col: 'id' }],
  },
  'exam-hall-tickets': {
    table: 'exam_hall_tickets',
    core: [{ app: 'id', col: 'id' }],
  },
  // Per-exam Room Allotment settings (which classes are in scope, print
  // orientation/page size) — one small record per exam, keyed by examId.
  'exam-room-config': {
    table: 'exam_room_config',
    core: [{ app: 'id', col: 'id' }],
  },
};

// ---------- Server-side enforcement of Roles & Permissions ----------
// Until now, the Roles & Permissions matrix (index.html: PERMISSION_MODULES /
// ROLE_VIEWS / custom_roles) only ever controlled what the BROWSER shows —
// hiding a sidebar button never stopped that same role from calling the API
// underneath it directly. This closes that gap.
//
// Deliberately scoped, to keep this safe to ship on a live school database:
//  - Enforcement happens only at the TOP-LEVEL module granularity that
//    ROLE_VIEWS/the sidebar itself uses — never the finer per-action
//    (view/create/edit/delete/print/approve) checks or the bespoke
//    sub-module fallback helpers (getAccountingTabAccess, getResultTabAccess,
//    etc.) the admin UI also exposes. A resource that really belongs to a
//    sub-module is checked against that sub-module's PARENT module instead —
//    the same coarse fallback those client helpers already use when no
//    explicit override exists for the sub-module itself. Where one resource
//    legitimately feeds more than one module's screen (e.g. exam-results
//    backs both Manage Exams and Result), access to EITHER is enough.
//  - A role with NO saved custom_roles override behaves EXACTLY as it does
//    today (SERVER_ROLE_VIEWS defaults below, copied from ROLE_VIEWS) —
//    enforcement only ever *tightens* access, and only once an admin has
//    explicitly customized that role in Roles & Permissions. No school that
//    hasn't touched that screen sees any behavior change.
//  - "Fail open": a resource or kv key with no explicit entry in
//    RESOURCE_TO_MODULE/KV_KEY_TO_MODULE below is left completely
//    unrestricted, exactly as before this change, rather than guessed at.
//  - 'users' and 'roles' are hard-locked to the built-in Admin role,
//    unconditionally — mirroring LOCKED_ADMIN_ONLY_PAGES on the client,
//    since these control who can log in and the permission system itself
//    and must never be delegable through any override.

// Mirrors ROLE_VIEWS in index.html — keep the two in sync. This is the
// fallback used whenever a role has no saved override for a given module.
const SERVER_ROLE_VIEWS = {
  Admin: ['dashboard','admissions','managefee','attendance','exams','subjects','promotransfer','result','staff','accounting','announcements','inbox','noticeboard','websiteinquiries','websitegallery','contactvendor','reports','inventory','timetable','syllabus','transport','library','hostel','setup'],
  Principal: ['dashboard','admissions','managefee','attendance','exams','subjects','promotransfer','result','staff','accounting','announcements','inbox','noticeboard','websiteinquiries','websitegallery','contactvendor','reports','inventory','timetable','syllabus','transport','library','hostel','setup'],
  Accountant: ['dashboard','admissions','managefee','accounting','reports','inventory','transport'],
  'Office Assistant': ['admissions'],
  Teacher: ['admissions','attendance','exams','subjects','result','timetable','syllabus','library','announcements','inbox'],
  Staff: ['admissions','attendance','inbox'],
  Student: ['myprofile'],
  Parent: ['myprofile'],
};

// A role's saved override permissions object, straight from custom_roles —
// undefined if none saved. Student/Parent never participate in overrides
// (mirrors findRoleOverride() in index.html: their "My Portal" access isn't
// expressible as a module grant, so a custom override never widens or
// narrows it).
async function getRoleOverride(role) {
  if (role === 'Student' || role === 'Parent') return undefined;
  const rows = await sql`SELECT permissions FROM custom_roles WHERE name = ${role} LIMIT 1`;
  return rows.length ? rows[0].permissions : undefined;
}

// Every resource name (SIMPLE_RESOURCES / HYBRID_RESOURCES / the custom
// handlers below) mapped to the top-level PERMISSION_MODULES key(s) that
// gate it. Resources not listed here are unrestricted (fail open).
const RESOURCE_TO_MODULE = {
  // Finance
  payments: ['managefee'],
  discounts: ['managefee'],
  'extra-fees': ['managefee'],
  'fee-structure': ['managefee'],
  'acct-income': ['accounting'],
  'acct-expenses': ['accounting'],
  // Academics
  attendance: ['attendance'],
  holidays: ['attendance'],
  'attendance-settings': ['attendance'],
  'staff-attendance': ['staff', 'attendance'],
  'exam-results': ['exams', 'result'],
  'exam-defs': ['exams'],
  subjects: ['subjects'],
  rooms: ['result'],
  'exam-hall-tickets': ['result'],
  'exam-room-config': ['result'],
  // People
  students: ['admissions'],
  // Admission inquiries are the public website's "Admissions Inquiry Form"
  // submissions, reviewed under Website Inquiries in the sidebar (see
  // canDo('websiteinquiries', ...) in renderAdmissionInquiries) — NOT the
  // Manage Student module, despite the resource's name.
  'admission-inquiries': ['websiteinquiries'],
  staff: ['staff'],
  'staff-payroll': ['staff'],
  // Communication
  'comms-messages': ['announcements'],
  'website-gallery': ['websitegallery'],
  // Setup
  'school-info': ['setup'],
};

// Same idea, for the generic /api/kv/:key store — every kv_store key that's
// actually a school-data settings blob (as opposed to internal plumbing),
// mapped to the module(s) whose screen reads/writes it.
const KV_KEY_TO_MODULE = {
  'finance-settings': ['managefee'],
  'fee-types': ['managefee'],
  'discount-types': ['managefee'],
  'extra-fee-defs': ['managefee'],
  'late-fee-settings': ['managefee'],
  'receipt-settings': ['managefee'],
  'grading-scale': ['exams', 'result'],
  'exam-types': ['exams', 'result'],
  'exam-groups': ['exams', 'result'],
  'consolidation-scale': ['exams', 'result'],
  'exam-holidays': ['exams', 'result'],
  'report-templates': ['exams', 'result'],
  'staff-departments': ['staff'],
  'staff-designations': ['staff'],
  'staff-job-types': ['staff'],
  'inventory-items': ['inventory'],
  'inventory-sales': ['inventory'],
  'inventory-returns': ['inventory'],
  'inventory-vendor-returns': ['inventory'],
  'timetable-entries': ['timetable'],
  'timetable-periods': ['timetable'],
  'timetable-days': ['timetable'],
  'syllabus-topics': ['syllabus'],
  'homework-items': ['syllabus'],
  'transport-routes': ['transport'],
  'library-books': ['library'],
  'library-issues': ['library'],
  'library-settings': ['library'],
  'hostel-rooms': ['hostel'],
  'acct-expense-categories': ['accounting'],
  'acct-income-categories': ['accounting'],
  'acct-cost-centers': ['accounting'],
  'notice-types': ['announcements'],
  'academic-years': ['setup'],
  'current-academic-year': ['setup'],
  'class-levels': ['setup'],
  'section-levels': ['setup'],
  'class-section-overrides': ['setup'],
  // Feeds both the Inventory "Approvals" tab and Promotion & Transfer's
  // "Approve Requests" tab — either module's access is enough.
  'pending-approvals': ['inventory', 'promotransfer'],
  // 'admin-downloads' is deliberately absent here — that screen is
  // hard-locked to Admin only (see adminOnlyPages/'admintools2' on the
  // client), enforced directly in handleKv below, not through this table.
};
const ADMIN_ONLY_KV_KEYS = ['admin-downloads'];

// Does `role` have "view" access to ANY of `moduleKeys`? Mirrors
// getRoleViews()'s per-module test in index.html: an explicit saved choice
// for that module wins, otherwise fall back to the role's built-in default.
// Sends the 403 itself on failure so call sites can just `if (!ok) return;`.
async function checkModuleAccess(req, res, moduleKeys) {
  if (!req.authUser) return true; // unauthenticated (public) routes have nothing to check
  if (req.authUser.role === 'Admin') return true; // Admin is always the ceiling — never restricted
  const override = await getRoleOverride(req.authUser.role);
  const defaults = SERVER_ROLE_VIEWS[req.authUser.role] || [];
  const ok = moduleKeys.some(key => (override && override[key] !== undefined) ? !!override[key].view : defaults.includes(key));
  if (!ok) res.status(403).json({ error: 'You do not have permission to access this.' });
  return ok;
}

// ---------- Plan/Modules gating (billing-driven — separate from Roles & Permissions above) ----------
// The vendor dashboard's "Plan" field (Schools tab → edit a school → Plan)
// lets the vendor sell a school only some modules — see vendor-reporting.js's
// getModuleAccess() for how that's mapped down from the dashboard's 4
// billing buckets to this ERP's own module keys. Only these 6 keys are ever
// part of a Plan; anything else (dashboard, admissions, staff, accounting,
// setup, announcements, etc.) is core and never gated by Plan, regardless of
// which modules a school picked.
const PLAN_GATED_MODULE_KEYS = ['managefee', 'attendance', 'exams', 'result', 'transport', 'library'];

// Same call-site shape as checkModuleAccess (sends its own 403 and returns a
// boolean) but a completely separate axis: this checks what the SCHOOL paid
// for, not what the ROLE is allowed to see, so — unlike checkModuleAccess —
// it applies to every role, Admin included (a school that didn't pay for
// Exams doesn't get it back just because the person asking is the school's
// own Admin). The one exception is a Vendor Support session (see
// vendor-support-login.js) — that's the vendor's own troubleshooting login,
// never the school's, and must never be blocked by the school's own plan.
async function checkPlanModuleAccess(req, res, moduleKeys) {
  if (!req.authUser || req.authUser.id === 'vendor-support') return true;
  const gatedKeys = moduleKeys.filter(k => PLAN_GATED_MODULE_KEYS.includes(k));
  if (!gatedKeys.length) return true; // not part of any Plan bucket — always included
  const access = getModuleAccess();
  if (!access.restricted) return true; // no Plan set, an "All Modules" Plan, or not yet confirmed by a heartbeat — fail open
  const ok = gatedKeys.some(k => access.enabledKeys.includes(k));
  if (!ok) {
    res.status(403).json({
      error: "This module isn't included in your school's current plan. Please contact SVM EdTech to add it.",
      planRestricted: true,
    });
  }
  return ok;
}

// ---------- Generic helpers for "simple" resources ----------
// Postgres NUMERIC columns come back from this driver as strings, not JS
// numbers — arbitrary-precision decimals can't always be represented as a
// float, so the driver plays it safe and hands back text (this is also why
// handleFeeStructure and handleAttendanceSettings below already wrap their
// NUMERIC columns in Number()). Every field marked `numeric: true` here
// gets the same treatment, so a caller doing `total += row.amount` gets a
// real sum instead of silently concatenating strings — exactly what was
// happening to exam marks totals in report cards before this. Null stays
// null (a real "not entered yet"/absent marker) rather than becoming 0.
function simpleToAppShape(row, fields) {
  const out = {};
  fields.forEach(f => {
    let v = row[f.col];
    if (v && typeof v === 'object' && v instanceof Date) v = v.toISOString().slice(0, 10);
    else if (f.numeric && v !== null && v !== undefined) v = Number(v);
    out[f.app] = v;
  });
  return out;
}
// Fire-and-forget dispatch to the notify* functions defined in the
// "Notifications" section further down (hoisted function declarations, so
// the definition order here doesn't matter — these only ever actually run
// once a real request comes in, long after the whole module has loaded).
// Deliberately not awaited by any caller: a slow or failing push/WhatsApp
// send must never add latency to — or fail — the write itself.
function notifyAfterResourceWrite(resourceName, body) {
  if (resourceName === 'payments') {
    notifyFeePayment({ studentId: body.studentId, amount: body.amount, mode: body.mode, receiptNo: body.receiptNo })
      .catch(err => console.error('fee payment notification failed:', err));
  } else if (resourceName === 'attendance') {
    notifyAttendanceEvent({ studentId: body.studentId, date: body.date, status: body.status })
      .catch(err => console.error('attendance notification failed:', err));
  } else if (resourceName === 'exam-results') {
    notifyMarksIfComplete({ examId: body.examId, studentId: body.studentId })
      .catch(err => console.error('marks notification failed:', err));
  }
}
async function handleSimple(req, res, config, resourceName) {
  const { table, fields } = config;
  if (req.method === 'GET') {
    const rows = await sql.query(`SELECT * FROM ${table} ORDER BY created_at ASC NULLS LAST`);
    return res.status(200).json(rows.map(r => simpleToAppShape(r, fields)));
  }
  if (req.method === 'POST' || req.method === 'PUT') {
    const body = req.body || {};
    if (!body.id) return res.status(400).json({ error: 'Missing id.' });
    const cols = fields.map(f => f.col);
    const vals = fields.map(f => (body[f.app] === undefined ? null : body[f.app]));
    if (req.method === 'POST') {
      const placeholders = cols.map((_, i) => `$${i + 1}`).join(', ');
      await sql.query(`INSERT INTO ${table} (${cols.join(', ')}) VALUES (${placeholders})`, vals);
      notifyAfterResourceWrite(resourceName, body);
      return res.status(201).json({ ok: true });
    } else {
      const setClause = cols.filter(c => c !== 'id').map((c, i) => `${c} = $${i + 2}`).join(', ');
      const updateVals = [body.id, ...fields.filter(f => f.col !== 'id').map(f => (body[f.app] === undefined ? null : body[f.app]))];
      await sql.query(`UPDATE ${table} SET ${setClause} WHERE id = $1`, updateVals);
      notifyAfterResourceWrite(resourceName, body);
      return res.status(200).json({ ok: true });
    }
  }
  if (req.method === 'DELETE') {
    const { id } = req.query;
    if (!id) return res.status(400).json({ error: 'Missing id.' });
    await sql.query(`DELETE FROM ${table} WHERE id = $1`, [id]);
    return res.status(200).json({ ok: true });
  }
  return res.status(405).json({ error: 'Method not allowed.' });
}

// The `users` resource needs its own version of the above rather than going
// through the generic handleSimple(): it's the one resource with a password
// field, which has two rules nothing else needs — GET must never send it
// back (hashed or not, the browser has no legitimate use for it), and a
// PUT that doesn't include a new one must leave the existing hash alone
// instead of overwriting it with null the way handleSimple's generic
// "missing field → null" behavior would (every edit to a user's name,
// role, etc. goes through the same PUT the client already used before this
// change, and the client can no longer echo back a password it was never
// given in the first place).
async function handleUsers(req, res) {
  const config = SIMPLE_RESOURCES.users;
  const { table, fields } = config;
  if (req.method === 'GET') {
    // ?trash=1 lists soft-deleted accounts for the Recently Deleted view
    // instead of the normal active roster — Admin-only, same as this whole
    // resource already is (see the resource==='users' gate further up).
    const trashMode = req.query.trash === '1';
    if (trashMode && (!req.authUser || req.authUser.role !== 'Admin')) {
      return res.status(403).json({ error: 'Admin access required.' });
    }
    const rows = await sql.query(
      `SELECT * FROM ${table} WHERE deleted_at IS ${trashMode ? 'NOT NULL' : 'NULL'} ORDER BY created_at ASC NULLS LAST`
    );
    return res.status(200).json(rows.map(r => {
      const shaped = simpleToAppShape(r, fields);
      delete shaped.password;
      return shaped;
    }));
  }
  if (req.method === 'POST' || req.method === 'PUT') {
    // A restore is a bodyless PUT carrying ?restore=1 — the mirror image of
    // the soft delete below, just clearing deleted_at back to NULL.
    if (req.method === 'PUT' && req.query.restore === '1') {
      if (!req.authUser || req.authUser.role !== 'Admin') {
        return res.status(403).json({ error: 'Admin access required.' });
      }
      const { id } = req.query;
      if (!id) return res.status(400).json({ error: 'Missing id.' });
      await sql`UPDATE users SET deleted_at = NULL WHERE id = ${id}`;
      return res.status(200).json({ ok: true });
    }
    const body = { ...(req.body || {}) };
    if (!body.id) return res.status(400).json({ error: 'Missing id.' });
    if (req.method === 'POST') {
      if (!body.password) return res.status(400).json({ error: 'Password is required for a new user.' });
      body.password = await bcrypt.hash(String(body.password), 10);
    } else if (body.password) {
      body.password = await bcrypt.hash(String(body.password), 10);
    } else {
      const existing = await sql`SELECT password FROM users WHERE id = ${body.id}`;
      body.password = existing.length ? existing[0].password : null;
    }
    const cols = fields.map(f => f.col);
    const vals = fields.map(f => (body[f.app] === undefined ? null : body[f.app]));
    if (req.method === 'POST') {
      const placeholders = cols.map((_, i) => `$${i + 1}`).join(', ');
      await sql.query(`INSERT INTO ${table} (${cols.join(', ')}) VALUES (${placeholders})`, vals);
      return res.status(201).json({ ok: true });
    } else {
      const setClause = cols.filter(c => c !== 'id').map((c, i) => `${c} = $${i + 2}`).join(', ');
      const updateVals = [body.id, ...fields.filter(f => f.col !== 'id').map(f => (body[f.app] === undefined ? null : body[f.app]))];
      await sql.query(`UPDATE ${table} SET ${setClause} WHERE id = $1`, updateVals);
      return res.status(200).json({ ok: true });
    }
  }
  if (req.method === 'DELETE') {
    const { id } = req.query;
    if (!id) return res.status(400).json({ error: 'Missing id.' });
    // Three guards added after a real incident: deleting your own
    // currently-logged-in account left that session looking "still logged
    // in" until it expired on its own (nothing previously re-checked the
    // user still existed mid-session); deleting the last remaining Admin
    // would lock everyone out with no way back in; and a hard DELETE gave
    // no way to undo either mistake. Soft delete plus an immediate session
    // wipe closes all three at once.
    if (req.authUser && String(req.authUser.id) === String(id)) {
      return res.status(400).json({ error: "You can't delete your own account while logged in as it. Log in as a different Admin first." });
    }
    const target = await sql`SELECT role FROM users WHERE id = ${id} AND deleted_at IS NULL`;
    if (!target.length) return res.status(404).json({ error: 'User not found.' });
    if (target[0].role === 'Admin') {
      const activeAdmins = await sql`SELECT count(*)::int AS c FROM users WHERE role = 'Admin' AND deleted_at IS NULL`;
      if (activeAdmins[0].c <= 1) {
        return res.status(400).json({ error: "You can't delete the last remaining Admin account — create another Admin first." });
      }
    }
    await sql`UPDATE users SET deleted_at = now() WHERE id = ${id}`;
    // Whatever session(s) this account is signed in on, elsewhere or right
    // now, stop working on their very next request instead of coasting on
    // a stale cookie until it naturally times out.
    await sql`DELETE FROM sessions WHERE user_id = ${id}`;
    return res.status(200).json({ ok: true });
  }
  return res.status(405).json({ error: 'Method not allowed.' });
}

// ---------- Generic helpers for "hybrid" (core + JSONB extra) resources ----------
function hybridToAppShape(row, core) {
  const out = {};
  core.forEach(f => { out[f.app] = row[f.col]; });
  return { ...out, ...(row.extra || {}) };
}
function splitCoreExtra(body, core) {
  const coreAppKeys = core.map(f => f.app);
  const extra = {};
  Object.keys(body).forEach(k => { if (!coreAppKeys.includes(k)) extra[k] = body[k]; });
  const coreVals = {};
  core.forEach(f => { coreVals[f.app] = body[f.app] !== undefined ? body[f.app] : (f.app === 'status' ? 'Active' : ''); });
  return { coreVals, extra };
}
async function handleHybrid(req, res, config) {
  const { table, core, softDelete } = config;
  if (req.method === 'GET') {
    // ?trash=1 (Admin/Principal only) lists soft-deleted records for the
    // Recently Deleted view — only meaningful for a resource that opted
    // into softDelete (see HYBRID_RESOURCES.students above); every other
    // hybrid resource ignores the query param entirely, unchanged.
    const trashMode = softDelete && req.query.trash === '1';
    if (trashMode && (!req.authUser || !MANAGEMENT_ROLES.includes(req.authUser.role))) {
      return res.status(403).json({ error: 'Admin or Principal access required to view deleted records.' });
    }
    const whereClause = softDelete ? `WHERE deleted_at IS ${trashMode ? 'NOT NULL' : 'NULL'}` : '';
    const rows = await sql.query(`SELECT * FROM ${table} ${whereClause} ORDER BY created_at ASC NULLS LAST`);
    return res.status(200).json(rows.map(r => hybridToAppShape(r, core)));
  }
  if (req.method === 'POST' || req.method === 'PUT') {
    // A restore is a bodyless PUT carrying ?restore=1 — mirrors handleUsers.
    if (softDelete && req.method === 'PUT' && req.query.restore === '1') {
      if (!req.authUser || !MANAGEMENT_ROLES.includes(req.authUser.role)) {
        return res.status(403).json({ error: 'Admin or Principal access required to restore a deleted record.' });
      }
      const { id } = req.query;
      if (!id) return res.status(400).json({ error: 'Missing id.' });
      await sql.query(`UPDATE ${table} SET deleted_at = NULL WHERE id = $1`, [id]);
      return res.status(200).json({ ok: true });
    }
    const body = req.body || {};
    if (!body.id) return res.status(400).json({ error: 'Missing id.' });
    const { coreVals, extra } = splitCoreExtra(body, core);
    const cols = core.map(f => f.col);
    const vals = core.map(f => coreVals[f.app]);
    if (req.method === 'POST') {
      const placeholders = cols.map((_, i) => `$${i + 1}`).join(', ');
      await sql.query(
        `INSERT INTO ${table} (${cols.join(', ')}, extra) VALUES (${placeholders}, $${cols.length + 1}::jsonb)`,
        [...vals, JSON.stringify(extra)]
      );
      return res.status(201).json({ ok: true });
    } else {
      const setClause = cols.filter(c => c !== 'id').map((c, i) => `${c} = $${i + 2}`).join(', ');
      const nonIdVals = core.filter(f => f.col !== 'id').map(f => coreVals[f.app]);
      await sql.query(
        `UPDATE ${table} SET ${setClause}, extra = $${nonIdVals.length + 2}::jsonb WHERE id = $1`,
        [body.id, ...nonIdVals, JSON.stringify(extra)]
      );
      return res.status(200).json({ ok: true });
    }
  }
  if (req.method === 'DELETE') {
    const { id } = req.query;
    if (!id) return res.status(400).json({ error: 'Missing id.' });
    if (softDelete) {
      await sql.query(`UPDATE ${table} SET deleted_at = now() WHERE id = $1`, [id]);
    } else {
      await sql.query(`DELETE FROM ${table} WHERE id = $1`, [id]);
    }
    return res.status(200).json({ ok: true });
  }
  return res.status(405).json({ error: 'Method not allowed.' });
}

// ---------- Custom per-resource handlers ----------
async function handleSubjects(req, res) {
  if (req.method === 'GET') {
    const rows = await sql`SELECT * FROM subjects ORDER BY created_at ASC`;
    return res.status(200).json(rows.map(r => ({
      id: r.id, name: r.name, code: r.code || '', className: r.class_name,
      sections: r.sections || [], sectionStaff: r.section_staff || {}, staffIds: r.staff_ids || [],
      countable: r.countable, elective: r.elective,
    })));
  }
  if (req.method === 'POST') {
    const s = req.body;
    if (!s.id || !s.name || !s.className) return res.status(400).json({ error: 'Missing required fields.' });
    await sql`
      INSERT INTO subjects (id, name, code, class_name, sections, section_staff, staff_ids, countable, elective)
      VALUES (${s.id}, ${s.name}, ${s.code || ''}, ${s.className}, ${JSON.stringify(s.sections || [])}::jsonb,
              ${JSON.stringify(s.sectionStaff || {})}::jsonb, ${JSON.stringify(s.staffIds || [])}::jsonb,
              ${s.countable !== false}, ${!!s.elective})
    `;
    return res.status(201).json({ ok: true });
  }
  if (req.method === 'PUT') {
    const s = req.body;
    if (!s.id) return res.status(400).json({ error: 'Missing id.' });
    await sql`
      UPDATE subjects SET name = ${s.name}, code = ${s.code || ''}, class_name = ${s.className},
        sections = ${JSON.stringify(s.sections || [])}::jsonb, section_staff = ${JSON.stringify(s.sectionStaff || {})}::jsonb,
        staff_ids = ${JSON.stringify(s.staffIds || [])}::jsonb, countable = ${s.countable !== false}, elective = ${!!s.elective}
      WHERE id = ${s.id}
    `;
    return res.status(200).json({ ok: true });
  }
  if (req.method === 'DELETE') {
    const { id } = req.query;
    if (!id) return res.status(400).json({ error: 'Missing id.' });
    await sql`DELETE FROM subjects WHERE id = ${id}`;
    return res.status(200).json({ ok: true });
  }
  return res.status(405).json({ error: 'Method not allowed.' });
}

async function handleExamDefs(req, res) {
  if (req.method === 'GET') {
    const rows = await sql`SELECT * FROM exam_defs ORDER BY created_at ASC`;
    return res.status(200).json(rows.map(r => ({
      id: r.id, name: r.name, examType: r.exam_type,
      startDate: r.start_date ? r.start_date.toISOString().slice(0, 10) : '',
      endDate: r.end_date ? r.end_date.toISOString().slice(0, 10) : '',
      classSubjects: r.class_subjects || {},
    })));
  }
  if (req.method === 'POST') {
    const e = req.body;
    if (!e.id || !e.name) return res.status(400).json({ error: 'Missing required fields.' });
    await sql`
      INSERT INTO exam_defs (id, name, exam_type, start_date, end_date, class_subjects)
      VALUES (${e.id}, ${e.name}, ${e.examType}, ${e.startDate || null}, ${e.endDate || null}, ${JSON.stringify(e.classSubjects || {})}::jsonb)
    `;
    return res.status(201).json({ ok: true });
  }
  if (req.method === 'PUT') {
    const e = req.body;
    if (!e.id) return res.status(400).json({ error: 'Missing id.' });
    await sql`
      UPDATE exam_defs SET name = ${e.name}, exam_type = ${e.examType}, start_date = ${e.startDate || null},
        end_date = ${e.endDate || null}, class_subjects = ${JSON.stringify(e.classSubjects || {})}::jsonb
      WHERE id = ${e.id}
    `;
    return res.status(200).json({ ok: true });
  }
  if (req.method === 'DELETE') {
    const { id } = req.query;
    if (!id) return res.status(400).json({ error: 'Missing id.' });
    await sql`DELETE FROM exam_defs WHERE id = ${id}`;
    return res.status(200).json({ ok: true });
  }
  return res.status(405).json({ error: 'Method not allowed.' });
}

async function handleRoles(req, res) {
  if (req.method === 'GET') {
    const rows = await sql`SELECT * FROM custom_roles ORDER BY created_at ASC`;
    return res.status(200).json(rows.map(r => ({ id: r.id, name: r.name, permissions: r.permissions })));
  }
  if (req.method === 'POST') {
    const r = req.body;
    if (!r.id || !r.name) return res.status(400).json({ error: 'Missing required fields.' });
    await sql`INSERT INTO custom_roles (id, name, permissions) VALUES (${r.id}, ${r.name}, ${JSON.stringify(r.permissions || {})}::jsonb)`;
    return res.status(201).json({ ok: true });
  }
  if (req.method === 'PUT') {
    const r = req.body;
    if (!r.id) return res.status(400).json({ error: 'Missing id.' });
    await sql`UPDATE custom_roles SET name = ${r.name}, permissions = ${JSON.stringify(r.permissions || {})}::jsonb WHERE id = ${r.id}`;
    return res.status(200).json({ ok: true });
  }
  if (req.method === 'DELETE') {
    const { id } = req.query;
    if (!id) return res.status(400).json({ error: 'Missing id.' });
    await sql`DELETE FROM custom_roles WHERE id = ${id}`;
    return res.status(200).json({ ok: true });
  }
  return res.status(405).json({ error: 'Method not allowed.' });
}

async function handleFeeStructure(req, res) {
  if (req.method === 'GET') {
    const rows = await sql`SELECT * FROM fee_structure`;
    const obj = {};
    rows.forEach(r => { obj[r.class_name] = { admission: Number(r.admission), fee: Number(r.fee), bus: Number(r.bus), stock: Number(r.stock) }; });
    return res.status(200).json(obj);
  }
  if (req.method === 'PUT') {
    const structure = req.body || {};
    for (const [className, rates] of Object.entries(structure)) {
      await sql`
        INSERT INTO fee_structure (class_name, admission, fee, bus, stock)
        VALUES (${className}, ${rates.admission || 0}, ${rates.fee || 0}, ${rates.bus || 0}, ${rates.stock || 0})
        ON CONFLICT (class_name) DO UPDATE SET admission = ${rates.admission || 0}, fee = ${rates.fee || 0}, bus = ${rates.bus || 0}, stock = ${rates.stock || 0}
      `;
    }
    return res.status(200).json({ ok: true });
  }
  return res.status(405).json({ error: 'Method not allowed.' });
}

async function handleSchoolInfo(req, res) {
  if (req.method === 'GET') {
    const rows = await sql`SELECT data FROM school_info WHERE id = 1`;
    if (rows.length === 0) return res.status(200).json({});
    return res.status(200).json(rows[0].data || {});
  }
  if (req.method === 'PUT') {
    const info = req.body || {};
    await sql`
      INSERT INTO school_info (id, data) VALUES (1, ${JSON.stringify(info)}::jsonb)
      ON CONFLICT (id) DO UPDATE SET data = ${JSON.stringify(info)}::jsonb
    `;
    return res.status(200).json({ ok: true });
  }
  return res.status(405).json({ error: 'Method not allowed.' });
}

async function handleAttendanceSettings(req, res) {
  if (req.method === 'GET') {
    const rows = await sql`SELECT * FROM attendance_settings WHERE id = 1`;
    if (rows.length === 0) return res.status(200).json({});
    return res.status(200).json({ threshold: Number(rows[0].threshold), workingDays: rows[0].working_days });
  }
  if (req.method === 'PUT') {
    const s = req.body || {};
    await sql`
      INSERT INTO attendance_settings (id, threshold, working_days)
      VALUES (1, ${s.threshold || 75}, ${JSON.stringify(s.workingDays || [1,2,3,4,5,6])}::jsonb)
      ON CONFLICT (id) DO UPDATE SET threshold = ${s.threshold || 75}, working_days = ${JSON.stringify(s.workingDays || [1,2,3,4,5,6])}::jsonb
    `;
    return res.status(200).json({ ok: true });
  }
  return res.status(405).json({ error: 'Method not allowed.' });
}

// ---------- Online fee payment (Razorpay) ----------
// Two-step flow, standard for Razorpay: the browser asks us to open an "order"
// for a specific amount, Razorpay's own checkout popup collects the
// card/UPI/netbanking details directly (this server — and the rest of this
// codebase — never sees a card number or bank detail), and finally the
// browser reports back that it succeeded, which we verify ourselves against
// the signature Razorpay signs before trusting it and recording a payment.
// Reads RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET from Render's environment —
// set those in Render → this service → Environment once you have a Razorpay
// account; until then these routes reply 501 and the "Pay Online" button
// tells the parent to pay at the office instead.
function razorpayConfigured() {
  return !!(process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET);
}
app.post('/api/payments/create-order', async (req, res) => {
  try {
    if (!razorpayConfigured()) {
      return res.status(501).json({ error: 'Online payments are not set up yet. Ask your Admin to add a Razorpay account.' });
    }
    const amount = Number(req.body?.amount);
    if (!amount || amount <= 0) return res.status(400).json({ error: 'Invalid amount.' });
    const auth = Buffer.from(`${process.env.RAZORPAY_KEY_ID}:${process.env.RAZORPAY_KEY_SECRET}`).toString('base64');
    const rzRes = await fetch('https://api.razorpay.com/v1/orders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Basic ${auth}` },
      body: JSON.stringify({
        amount: Math.round(amount * 100), // Razorpay wants paise, not rupees
        currency: 'INR',
        receipt: 'fee_' + Date.now(),
      }),
    });
    const order = await rzRes.json();
    if (!rzRes.ok) {
      console.error('razorpay create-order failed:', order);
      return res.status(502).json({ error: order?.error?.description || 'Could not start the payment.' });
    }
    return res.status(200).json({ orderId: order.id, amount: order.amount, currency: order.currency, keyId: process.env.RAZORPAY_KEY_ID });
  } catch (err) {
    console.error('razorpay create-order error:', err);
    return res.status(500).json({ error: 'Could not start the payment. Please try again.' });
  }
});
app.post('/api/payments/verify', async (req, res) => {
  try {
    if (!razorpayConfigured()) {
      return res.status(501).json({ error: 'Online payments are not set up yet.' });
    }
    const {
      razorpay_order_id, razorpay_payment_id, razorpay_signature,
      studentId, studentName, amount, category, classAtPayment, extraFeeName, extraFeeId,
    } = req.body || {};
    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature || !studentId || !amount) {
      return res.status(400).json({ error: 'Missing payment details.' });
    }
    const expected = crypto.createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
      .update(`${razorpay_order_id}|${razorpay_payment_id}`)
      .digest('hex');
    if (expected !== razorpay_signature) {
      return res.status(400).json({ error: 'Payment verification failed — this does not look like a genuine Razorpay confirmation.' });
    }
    // Signature checks out against our own secret, so Razorpay itself vouches this
    // payment happened — safe to record it as a real payment now.
    const id = 'pay_' + Date.now() + '_' + razorpay_payment_id;
    await sql`
      INSERT INTO payments (id, receipt_no, student_id, student_name, category, mode, amount, discount, instalment, date, note, class_at_payment, extra_fee_name, extra_fee_id)
      VALUES (
        ${id}, ${razorpay_payment_id}, ${studentId}, ${studentName || ''}, ${category || 'fee'}, 'Online',
        ${amount}, 0, '', ${new Date().toISOString().slice(0, 10)}, ${'Paid online via Razorpay — ' + razorpay_payment_id},
        ${classAtPayment || ''}, ${extraFeeName || null}, ${extraFeeId || null}
      )
    `;
    notifyFeePayment({ studentId, amount, category: category || 'fee', mode: 'Online', receiptNo: razorpay_payment_id })
      .catch(err => console.error('fee payment notification failed:', err));
    return res.status(200).json({ ok: true, paymentId: id, receiptNo: razorpay_payment_id });
  } catch (err) {
    console.error('razorpay verify error:', err);
    return res.status(500).json({ error: 'Payment succeeded but we could not record it — please contact the school office with your payment ID.' });
  }
});

// Whether this school has online fee payment turned on at all — the deploy-
// time choice this template is built around. A school that doesn't want to
// offer it (or hasn't signed up for Razorpay yet) is simply never given
// RAZORPAY_KEY_ID/RAZORPAY_KEY_SECRET when this service is set up; every
// other route above already refuses to work without them, but until now the
// Student/Parent "Pay Online" button still showed up and only failed once
// clicked. The Fees tab calls this first so it can hide the button entirely
// for a school that hasn't integrated the feature, instead of offering a
// dead end. Deliberately just a boolean — never leaks which keys are set.
app.get('/api/payments/status', (req, res) => {
  return res.status(200).json({ enabled: razorpayConfigured() });
});

// ---------- Notifications: Web Push (on by default) + WhatsApp (opt-in per school) ----------
// Web Push needs no third-party account — just a VAPID key pair this
// school generates once (see INSTALL notes) and sets as VAPID_PUBLIC_KEY /
// VAPID_PRIVATE_KEY / VAPID_SUBJECT on Render → Environment, same pattern
// as Razorpay above. Until those are set, webPushConfigured() is false and
// every notify* function below silently no-ops on the push side — nothing
// breaks, parents just don't get a browser/PWA notification yet.
function webPushConfigured() {
  return !!(process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY);
}
if (webPushConfigured()) {
  webpush.setVapidDetails(
    process.env.VAPID_SUBJECT || 'mailto:admin@example.com',
    process.env.VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY
  );
}
// WhatsApp is a separate, explicitly opt-in integration — real money and a
// real Meta Business + WhatsApp Business Account per school, unlike Web
// Push. Until WHATSAPP_PHONE_NUMBER_ID / WHATSAPP_ACCESS_TOKEN are set on
// Render, whatsappConfigured() is false and this school just keeps using
// the existing manual "click to open WhatsApp" flow (Notify Parents /
// Notify Below Threshold) — nothing here replaces that, it only adds an
// automatic send on top once a school actually wants it. Message
// *content* still has to be a template pre-approved in Meta Business
// Manager (Meta requires that for any business-initiated message outside
// a 24-hour customer reply window) — the env vars below let a school point
// at whatever name they got approved, without a code change.
function whatsappConfigured() {
  return !!(process.env.WHATSAPP_PHONE_NUMBER_ID && process.env.WHATSAPP_ACCESS_TOKEN);
}
const WHATSAPP_DEFAULT_TEMPLATES = {
  FEE_PAYMENT: 'fee_payment_confirmation',
  FEE_DUE_BEFORE: 'fee_due_reminder',
  FEE_DUE_AFTER: 'fee_overdue_reminder',
  MARKS_PUBLISHED: 'marks_published',
  ATTENDANCE_ALERT: 'attendance_alert',
};
async function sendWhatsAppTemplate(toPhoneDigits, templateKind, params) {
  if (!whatsappConfigured() || !toPhoneDigits) return;
  // Meta wants the recipient in international format with no leading "+"
  // or punctuation. A 10-digit number as stored by this app is assumed
  // Indian and gets "91" prepended; anything else is trusted as already
  // including its country code.
  const to = toPhoneDigits.length === 10 ? '91' + toPhoneDigits : toPhoneDigits;
  const templateName = process.env['WHATSAPP_TEMPLATE_' + templateKind] || WHATSAPP_DEFAULT_TEMPLATES[templateKind];
  if (!templateName) return;
  try {
    const resp = await fetch(`https://graph.facebook.com/v20.0/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.WHATSAPP_ACCESS_TOKEN}` },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to,
        type: 'template',
        template: {
          name: templateName,
          language: { code: process.env.WHATSAPP_TEMPLATE_LANG || 'en' },
          components: [{ type: 'body', parameters: params.map(p => ({ type: 'text', text: String(p) })) }],
        },
      }),
    });
    if (!resp.ok) console.error('WhatsApp send failed:', resp.status, await resp.text());
  } catch (err) {
    console.error('WhatsApp send error:', err);
  }
}
function fmtMoneyServer(n) {
  return '₹' + Number(n || 0).toLocaleString('en-IN');
}
// A Parent AND a Student login can both be linked to the same child — push
// every subscription belonging to every login linked to this student, not
// just one.
async function getStudentContactUserIds(studentId) {
  const rows = await sql`SELECT id FROM users WHERE linked_student_id = ${studentId}`;
  return rows.map(r => r.id);
}
function getStudentParentPhone(student) {
  const extra = student.extra || {};
  const raw = extra.fatherPhone || extra.motherPhone || extra.guardianPhone || '';
  return String(raw).replace(/\D/g, '');
}
async function sendPushToUser(userId, payload) {
  if (!webPushConfigured()) return;
  const subs = await sql`SELECT id, endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = ${userId}`;
  for (const sub of subs) {
    try {
      await webpush.sendNotification(
        { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
        JSON.stringify(payload)
      );
    } catch (err) {
      // 404/410 means the browser itself dropped this subscription (e.g.
      // the PWA was uninstalled) — Web Push's own way of telling us to stop
      // trying it, so clean it up instead of failing the same way forever.
      if (err.statusCode === 404 || err.statusCode === 410) {
        await sql`DELETE FROM push_subscriptions WHERE id = ${sub.id}`.catch(() => {});
      } else {
        console.error('push send failed for subscription', sub.id, err.statusCode || err.message);
      }
    }
  }
}
async function sendPushToStudent(studentId, payload) {
  if (!webPushConfigured()) return;
  const userIds = await getStudentContactUserIds(studentId);
  for (const userId of userIds) await sendPushToUser(userId, payload);
}

// ---------- Notification triggers: fee payment, attendance, marks ----------
// Called (fire-and-forget — never awaited by the request that triggered
// it, so a slow or failing push/WhatsApp send never adds latency to a
// staff member recording a payment/attendance/mark) from handleSimple()
// below for office-entered payments/attendance/marks, and directly from
// the Razorpay verify route above for online payments.
async function notifyFeePayment({ studentId, amount, mode, receiptNo }) {
  if (!studentId) return;
  const rows = await sql`SELECT * FROM students WHERE id = ${studentId}`;
  const student = rows[0];
  if (!student) return;
  const body = `${fmtMoneyServer(amount)} received for ${student.first_name} ${student.last_name}${mode ? ' via ' + mode : ''}${receiptNo ? ' · Receipt ' + receiptNo : ''}.`;
  await sendPushToStudent(student.id, { title: 'Payment received', body, tag: 'fee-payment', url: '/' });
  if (whatsappConfigured()) {
    const phone = getStudentParentPhone(student);
    if (phone) await sendWhatsAppTemplate(phone, 'FEE_PAYMENT', [`${student.first_name} ${student.last_name}`, fmtMoneyServer(amount), receiptNo || '—']);
  }
}
// Only Absent/Late/Leave push — a "marked Present" push every school day
// for every student would just be daily noise parents learn to ignore. See
// the Attendance module's Teacher-scoping comments for the same
// only-what-needs-attention principle applied to what a Teacher can see.
async function notifyAttendanceEvent({ studentId, date, status }) {
  if (!studentId || !['Absent', 'Late', 'Leave'].includes(status)) return;
  const rows = await sql`SELECT * FROM students WHERE id = ${studentId}`;
  const student = rows[0];
  if (!student) return;
  const body = `${student.first_name} ${student.last_name} was marked ${status} on ${date}.`;
  await sendPushToStudent(student.id, { title: `Marked ${status}`, body, tag: 'attendance', url: '/' });
  if (whatsappConfigured()) {
    const phone = getStudentParentPhone(student);
    if (phone) await sendWhatsAppTemplate(phone, 'ATTENDANCE_ALERT', [`${student.first_name} ${student.last_name}`, status, date]);
  }
}
// Fires once — the moment a student's mark set for an exam goes from
// incomplete to complete, matching the "Results published" wording already
// used in the in-app Notifications feed (computeMyNotifications) — never
// once per individual subject saved, and never a second time if a mark is
// later edited (notification_events makes that idempotent).
async function notifyMarksIfComplete({ examId, studentId }) {
  if (!examId || !studentId) return;
  const examRows = await sql`SELECT * FROM exam_defs WHERE id = ${examId}`;
  const exam = examRows[0];
  if (!exam) return;
  const classMap = await studentClassMap([studentId]);
  const cls = classMap[studentId];
  if (!cls) return;
  const classSubjects = exam.class_subjects || {};
  const subjects = classSubjects[cls.className + '||' + cls.section] || [];
  if (!subjects.length) return;
  const resultRows = await sql`SELECT DISTINCT subject FROM exam_results WHERE exam_id = ${examId} AND student_id = ${studentId}`;
  const done = new Set(resultRows.map(r => r.subject));
  if (!subjects.every(s => done.has(s.name))) return;
  const inserted = await sql`
    INSERT INTO notification_events (student_id, kind, ref_key) VALUES (${studentId}, 'marks_published', ${examId})
    ON CONFLICT DO NOTHING RETURNING id
  `;
  if (!inserted.length) return; // already notified for this exam
  const studentRows = await sql`SELECT * FROM students WHERE id = ${studentId}`;
  const student = studentRows[0];
  if (!student) return;
  const body = `${exam.name} results are now available for ${student.first_name} ${student.last_name}.`;
  await sendPushToStudent(student.id, { title: 'Results published', body, tag: 'marks', url: '/' });
  if (whatsappConfigured()) {
    const phone = getStudentParentPhone(student);
    if (phone) await sendWhatsAppTemplate(phone, 'MARKS_PUBLISHED', [`${student.first_name} ${student.last_name}`, exam.name]);
  }
}

// ---------- Fee-due reminders: a server-side replica of computeDefaulters() ----------
// computeDefaulters() (fee + bus outstanding balance) only exists client-side
// today, computed from in-memory arrays the browser already has loaded — no
// use to a scheduled job with no browser open. This mirrors it closely
// enough for a reminder's purposes (tuition + bus only, same as the
// Defaulters tab; hostel/stock aren't part of that tab either).
async function computeStudentDueBalance(student) {
  const [feeStructRows, discountRows, paymentRows, transportRows] = await Promise.all([
    sql`SELECT fee, bus FROM fee_structure WHERE class_name = ${student.class_name}`,
    sql`SELECT applies_to, mode, value FROM student_discounts WHERE student_id = ${student.id} AND status = 'Approved' AND applies_to IN ('fee','bus')`,
    sql`SELECT category, amount, discount, class_at_payment FROM payments WHERE student_id = ${student.id} AND category IN ('fee','bus')`,
    sql`SELECT value FROM kv_store WHERE key = 'transport-routes'`,
  ]);
  const struct = feeStructRows[0] || { fee: 0, bus: 0 };
  const extra = student.extra || {};
  let busExpected = Number(struct.bus) || 0;
  if (extra.transportRouteId && extra.transportStopId) {
    const routes = (transportRows[0] && transportRows[0].value) || [];
    const route = routes.find(r => r.id === extra.transportRouteId);
    const stop = route ? (route.stops || []).find(st => st.id === extra.transportStopId) : null;
    if (stop) busExpected = Number(stop.fare) || 0;
  }
  const expected = { fee: Number(struct.fee) || 0, bus: busExpected };
  const collected = { fee: 0, bus: 0 };
  const discount = { fee: 0, bus: 0 };
  paymentRows.forEach(p => {
    if (expected[p.category] === undefined) return;
    if (p.class_at_payment && p.class_at_payment !== student.class_name) return;
    collected[p.category] += Number(p.amount) || 0;
    discount[p.category] += Number(p.discount) || 0;
  });
  discountRows.forEach(d => {
    if (expected[d.applies_to] === undefined) return;
    discount[d.applies_to] += d.mode === 'percentage'
      ? Math.round(expected[d.applies_to] * (Number(d.value) || 0) / 100)
      : (Number(d.value) || 0);
  });
  let total = 0;
  for (const cat of ['fee', 'bus']) {
    const netPayable = Math.max(expected[cat] - discount[cat], 0);
    total += Math.max(netPayable - collected[cat], 0);
  }
  return total;
}
// Exactly two reminders per due-date cycle, per the school's own
// late-fee-settings.dueDate (the same single due-date concept the Late Fee
// screen already uses — nothing new to configure): one FEE_REMINDER_LEAD_DAYS
// before it, one the day it first becomes overdue. Both are idempotent via
// notification_events keyed on the due date itself, so changing the due
// date later naturally opens a fresh reminder cycle instead of silently
// never firing again.
const FEE_REMINDER_LEAD_DAYS = 3;
async function runFeeDueReminders() {
  const settingsRows = await sql`SELECT value FROM kv_store WHERE key = 'late-fee-settings'`;
  const dueDate = settingsRows.length ? settingsRows[0].value.dueDate : '';
  if (!dueDate) return; // school hasn't set a fee due date yet — nothing to remind about
  const today = new Date().toISOString().slice(0, 10);
  const before = new Date(dueDate);
  before.setDate(before.getDate() - FEE_REMINDER_LEAD_DAYS);
  const beforeStr = before.toISOString().slice(0, 10);
  let kind = null;
  if (today === beforeStr) kind = 'fee_due_before';
  else if (today > dueDate) kind = 'fee_due_after';
  if (!kind) return;
  const students = await sql`SELECT * FROM students WHERE (status IS NULL OR LOWER(status) = 'active') AND deleted_at IS NULL`;
  for (const student of students) {
    try {
      const balance = await computeStudentDueBalance(student);
      if (balance <= 0) continue;
      const inserted = await sql`
        INSERT INTO notification_events (student_id, kind, ref_key) VALUES (${student.id}, ${kind}, ${dueDate})
        ON CONFLICT DO NOTHING RETURNING id
      `;
      if (!inserted.length) continue; // already sent for this due date
      const title = kind === 'fee_due_before' ? 'Fee due soon' : 'Fee overdue';
      const body = kind === 'fee_due_before'
        ? `${student.first_name} ${student.last_name}'s fee of ${fmtMoneyServer(balance)} is due on ${dueDate}.`
        : `${student.first_name} ${student.last_name}'s fee of ${fmtMoneyServer(balance)} was due on ${dueDate} and is now overdue.`;
      await sendPushToStudent(student.id, { title, body, tag: 'fee-due', url: '/' });
      if (whatsappConfigured()) {
        const phone = getStudentParentPhone(student);
        if (phone) {
          await sendWhatsAppTemplate(phone, kind === 'fee_due_before' ? 'FEE_DUE_BEFORE' : 'FEE_DUE_AFTER',
            [`${student.first_name} ${student.last_name}`, fmtMoneyServer(balance), dueDate]);
        }
      }
    } catch (err) {
      console.error('fee due reminder failed for student', student.id, err);
    }
  }
}
// In-process daily scheduler — no new Render service/cron needed. Checked
// hourly but only actually runs the scan once per calendar day (tracked in
// memory), plus once shortly after boot so a reminder due "today" isn't
// missed just because the server happened to restart that morning.
let lastFeeReminderRunDate = null;
async function feeReminderTick() {
  const today = new Date().toISOString().slice(0, 10);
  if (lastFeeReminderRunDate === today) return;
  lastFeeReminderRunDate = today;
  await runFeeDueReminders().catch(err => console.error('runFeeDueReminders failed:', err));
}
setInterval(feeReminderTick, 60 * 60 * 1000);
setTimeout(feeReminderTick, 30 * 1000);

// ---------- Push subscription endpoints ----------
// Any signed-in login can call these (not just Parent/Student) so a Teacher
// or Admin who wants their own notifications later isn't blocked by this
// route itself — today only the Parent/Student client code actually
// subscribes, matching the four event types this session added, which are
// all parent-facing.
app.get('/api/push/vapid-key', (req, res) => {
  if (!webPushConfigured()) return res.status(501).json({ error: 'Push notifications are not set up yet.' });
  return res.status(200).json({ publicKey: process.env.VAPID_PUBLIC_KEY });
});
app.post('/api/push/subscribe', async (req, res) => {
  try {
    if (!req.authUser) return res.status(401).json({ error: 'Not signed in.' });
    const { endpoint, keys } = req.body || {};
    if (!endpoint || !keys || !keys.p256dh || !keys.auth) return res.status(400).json({ error: 'Invalid subscription.' });
    await sql`
      INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, user_agent)
      VALUES (${req.authUser.id}, ${endpoint}, ${keys.p256dh}, ${keys.auth}, ${req.headers['user-agent'] || ''})
      ON CONFLICT (endpoint) DO UPDATE SET user_id = EXCLUDED.user_id, p256dh = EXCLUDED.p256dh, auth = EXCLUDED.auth
    `;
    return res.status(201).json({ ok: true });
  } catch (err) {
    console.error('push subscribe error:', err);
    return res.status(500).json({ error: 'Could not save your subscription.' });
  }
});
app.post('/api/push/unsubscribe', async (req, res) => {
  try {
    const { endpoint } = req.body || {};
    if (!endpoint) return res.status(400).json({ error: 'Missing endpoint.' });
    await sql`DELETE FROM push_subscriptions WHERE endpoint = ${endpoint}`;
    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('push unsubscribe error:', err);
    return res.status(500).json({ error: 'Could not remove your subscription.' });
  }
});

// ---------- Biometric device attendance (optional, per-school integration) ----------
// Every biometric attendance device brand (eSSL, ZKTeco, Realtime, Mantra,
// ...) speaks its own protocol, and network biometric devices live on the
// school's own LAN, not the public internet — this cloud-hosted ERP has no
// way to dial into a school's private network to pull logs itself. So the
// integration point is the other direction: a small on-site "bridge"
// program (see ../biometric-bridge/ next to this file) runs on any PC on
// the SAME network as the device(s), polls them using their own SDK, and
// PUSHES new punches up to this endpoint over the internet — a direction
// that always works with no port-forwarding or firewall change needed.
//
// This is exactly as optional as the Razorpay integration above and follows
// the same pattern: a school that doesn't have a biometric device (or
// doesn't want to wire it up yet) simply never gets a BIOMETRIC_API_KEY
// and never runs the bridge, and every trace of this feature — the Staff
// form's Biometric ID field, the Staff Attendance "Biometric Sync" tab —
// stays hidden from that school's app entirely (see GET .../status below).
//
// Reads BIOMETRIC_API_KEY from Render's environment — set it on a school's
// service only once you're actually setting up their device bridge, and
// give the bridge the same value in its own .env.
function biometricConfigured() {
  return !!process.env.BIOMETRIC_API_KEY;
}
// Whether this school has biometric attendance turned on at all — checked
// by the app at boot (loadBiometricStatus in index.html) so it can hide
// every trace of the feature for a school that hasn't set it up. Requires
// a real login (unlike the ingestion endpoint below, which the bridge
// calls with its own API key, not a user session) since this is only ever
// read by the already-logged-in app itself.
app.get('/api/biometric/status', async (req, res) => {
  return res.status(200).json({ enabled: biometricConfigured() });
});
// Recent punches, for the Admin's Biometric Sync tab — who's mapped,
// who isn't, and confirmation the bridge is actually reaching this ERP.
app.get('/api/biometric/punches', async (req, res) => {
  try {
    if (!(await checkModuleAccess(req, res, ['staff', 'attendance']))) return;
    const limit = Math.min(parseInt(req.query.limit, 10) || 200, 500);
    const rows = await sql`SELECT * FROM biometric_punches ORDER BY punched_at DESC LIMIT ${limit}`;
    return res.status(200).json(rows.map(r => ({
      id: r.id, deviceSerial: r.device_serial, deviceUserId: r.device_user_id,
      punchedAt: r.punched_at, staffId: r.staff_id, staffName: r.staff_name, matched: r.matched,
    })));
  } catch (err) {
    console.error('biometric punches list error:', err);
    return res.status(500).json({ error: 'Something went wrong on the server.' });
  }
});
// The bridge's ingestion call. Authenticated by BIOMETRIC_API_KEY, sent as
// a plain header exactly like the vendor-dashboard's own server-to-server
// calls above (x-vendor-api-key) — this is a machine calling in from the
// school's own network, not a person with a login session, so it's listed
// in PUBLIC_API_ROUTES (POST only) to skip the session-cookie check, and
// checks this key by hand instead.
//
// Body: { deviceSerial, punches: [{ deviceUserId, timestamp }, ...] }.
// For each punch: matched to a staff member by their Biometric ID (set on
// the Staff form, stored in staff.extra.biometricId), logged either way,
// and — only when matched — used to mark that staff member Present for
// that calendar day, but ONLY if no attendance record already exists for
// them that day. This is deliberately insert-only, never an overwrite: if
// the office has already marked (or corrected) that day by hand, biometric
// sync never silently replaces it. The id scheme (statt_<staffId>_<date>)
// is shared with the Staff Attendance "Mark" screen's own manual saves
// (see saveStaffAttendance in index.html), so whichever one gets there
// first simply wins and the other becomes a no-op.
app.post('/api/biometric/punches', async (req, res) => {
  try {
    if (!biometricConfigured()) {
      return res.status(501).json({ error: 'Biometric attendance is not set up for this school yet.' });
    }
    const key = req.headers['x-biometric-api-key'];
    if (!key || key !== process.env.BIOMETRIC_API_KEY) {
      return res.status(401).json({ error: 'Invalid or missing biometric API key.' });
    }
    const deviceSerial = String((req.body && req.body.deviceSerial) || 'unknown').slice(0, 100);
    const punches = Array.isArray(req.body && req.body.punches) ? req.body.punches.slice(0, 2000) : [];
    let matchedCount = 0;
    for (const p of punches) {
      const deviceUserId = p && p.deviceUserId !== undefined && p.deviceUserId !== null ? String(p.deviceUserId).trim() : '';
      const punchedAt = p && p.timestamp ? new Date(p.timestamp) : null;
      if (!deviceUserId || !punchedAt || isNaN(punchedAt.getTime())) continue; // skip anything malformed rather than fail the whole batch
      let staffId = null, staffName = null;
      const staffRows = await sql`SELECT id, first_name, last_name FROM staff WHERE extra ->> 'biometricId' = ${deviceUserId} LIMIT 1`;
      if (staffRows.length) {
        staffId = staffRows[0].id;
        staffName = `${staffRows[0].first_name || ''} ${staffRows[0].last_name || ''}`.trim();
        matchedCount++;
      }
      const punchId = 'biop_' + deviceSerial + '_' + deviceUserId + '_' + punchedAt.toISOString();
      await sql`
        INSERT INTO biometric_punches (id, device_serial, device_user_id, punched_at, staff_id, staff_name, matched)
        VALUES (${punchId}, ${deviceSerial}, ${deviceUserId}, ${punchedAt.toISOString()}, ${staffId}, ${staffName}, ${!!staffId})
        ON CONFLICT (id) DO NOTHING
      `;
      if (staffId) {
        const dateStr = punchedAt.toISOString().slice(0, 10);
        const attId = 'statt_' + staffId + '_' + dateStr;
        await sql`
          INSERT INTO staff_attendance_records (id, staff_id, date, status)
          VALUES (${attId}, ${staffId}, ${dateStr}, 'Present')
          ON CONFLICT (id) DO NOTHING
        `;
      }
    }
    return res.status(200).json({ ok: true, received: punches.length, matched: matchedCount, unmatched: punches.length - matchedCount });
  } catch (err) {
    console.error('biometric punches ingest error:', err);
    return res.status(500).json({ error: 'Something went wrong on the server.' });
  }
});

// ---------- Login ----------
// The only place a username/password pair is ever checked now that GET
// /api/users no longer sends passwords to the browser at all (see
// handleUsers and the migration above) — the app's own login screen, the
// "change my password" screens (which re-verify the current password
// before accepting a new one), and nothing else, all call this instead of
// comparing locally. Deliberately returns the same generic message on a
// bad username and a bad password, rather than confirming which one was
// wrong, so this can't be used to enumerate valid usernames.
// ---------- Login rate limiting ----------
// In-memory (per-process) tracking of failed login attempts, keyed by
// IP + username so one bad actor guessing one account can't lock out
// every other user, and one legitimate user mistyping their own password
// a few times doesn't get caught by someone else's attempts elsewhere.
// This is enough for this app's actual deployment — a single Render
// instance, no load balancer spreading requests across processes — without
// adding a dependency or a database table just to store short-lived
// counters that only ever need to survive a few minutes.
const LOGIN_MAX_ATTEMPTS = 5;
const LOGIN_WINDOW_MS = 15 * 60 * 1000; // 15 minutes
const loginAttempts = new Map(); // key -> { count, firstAttempt, blockedUntil }

function loginRateKey(req, username) {
  const fwd = req.headers['x-forwarded-for'];
  const ip = (fwd ? String(fwd).split(',')[0].trim() : '') || req.socket.remoteAddress || 'unknown';
  return ip + '|' + String(username || '').toLowerCase();
}

// Returns seconds remaining if this key is currently blocked, otherwise null.
function checkLoginRateLimit(key) {
  const rec = loginAttempts.get(key);
  if (!rec) return null;
  if (rec.blockedUntil && Date.now() < rec.blockedUntil) {
    return Math.ceil((rec.blockedUntil - Date.now()) / 1000);
  }
  if (rec.blockedUntil && Date.now() >= rec.blockedUntil) {
    loginAttempts.delete(key); // block expired — start fresh
  }
  return null;
}

function recordLoginFailure(key) {
  const now = Date.now();
  let rec = loginAttempts.get(key);
  if (!rec || now - rec.firstAttempt > LOGIN_WINDOW_MS) {
    rec = { count: 0, firstAttempt: now, blockedUntil: null };
  }
  rec.count++;
  if (rec.count >= LOGIN_MAX_ATTEMPTS) {
    rec.blockedUntil = now + LOGIN_WINDOW_MS;
  }
  loginAttempts.set(key, rec);
}

function recordLoginSuccess(key) {
  loginAttempts.delete(key);
}

// Sweep stale entries periodically so this Map doesn't grow unbounded over
// the life of the process. unref() so this timer never keeps the process
// alive on its own.
setInterval(() => {
  const now = Date.now();
  for (const [key, rec] of loginAttempts) {
    if ((!rec.blockedUntil || now > rec.blockedUntil) && now - rec.firstAttempt > LOGIN_WINDOW_MS) {
      loginAttempts.delete(key);
    }
  }
}, 10 * 60 * 1000).unref();

// Which side of the login screen's Staff / Parent & Student toggle each
// role belongs to. Purely a "you're on the wrong tab" guardrail, not a
// substitute for the per-route role checks a real authorization layer
// would add — a Teacher who successfully signs in here still gets
// whatever a Teacher session normally gets, same as before this existed.
const STAFF_LOGIN_ROLES = ['Admin', 'Principal', 'Accountant', 'Office Assistant', 'Teacher', 'Staff'];
const PARENT_LOGIN_ROLES = ['Student', 'Parent'];
// Who "Management" resolves to when a Student/Parent addresses a concern or
// submission to Management rather than a specific teacher — both roles see
// everything sent there (see /api/concerns/inbox and /api/submissions/inbox
// below), matching how the rest of the app already treats Admin and
// Principal as the two full-access staff roles.
const MANAGEMENT_ROLES = ['Admin', 'Principal'];

// ---------- Student/Parent self-service: "My Portal" reads ----------
// The generic staff-module permission gate below (RESOURCE_TO_MODULE +
// checkModuleAccess) is designed to control what STAFF roles can browse —
// but a Student/Parent self-service login structurally never has any of
// those staff modules (managefee, exams/result, attendance, ...), so every
// fetch these read-only "My Portal" screens make was silently 403ing and
// falling back to whatever this browser's own localStorage happened to
// have cached — showing fees/marks/attendance as empty or "still due" even
// when the real data says otherwise. See the two carve-outs below and the
// PARENT_SHARED_REFERENCE_RESOURCES/PARENT_SHARED_REFERENCE_KV_KEYS bypass
// further down in the main dispatcher.
//
// Two different fixes, by data shape:
//  - PARENT_OWN_RECORD_RESOURCES: a real per-student table (has a
//    student_id column). Scoped to just that login's own linked student —
//    never the whole school's rows — the same principle as the 'students'
//    carve-out itself.
//  - PARENT_SHARED_REFERENCE_RESOURCES: read-only reference data with no
//    student_id at all (this year's fee schedule, exam definitions/dates,
//    the subject list) — nothing in these is specific to any one student,
//    so there's no "own record" to scope to; a Student/Parent login is
//    simply allowed to read them like every other GET below, unchanged.
const PARENT_OWN_RECORD_RESOURCES = {
  payments: { table: 'payments', fields: () => SIMPLE_RESOURCES.payments.fields },
  discounts: { table: 'student_discounts', fields: () => SIMPLE_RESOURCES.discounts.fields },
  'extra-fees': { table: 'student_extra_fees', fields: () => SIMPLE_RESOURCES['extra-fees'].fields },
  'exam-results': { table: 'exam_results', fields: () => SIMPLE_RESOURCES['exam-results'].fields },
  attendance: { table: 'attendance_records', fields: () => SIMPLE_RESOURCES.attendance.fields },
};
const PARENT_SHARED_REFERENCE_RESOURCES = ['fee-structure', 'exam-defs', 'subjects'];
// Same idea, one level down, for the generic /api/kv/:key store — right now
// just the late-fee policy (rate/grace period), which Fees needs to show an
// accurate "Outstanding" figure instead of silently treating every family
// as having no late fee at all.
const PARENT_SHARED_REFERENCE_KV_KEYS = ['late-fee-settings'];

app.post('/api/login', async (req, res) => {
  try {
    const { username, password, audience } = req.body || {};
    if (!username || !password) return res.status(400).json({ error: 'Username and password are required.' });
    const rateKey = loginRateKey(req, username);
    const blockedForSeconds = checkLoginRateLimit(rateKey);
    if (blockedForSeconds) {
      const mins = Math.ceil(blockedForSeconds / 60);
      return res.status(429).json({ error: `Too many failed attempts. Try again in ${mins} minute${mins === 1 ? '' : 's'}.` });
    }
    const rows = await sql`SELECT * FROM users WHERE LOWER(username) = LOWER(${String(username)}) AND deleted_at IS NULL`;
    if (!rows.length) { recordLoginFailure(rateKey); return res.status(401).json({ error: 'Invalid username or password.' }); }
    const user = rows[0];
    const ok = await bcrypt.compare(String(password), user.password || '');
    if (!ok) { recordLoginFailure(rateKey); return res.status(401).json({ error: 'Invalid username or password.' }); }
    // Checked only after the password is already confirmed correct, so this
    // never gives anyone a way to learn an account's role without already
    // knowing its password — at that point they could just switch tabs
    // anyway. Treated as a successful login for rate-limiting purposes
    // (it's a real account with the real password, just the wrong tab).
    // A manual, vendor-triggered access cutoff for non-payment (see
    // vendor-reporting.js's isAccessSuspended) — never automatic, and Admin
    // always stays able to sign in so the school can see why and reach the
    // vendor. Checked after the password so this never leaks anything to a
    // wrong guess; a correct one still counts as a successful attempt.
    if (user.role !== 'Admin') {
      const access = isAccessSuspended();
      if (access.suspended) {
        recordLoginSuccess(rateKey);
        return res.status(403).json({
          error: access.reason
            ? `Access is temporarily suspended: ${access.reason} Please contact your school office.`
            : 'Access to this ERP has been temporarily suspended due to a pending payment. Please contact your school office.',
          accessSuspended: true,
        });
      }
    }
    if (audience === 'staff' && !STAFF_LOGIN_ROLES.includes(user.role)) {
      recordLoginSuccess(rateKey);
      return res.status(403).json({ error: 'This is a Parent/Student account — switch to the "Parent & Student" tab to sign in.', wrongAudience: true });
    }
    if (audience === 'parent' && !PARENT_LOGIN_ROLES.includes(user.role)) {
      recordLoginSuccess(rateKey);
      return res.status(403).json({ error: 'This is a Staff account — switch to the "Staff" tab to sign in.', wrongAudience: true });
    }
    recordLoginSuccess(rateKey);
    const shaped = simpleToAppShape(user, SIMPLE_RESOURCES.users.fields);
    delete shaped.password;
    // So the client can hide a nav item the school's Plan doesn't include —
    // same idea as the ROLE_VIEWS shape it already gets, just billing-driven
    // instead of role-driven. See checkPlanModuleAccess above for enforcement.
    shaped.moduleAccess = getModuleAccess();
    await createSession(req, res, user);
    return res.status(200).json(shaped);
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

// Accepts a short-lived, signed troubleshooting link from the Vendor
// Dashboard (Schools tab → Support Login) — see vendor-support-login.js's
// own header comment and README.md's "Support Login" section. The token
// itself is the only thing that authorizes this; there's no password
// involved on either side. Named distinctly ("Vendor Support") in the
// session/audit trail so it's never mistaken for a real staff login.
app.get('/api/vendor-support-login', (req, res) => {
  handleVendorSupportLogin(req.query.token, {
    onValid: async (payload) => {
      try {
        await createSession(req, res, {
          id: 'vendor-support',
          role: 'Admin',
          name: 'Vendor Support' + (payload && payload.adminName ? ` (${payload.adminName})` : ''),
        });
        res.redirect('/');
      } catch (err) {
        console.error('vendor support login error:', err);
        res.status(500).send('Could not start the support session.');
      }
    },
    onInvalid: (reason) => {
      res.status(401).send('This support login link is invalid or has expired (' + reason + '). Ask your vendor to generate a new one.');
    },
  });
});

// Lets the vendor dashboard read this school's public admission enquiries
// (submitted through this school's own website) without logging in as this
// school's staff — authenticated by the same VENDOR_API_KEY env var
// vendor-support-login.js and vendor-reporting.js already use, sent as a
// plain header since this is a direct server-to-server call, not a link a
// person clicks. Read-only: nothing here can create, edit, or delete an
// enquiry, only list what's already been submitted.
app.get('/api/vendor/admission-inquiries', async (req, res) => {
  try {
    const key = req.headers['x-vendor-api-key'];
    if (!process.env.VENDOR_API_KEY || !key || key !== process.env.VENDOR_API_KEY) {
      return res.status(401).json({ error: 'Invalid or missing vendor API key.' });
    }
    const rows = await sql`SELECT * FROM admission_inquiries ORDER BY created_at DESC LIMIT 500`;
    return res.status(200).json(rows.map(r => ({
      id: r.id,
      parentName: r.parent_name,
      parentEmail: r.parent_email,
      parentPhone: r.parent_phone,
      studentName: r.student_name,
      applyingGrade: r.applying_grade,
      notes: r.notes,
      submittedDate: r.submitted_date,
      status: r.status,
      createdAt: r.created_at,
    })));
  } catch (err) {
    console.error('vendor admission-inquiries error:', err);
    return res.status(500).json({ error: 'Something went wrong on the server.' });
  }
});

// Lets a signed-in staff member send a message directly to the vendor from
// inside the ERP (see the "Contact Vendor" screen) — it lands in the vendor
// dashboard's Support tab against this school, so the vendor can see it and
// reply. Uses the same VENDOR_DASHBOARD_URL / VENDOR_SCHOOL_ID /
// VENDOR_API_KEY env vars the silent background reporting in
// vendor-reporting.js already relies on, but unlike that module this is NOT
// silent — whoever submits it needs to know whether it actually went
// through, so errors are reported back rather than swallowed.
app.post('/api/contact-vendor', async (req, res) => {
  try {
    const dashboardUrl = process.env.VENDOR_DASHBOARD_URL;
    const schoolId = process.env.VENDOR_SCHOOL_ID;
    const apiKey = process.env.VENDOR_API_KEY;
    if (!dashboardUrl || !schoolId || !apiKey) {
      return res.status(400).json({ error: 'Vendor contact is not configured on this ERP yet — ask your vendor to set VENDOR_DASHBOARD_URL, VENDOR_SCHOOL_ID, and VENDOR_API_KEY.' });
    }
    const { subject, message, priority, type } = req.body || {};
    if (!subject || !String(subject).trim()) return res.status(400).json({ error: 'Subject is required.' });
    if (!message || !String(message).trim()) return res.status(400).json({ error: 'Message is required.' });
    const submittedBy = req.authUser ? `${req.authUser.name} (${req.authUser.role})` : 'ERP staff';
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    let upstream;
    try {
      upstream = await fetch(dashboardUrl.replace(/\/$/, '') + '/api/ingest/query', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          schoolId,
          apiKey,
          subject: String(subject).trim().slice(0, 300),
          message: `From: ${submittedBy}\n\n${String(message).trim().slice(0, 3900)}`,
          priority: ['low', 'normal', 'high'].includes(priority) ? priority : 'normal',
          type: type === 'customization' ? 'customization' : 'support',
        }),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }
    if (!upstream.ok) {
      const text = await upstream.text().catch(() => '');
      let errMsg = 'The vendor dashboard rejected this message.';
      try { const parsed = JSON.parse(text); if (parsed && parsed.error) errMsg = parsed.error; } catch {}
      return res.status(502).json({ error: errMsg });
    }
    return res.status(201).json({ ok: true });
  } catch (err) {
    console.error('contact-vendor error:', err);
    return res.status(502).json({ error: 'Could not reach the vendor dashboard — it may be offline. Please try again shortly.' });
  }
});

// ---------- Student/Parent -> Staff: Concerns & Work Submissions ----------
// Two small, related features, both reachable only from the Student/Parent
// portal (myprofile view in index.html): sending a concern to the Class
// Teacher / a Subject Teacher / Management, and submitting completed
// homework or holiday work the same way. Both share the same "who is this
// for" resolution (recipientType + recipientStaffId, decided client-side —
// the client already has the exact same staffList/subjectsList lookups the
// rest of the app uses for this, e.g. classTeacherClass and
// subjectStaffForSection), the same student-identity rule (always the
// caller's own linked student, never whatever a request body claims), and
// the same staff-inbox shape (whatever's addressed to my own staff record,
// plus anything addressed to Management if I'm Admin/Principal).
function shapeConcern(r) {
  return {
    id: r.id, studentId: r.student_id, studentName: r.student_name,
    className: r.class_name, section: r.section,
    recipientType: r.recipient_type, recipientStaffId: r.recipient_staff_id,
    recipientName: r.recipient_name, subjectName: r.subject_name,
    message: r.message, status: r.status,
    replyMessage: r.reply_message, repliedBy: r.replied_by, repliedAt: r.replied_at,
    resolvedAt: r.resolved_at, resolvedBy: r.resolved_by,
    createdAt: r.created_at,
  };
}
function shapeSubmission(r) {
  // Older rows (saved before multi-attachment support) carry their one file
  // in `attachment`; newer rows carry `attachments` and leave `attachment`
  // null. Either way the client always gets an `attachments` array to render.
  const attachments = (r.attachments && r.attachments.length) ? r.attachments
    : (r.attachment ? [{ name: 'Attachment', dataUrl: r.attachment }] : []);
  return {
    id: r.id, studentId: r.student_id, studentName: r.student_name,
    className: r.class_name, section: r.section,
    recipientType: r.recipient_type, recipientStaffId: r.recipient_staff_id,
    recipientName: r.recipient_name, subjectName: r.subject_name,
    homeworkId: r.homework_id, title: r.title, description: r.description, attachments,
    status: r.status, feedback: r.feedback, reviewedBy: r.reviewed_by, reviewedAt: r.reviewed_at,
    createdAt: r.created_at,
  };
}
const CONCERN_RECIPIENT_TYPES = ['class_teacher', 'subject_teacher', 'management'];
// A Teacher/Staff login has no direct column tying it to a staff record —
// the same linkedUserId convention index.html already reads elsewhere
// (see myStaffRecord in the Homework tab) is how "which staff member is
// signed in right now" is worked out here too.
async function getMyStaffRow(userId) {
  const rows = await sql`SELECT id FROM staff WHERE extra->>'linkedUserId' = ${userId} LIMIT 1`;
  return rows.length ? rows[0] : null;
}
async function getLinkedStudent(userId) {
  const userRows = await sql`SELECT linked_student_id FROM users WHERE id = ${userId}`;
  const studentId = userRows.length ? userRows[0].linked_student_id : '';
  if (!studentId) return null;
  const studentRows = await sql`SELECT * FROM students WHERE id = ${studentId} AND deleted_at IS NULL`;
  return studentRows.length ? studentRows[0] : null;
}
// ---------- Teacher self-service scoping: homeroom attendance & assigned-subject marks ----------
// A Teacher login's module access (SERVER_ROLE_VIEWS.Teacher includes
// 'attendance' and 'exams'/'result') was letting any teacher mark
// attendance or enter exam marks for ANY class in the school, not just the
// ones they actually teach — the module system only answers "can this
// role touch this module at all," not "can this specific person touch
// this specific class." These helpers resolve a signed-in Teacher's real
// duties — the homeroom class they're the Class Teacher of (set on their
// staff record, same classTeacherClass/classTeacherSection index.html
// already reads) and the subject+section combinations they're the
// assigned Subject Teacher for (subjects.section_staff, the same
// assignment subjectStaffForSection() reads client-side) — so attendance
// and marks can be scoped to just that, the same way getLinkedStudent
// scopes a Parent/Student login to just their own child.
async function getMyStaffFull(userId) {
  const rows = await sql`SELECT * FROM staff WHERE extra->>'linkedUserId' = ${userId} LIMIT 1`;
  return rows.length ? rows[0] : null;
}
async function getTeacherScope(userId) {
  const staff = await getMyStaffFull(userId);
  if (!staff) return { staffId: null, classTeacherOf: null, subjectSections: [] };
  const extra = staff.extra || {};
  const classTeacherOf = (extra.classTeacherClass && extra.classTeacherSection)
    ? { className: extra.classTeacherClass, section: extra.classTeacherSection }
    : null;
  const subjectRows = await sql`SELECT name, class_name, section_staff FROM subjects`;
  const subjectSections = [];
  for (const s of subjectRows) {
    const sectionStaff = s.section_staff || {};
    for (const [section, staffIds] of Object.entries(sectionStaff)) {
      if (Array.isArray(staffIds) && staffIds.includes(staff.id)) {
        subjectSections.push({ subject: s.name, className: s.class_name, section });
      }
    }
  }
  return { staffId: staff.id, classTeacherOf, subjectSections };
}
async function studentClassMap(studentIds) {
  if (!studentIds.length) return {};
  const placeholders = studentIds.map((_, i) => `$${i + 1}`).join(', ');
  const rows = await sql.query(`SELECT id, class_name, section FROM students WHERE id IN (${placeholders})`, studentIds);
  const map = {};
  rows.forEach(r => { map[r.id] = { className: r.class_name, section: r.section }; });
  return map;
}
function validateRecipient(b) {
  const recipientType = CONCERN_RECIPIENT_TYPES.includes(b.recipientType) ? b.recipientType : null;
  if (!recipientType) return 'Please choose who this is for.';
  if (recipientType !== 'management' && !b.recipientStaffId) return 'Could not identify the teacher to send this to.';
  return null;
}

app.post('/api/concerns', async (req, res) => {
  try {
    if (!req.authUser || !PARENT_LOGIN_ROLES.includes(req.authUser.role)) {
      return res.status(403).json({ error: 'Only a Student/Parent login can send a concern.' });
    }
    const student = await getLinkedStudent(req.authUser.id);
    if (!student) return res.status(400).json({ error: 'This login is not linked to a student record yet — ask your Admin.' });
    const b = req.body || {};
    const recipientError = validateRecipient(b);
    if (recipientError) return res.status(400).json({ error: recipientError });
    if (!b.message || !String(b.message).trim()) return res.status(400).json({ error: 'Please enter your message.' });
    const id = 'concern_' + Date.now() + '_' + crypto.randomBytes(4).toString('hex');
    await sql`
      INSERT INTO student_concerns (id, student_id, student_name, class_name, section, recipient_type, recipient_staff_id, recipient_name, subject_name, message)
      VALUES (${id}, ${student.id}, ${(student.first_name + ' ' + (student.last_name || '')).trim()}, ${student.class_name}, ${student.section},
              ${b.recipientType}, ${b.recipientType === 'management' ? null : b.recipientStaffId},
              ${b.recipientName || (b.recipientType === 'management' ? 'Management' : '')},
              ${b.recipientType === 'subject_teacher' ? (b.subjectName || '') : null},
              ${String(b.message).trim().slice(0, 4000)})
    `;
    return res.status(201).json({ ok: true, id });
  } catch (err) {
    console.error('concerns create error:', err);
    return res.status(500).json({ error: 'Something went wrong on the server.' });
  }
});

app.get('/api/concerns/mine', async (req, res) => {
  try {
    if (!req.authUser || !PARENT_LOGIN_ROLES.includes(req.authUser.role)) {
      return res.status(403).json({ error: 'Not available for this account.' });
    }
    const student = await getLinkedStudent(req.authUser.id);
    if (!student) return res.status(200).json([]);
    const rows = await sql`SELECT * FROM student_concerns WHERE student_id = ${student.id} ORDER BY created_at DESC`;
    return res.status(200).json(rows.map(shapeConcern));
  } catch (err) {
    console.error('concerns mine error:', err);
    return res.status(500).json({ error: 'Something went wrong on the server.' });
  }
});

app.get('/api/concerns/inbox', async (req, res) => {
  try {
    if (!req.authUser || !STAFF_LOGIN_ROLES.includes(req.authUser.role)) {
      return res.status(403).json({ error: 'Not available for this account.' });
    }
    // Roles & Permissions enforcement: a staff role whose Inbox module
    // access has been explicitly restricted by the admin can no longer read
    // this by calling the API directly, even though it's not one of the
    // generic SIMPLE_RESOURCES/HYBRID_RESOURCES/kv routes above.
    if (!(await checkModuleAccess(req, res, ['inbox']))) return;
    const isManagement = MANAGEMENT_ROLES.includes(req.authUser.role);
    // Admin/Principal get full oversight — every concern in the school,
    // whoever it's addressed to — not just ones sent to Management, so a
    // Class/Subject Teacher sitting on a parent's concern doesn't go
    // unnoticed. Every other staff role still only sees what's addressed to
    // their own staff record.
    if (isManagement) {
      const rows = await sql`SELECT * FROM student_concerns ORDER BY created_at ASC`;
      return res.status(200).json(rows.map(shapeConcern));
    }
    const myStaff = await getMyStaffRow(req.authUser.id);
    if (!myStaff) return res.status(200).json([]);
    const rows = await sql`SELECT * FROM student_concerns WHERE recipient_staff_id = ${myStaff.id} ORDER BY created_at DESC`;
    return res.status(200).json(rows.map(shapeConcern));
  } catch (err) {
    console.error('concerns inbox error:', err);
    return res.status(500).json({ error: 'Something went wrong on the server.' });
  }
});

app.put('/api/concerns/:id/reply', async (req, res) => {
  try {
    if (!req.authUser || !STAFF_LOGIN_ROLES.includes(req.authUser.role)) {
      return res.status(403).json({ error: 'Not available for this account.' });
    }
    if (!(await checkModuleAccess(req, res, ['inbox']))) return;
    const rows = await sql`SELECT * FROM student_concerns WHERE id = ${req.params.id}`;
    if (!rows.length) return res.status(404).json({ error: 'Concern not found.' });
    const concern = rows[0];
    const myStaff = await getMyStaffRow(req.authUser.id);
    const isManagement = MANAGEMENT_ROLES.includes(req.authUser.role);
    // Admin/Principal can act on any concern (same oversight reasoning as
    // /api/concerns/inbox above) — not just ones addressed to Management.
    const canReply = (myStaff && concern.recipient_staff_id === myStaff.id) || isManagement;
    if (!canReply) return res.status(403).json({ error: 'This concern is not addressed to you.' });
    const replyMessage = req.body && req.body.replyMessage;
    if (!replyMessage || !String(replyMessage).trim()) return res.status(400).json({ error: 'Please enter a reply.' });
    // Deliberately doesn't touch status/resolved_at — replying and marking a
    // concern solved are two separate actions (see /api/concerns/:id/status
    // below), since a reply doesn't always mean the matter is actually
    // settled yet, and a concern can be resolved with no reply logged at all.
    await sql`
      UPDATE student_concerns SET reply_message = ${String(replyMessage).trim().slice(0, 4000)},
        replied_by = ${req.authUser.name}, replied_at = now()
      WHERE id = ${req.params.id}
    `;
    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('concerns reply error:', err);
    return res.status(500).json({ error: 'Something went wrong on the server.' });
  }
});

// Marks a concern solved or reopens it — independent of replying (see
// above). Reopening clears resolved_at/resolved_by rather than keeping them
// as history, so what's shown always reflects the concern's current state.
app.put('/api/concerns/:id/status', async (req, res) => {
  try {
    if (!req.authUser || !STAFF_LOGIN_ROLES.includes(req.authUser.role)) {
      return res.status(403).json({ error: 'Not available for this account.' });
    }
    if (!(await checkModuleAccess(req, res, ['inbox']))) return;
    const rows = await sql`SELECT * FROM student_concerns WHERE id = ${req.params.id}`;
    if (!rows.length) return res.status(404).json({ error: 'Concern not found.' });
    const concern = rows[0];
    const myStaff = await getMyStaffRow(req.authUser.id);
    const isManagement = MANAGEMENT_ROLES.includes(req.authUser.role);
    const canAct = (myStaff && concern.recipient_staff_id === myStaff.id) || isManagement;
    if (!canAct) return res.status(403).json({ error: 'This concern is not addressed to you.' });
    const resolved = !!(req.body && req.body.resolved);
    if (resolved) {
      await sql`UPDATE student_concerns SET status = 'resolved', resolved_at = now(), resolved_by = ${req.authUser.name} WHERE id = ${req.params.id}`;
    } else {
      await sql`UPDATE student_concerns SET status = 'open', resolved_at = NULL, resolved_by = NULL WHERE id = ${req.params.id}`;
    }
    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('concerns status error:', err);
    return res.status(500).json({ error: 'Something went wrong on the server.' });
  }
});

app.post('/api/submissions', async (req, res) => {
  try {
    if (!req.authUser || !PARENT_LOGIN_ROLES.includes(req.authUser.role)) {
      return res.status(403).json({ error: 'Only a Student/Parent login can submit work.' });
    }
    const student = await getLinkedStudent(req.authUser.id);
    if (!student) return res.status(400).json({ error: 'This login is not linked to a student record yet — ask your Admin.' });
    const b = req.body || {};
    const recipientError = validateRecipient(b);
    if (recipientError) return res.status(400).json({ error: recipientError });
    if (!b.title || !String(b.title).trim()) return res.status(400).json({ error: 'Please enter a title.' });
    // A submission can carry several files (see the ALTER TABLE above) — cap
    // the count server-side too, not just in the UI, since this body still
    // has to fit inside the app's global 25mb JSON limit either way.
    const attachments = Array.isArray(b.attachments)
      ? b.attachments.filter(a => a && a.dataUrl).slice(0, 5).map(a => ({ name: String(a.name || 'file').slice(0, 200), dataUrl: a.dataUrl }))
      : [];
    const id = 'submission_' + Date.now() + '_' + crypto.randomBytes(4).toString('hex');
    await sql`
      INSERT INTO student_submissions (id, student_id, student_name, class_name, section, recipient_type, recipient_staff_id, recipient_name, subject_name, homework_id, title, description, attachments)
      VALUES (${id}, ${student.id}, ${(student.first_name + ' ' + (student.last_name || '')).trim()}, ${student.class_name}, ${student.section},
              ${b.recipientType}, ${b.recipientType === 'management' ? null : b.recipientStaffId},
              ${b.recipientName || (b.recipientType === 'management' ? 'Management' : '')},
              ${b.recipientType === 'subject_teacher' ? (b.subjectName || '') : null},
              ${b.homeworkId || null}, ${String(b.title).trim().slice(0, 300)},
              ${String(b.description || '').trim().slice(0, 4000)}, ${JSON.stringify(attachments)}::jsonb)
    `;
    return res.status(201).json({ ok: true, id });
  } catch (err) {
    console.error('submissions create error:', err);
    return res.status(500).json({ error: 'Something went wrong on the server.' });
  }
});

app.get('/api/submissions/mine', async (req, res) => {
  try {
    if (!req.authUser || !PARENT_LOGIN_ROLES.includes(req.authUser.role)) {
      return res.status(403).json({ error: 'Not available for this account.' });
    }
    const student = await getLinkedStudent(req.authUser.id);
    if (!student) return res.status(200).json([]);
    const rows = await sql`SELECT * FROM student_submissions WHERE student_id = ${student.id} ORDER BY created_at DESC`;
    return res.status(200).json(rows.map(shapeSubmission));
  } catch (err) {
    console.error('submissions mine error:', err);
    return res.status(500).json({ error: 'Something went wrong on the server.' });
  }
});

app.get('/api/submissions/inbox', async (req, res) => {
  try {
    if (!req.authUser || !STAFF_LOGIN_ROLES.includes(req.authUser.role)) {
      return res.status(403).json({ error: 'Not available for this account.' });
    }
    if (!(await checkModuleAccess(req, res, ['inbox']))) return;
    const isManagement = MANAGEMENT_ROLES.includes(req.authUser.role);
    // Same oversight reasoning as /api/concerns/inbox — Admin/Principal see
    // every submission, not just ones sent to Management, so a teacher
    // ignoring submitted work doesn't go unnoticed.
    if (isManagement) {
      const rows = await sql`SELECT * FROM student_submissions ORDER BY created_at ASC`;
      return res.status(200).json(rows.map(shapeSubmission));
    }
    const myStaff = await getMyStaffRow(req.authUser.id);
    if (!myStaff) return res.status(200).json([]);
    const rows = await sql`SELECT * FROM student_submissions WHERE recipient_staff_id = ${myStaff.id} ORDER BY created_at DESC`;
    return res.status(200).json(rows.map(shapeSubmission));
  } catch (err) {
    console.error('submissions inbox error:', err);
    return res.status(500).json({ error: 'Something went wrong on the server.' });
  }
});

app.put('/api/submissions/:id/review', async (req, res) => {
  try {
    if (!req.authUser || !STAFF_LOGIN_ROLES.includes(req.authUser.role)) {
      return res.status(403).json({ error: 'Not available for this account.' });
    }
    if (!(await checkModuleAccess(req, res, ['inbox']))) return;
    const rows = await sql`SELECT * FROM student_submissions WHERE id = ${req.params.id}`;
    if (!rows.length) return res.status(404).json({ error: 'Submission not found.' });
    const submission = rows[0];
    const myStaff = await getMyStaffRow(req.authUser.id);
    const isManagement = MANAGEMENT_ROLES.includes(req.authUser.role);
    const canReview = (myStaff && submission.recipient_staff_id === myStaff.id) || isManagement;
    if (!canReview) return res.status(403).json({ error: 'This submission is not addressed to you.' });
    const feedback = req.body && req.body.feedback;
    await sql`
      UPDATE student_submissions SET feedback = ${feedback ? String(feedback).trim().slice(0, 4000) : null}, status = 'reviewed',
        reviewed_by = ${req.authUser.name}, reviewed_at = now()
      WHERE id = ${req.params.id}
    `;
    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('submissions review error:', err);
    return res.status(500).json({ error: 'Something went wrong on the server.' });
  }
});

// Lets the page ask "am I still logged in, and as whom?" on load/refresh
// instead of trusting a client-side flag — the auth middleware above has
// already rejected this request with 401 if the session cookie is missing
// or expired, so reaching this handler at all means req.authUser is valid.
// Looked up fresh from `users` (not just the id/role/name cached on the
// session row) so a role or name change since login shows up immediately
// on the next page load, same shape /api/login returns.
app.get('/api/me', async (req, res) => {
  try {
    // A Vendor Support session (see vendor-support-login.js) is never a row
    // in `users` — it's a temporary, vendor-issued identity, not a school
    // staff account. Answer it straight from the session instead of
    // re-querying `users`, or every support-login would 401 right back out
    // to the login screen the instant the page called this on load.
    if (req.authUser.id === 'vendor-support') {
      return res.status(200).json({ id: 'vendor-support', role: req.authUser.role, name: req.authUser.name });
    }
    const rows = await sql`SELECT * FROM users WHERE id = ${req.authUser.id} AND deleted_at IS NULL`;
    if (!rows.length) return res.status(401).json({ error: 'Account no longer exists.' });
    const shaped = simpleToAppShape(rows[0], SIMPLE_RESOURCES.users.fields);
    delete shaped.password;
    shaped.moduleAccess = getModuleAccess();
    return res.status(200).json(shaped);
  } catch (err) {
    console.error('me error:', err);
    return res.status(500).json({ error: 'Something went wrong on the server.' });
  }
});

// ---------- Full data backup/export ----------
// A single admin-triggered dump of every table in the database as plain
// JSON, so there's a real, human-inspectable disaster-recovery copy that
// doesn't depend on remembering to configure anything on Neon's side, and
// that can be opened and read even by someone without database access.
// Reads the table list from Postgres itself (information_schema) rather
// than hardcoding the 24+ tables from ensureSchema — that means a table
// added later (the audit log below, or anything after it) is picked up
// automatically with no risk of someone updating the schema and forgetting
// to update a separate hardcoded backup list. Table names here come from
// Postgres's own catalog, not from any request input, so building the
// SELECT with a template string is safe — there's no user-controlled value
// anywhere in it.
app.get('/api/backup', async (req, res) => {
  try {
    const tableRows = await sql`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
      ORDER BY table_name
    `;
    const backup = { generatedAt: new Date().toISOString(), tables: {} };
    for (const row of tableRows) {
      const name = row.table_name;
      backup.tables[name] = await sql.query(`SELECT * FROM "${name}"`);
    }
    // Name the download after this school, not whichever school this shared
    // template server was first written for — same slug logic as the
    // frontend's slugifySchoolName().
    let schoolSlug = 'school';
    try {
      const infoRows = await sql`SELECT data FROM school_info WHERE id = 1`;
      const rawName = infoRows[0] && infoRows[0].data && infoRows[0].data.name;
      const slug = String(rawName || '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
      if (slug) schoolSlug = slug;
    } catch (e) { /* fall back to 'school' below */ }
    const filename = `${schoolSlug}-erp-backup-${new Date().toISOString().slice(0, 10)}.json`;
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    return res.status(200).json(backup);
  } catch (err) {
    console.error('backup error:', err);
    return res.status(500).json({ error: 'Could not generate backup.' });
  }
});

// Read-only viewer for the audit log — newest first, capped at 500 rows per
// call so this stays fast and bounded no matter how long the table gets
// (the Admin-only UI reads this straight through, no further pagination
// needed for a log meant for "what changed recently," not full history
// mining).
app.get('/api/audit-log', async (req, res) => {
  try {
    const rows = await sql`SELECT * FROM audit_log ORDER BY created_at DESC LIMIT 500`;
    return res.status(200).json(rows);
  } catch (err) {
    console.error('audit-log fetch error:', err);
    return res.status(500).json({ error: 'Could not load the audit log.' });
  }
});

// The one write this app accepts from a completely anonymous caller. Every
// other POST/PUT in the app is reached only through the ERP's own UI, used
// by staff who are (for now) trusted the moment they're on the login
// screen — but this one is open to anyone who can reach the public school
// website, logged in or not. A short server-side sanity check here, in
// addition to the 20kb body-size cap above, means a bad actor can't stuff
// oversized or missing-field junk straight into the admissions pipeline.
const ADMISSION_INQUIRY_FIELD_LIMITS = {
  studentName: 120, parentName: 120, parentEmail: 160, parentPhone: 40, applyingGrade: 40, notes: 2000,
};
function validateAdmissionInquiry(body) {
  if (!body || typeof body !== 'object') return 'Invalid submission.';
  // The id is meant to be an opaque token, and index.html's admin view
  // later drops it, unescaped, inside an onclick="...('<id>')" attribute —
  // so anything containing a quote, angle bracket, backtick or backslash is
  // rejected here, since a legitimate auto-generated id never needs one.
  // This is deliberately a blocklist of the dangerous characters rather
  // than an allowlist of an assumed id format, since the public website
  // that generates these ids is a separate project this session can't see
  // the source of — a blocklist can't reject a legitimate historical id
  // whose exact shape isn't known here, while an allowlist could.
  if (!body.id || typeof body.id !== 'string' || body.id.length > 200 || /['"<>`\\]/.test(body.id)) {
    return 'Missing or invalid id.';
  }
  if (!body.parentName || !body.studentName) return 'Parent name and student name are required.';
  for (const [field, max] of Object.entries(ADMISSION_INQUIRY_FIELD_LIMITS)) {
    const v = body[field];
    if (v != null && String(v).length > max) return `${field} is too long.`;
  }
  return null;
}

// ---------- Main API route ----------
// This one route replaces the old api/[resource].js dynamic file — same
// logic, just reading the resource name from Express's route parameter
// (req.params.resource) instead of Vercel's automatic req.query.resource.
app.all('/api/:resource', async (req, res) => {
  const { resource } = req.params;
  // Log every write centrally, right here, instead of inside each of the
  // individual handlers below (handleUsers, handleSimple, handleHybrid,
  // handleSubjects, ...) — one place to get right instead of N, and any
  // future resource added to this dispatcher is covered automatically.
  // Logged from res.on('finish') so this reflects what actually happened:
  // a validation error or a DB failure further down still ends the
  // request with a 4xx/5xx and produces no log entry, same as if the
  // write had never been attempted.
  if (req.method === 'POST' || req.method === 'PUT' || req.method === 'DELETE') {
    // req.authUser now comes from a verified session (see the auth
    // middleware above) for every write except the public, unauthenticated
    // admission-inquiries submission — trust that over the client-supplied
    // x-actor-name/x-actor-role headers whenever it's present, since those
    // headers are just whatever the browser said and were never actually
    // checked against who was logged in.
    const actorName = req.authUser ? req.authUser.name : (decodeHeaderValue(req.headers['x-actor-name']) || '(unknown)');
    const actorRole = req.authUser ? req.authUser.role : (decodeHeaderValue(req.headers['x-actor-role']) || '');
    const recordId = (req.body && req.body.id) || req.query.id || null;
    // A soft-delete restore travels over the wire as a PUT (see handleUsers
    // / handleHybrid below) but reads far more clearly in the audit trail
    // under its own verb than lumped in with ordinary edits.
    const auditMethod = (req.method === 'PUT' && req.query.restore === '1') ? 'RESTORE' : req.method;
    res.on('finish', () => {
      if (res.statusCode >= 400) return;
      sql`INSERT INTO audit_log (actor_name, actor_role, method, resource, record_id)
          VALUES (${actorName}, ${actorRole}, ${auditMethod}, ${resource}, ${recordId ? String(recordId) : null})`
        .catch(err => console.error('audit log insert failed:', err));
    });
  }
  try {
    // CORS (above) only stops a BROWSER from calling this cross-origin —
    // it does nothing against a direct request from curl, a script, or
    // any other non-browser caller, and this app has no server-side auth
    // yet (see the security review) that would otherwise close that gap.
    // So this check runs for PUT too, not just the POST the public form
    // itself is meant to send.
    if (resource === 'admission-inquiries' && (req.method === 'POST' || req.method === 'PUT')) {
      const validationError = validateAdmissionInquiry(req.body);
      if (validationError) return res.status(400).json({ error: validationError });
    }
    // 'users' and 'roles' control who can log in and the permission system
    // itself — hard-locked to the built-in Admin role, unconditionally,
    // mirroring LOCKED_ADMIN_ONLY_PAGES on the client. No override, saved or
    // otherwise, can ever widen this.
    if ((resource === 'users' || resource === 'roles') && (!req.authUser || req.authUser.role !== 'Admin')) {
      return res.status(403).json({ error: 'Admin access required.' });
    }
    // A Student/Parent self-service login has no reason to see the whole
    // roster — and 'admissions' (below) is a staff module they'll never be
    // granted — but the entire "My Portal" self-service view depends on
    // fetching /api/students and finding its own linked record client-side
    // (see myProfileStudent() in index.html). Without this carve-out, every
    // Student/Parent login hit the 'admissions' check below, got a 403, and
    // silently fell back to whatever this browser's own localStorage
    // happened to have cached (empty on a fresh browser/device) — showing
    // "No student linked to this login yet" even though the link is correct
    // in the database. Scoped narrowly on purpose: only a GET, and only that
    // login's own single linked record, never the full roster and never a
    // write — everything else for 'students' still goes through the normal
    // 'admissions' gate right below.
    if (resource === 'students' && req.method === 'GET' && req.authUser && PARENT_LOGIN_ROLES.includes(req.authUser.role)) {
      const student = await getLinkedStudent(req.authUser.id);
      return res.status(200).json(student ? [hybridToAppShape(student, HYBRID_RESOURCES.students.core)] : []);
    }
    // See PARENT_OWN_RECORD_RESOURCES above — the same self-service carve-out
    // as 'students', for every other per-student table "My Portal" reads
    // (Fees and Marks). Scoped by student_id so this never returns anyone
    // else's payments, discounts, extra fees, exam results, or attendance.
    if (req.method === 'GET' && req.authUser && PARENT_LOGIN_ROLES.includes(req.authUser.role) && PARENT_OWN_RECORD_RESOURCES[resource]) {
      const student = await getLinkedStudent(req.authUser.id);
      if (!student) return res.status(200).json([]);
      const { table, fields } = PARENT_OWN_RECORD_RESOURCES[resource];
      const rows = await sql.query(`SELECT * FROM ${table} WHERE student_id = $1 ORDER BY created_at ASC NULLS LAST`, [student.id]);
      return res.status(200).json(rows.map(r => simpleToAppShape(r, fields())));
    }
    // A Teacher's access to the student roster ('admissions') can be turned
    // off entirely by an admin via Roles & Permissions — and when it is,
    // that otherwise 403s /api/students outright for every Teacher login
    // and leaves Attendance and Marks Entry with an empty roster for EVERY
    // class, including their own, since both screens resolve "who's in
    // this class" from this same endpoint. That 'admissions' toggle is
    // about the full roster-management screen (add/edit/delete any
    // student) — a Teacher still needs to see the students in the specific
    // classes they're allotted to, same as they can already see those
    // classes' attendance and marks. So regardless of how 'admissions' is
    // set, a GET here for a Teacher login always returns just the students
    // in their homeroom class and/or the class/sections of the subjects
    // they're assigned to teach — see getTeacherScope above — never the
    // rest of the school's roster, and never a write (adding/editing a
    // student still goes through the normal 'admissions' permission).
    if (resource === 'students' && req.method === 'GET' && req.authUser && req.authUser.role === 'Teacher') {
      const scope = await getTeacherScope(req.authUser.id);
      const pairs = [];
      if (scope.classTeacherOf) pairs.push(scope.classTeacherOf);
      scope.subjectSections.forEach(ss => {
        if (!pairs.some(p => p.className === ss.className && p.section === ss.section)) {
          pairs.push({ className: ss.className, section: ss.section });
        }
      });
      if (!pairs.length) return res.status(200).json([]);
      const rows = await sql`SELECT * FROM students WHERE deleted_at IS NULL`;
      const filtered = rows.filter(r => pairs.some(p => p.className === r.class_name && p.section === r.section));
      return res.status(200).json(filtered.map(r => hybridToAppShape(r, HYBRID_RESOURCES.students.core)));
    }
    // A Teacher login only ever gets to see or touch attendance for the one
    // class they're the Class Teacher of, and exam marks for the
    // subject+section combinations they're the assigned Subject Teacher
    // for — see getTeacherScope above. Reads are scoped down to that (never
    // a 403 — an empty result, same spirit as the Parent carve-outs above),
    // writes are checked against the specific student/subject in the
    // request and rejected outright if it falls outside their duties. This
    // runs before the blanket 'attendance'/'exams'/'result' module check
    // below because that check only knows the Teacher role can touch these
    // modules at all, not which class/subject. Admin/Principal never hit
    // this — MANAGEMENT_ROLES-only pages aside, checkModuleAccess already
    // lets them through everything unconditionally.
    if (req.authUser && req.authUser.role === 'Teacher' && (resource === 'attendance' || resource === 'exam-results')) {
      const scope = await getTeacherScope(req.authUser.id);
      if (resource === 'attendance') {
        if (req.method === 'GET') {
          if (!scope.classTeacherOf) return res.status(200).json([]);
          const studentRows = await sql`SELECT id FROM students WHERE class_name = ${scope.classTeacherOf.className} AND section = ${scope.classTeacherOf.section}`;
          const ids = studentRows.map(s => s.id);
          if (!ids.length) return res.status(200).json([]);
          const placeholders = ids.map((_, i) => `$${i + 1}`).join(', ');
          const rows = await sql.query(`SELECT * FROM attendance_records WHERE student_id IN (${placeholders}) ORDER BY created_at ASC NULLS LAST`, ids);
          return res.status(200).json(rows.map(r => simpleToAppShape(r, SIMPLE_RESOURCES.attendance.fields)));
        }
        if (['POST', 'PUT', 'DELETE'].includes(req.method)) {
          let targetStudentId = (req.body || {}).studentId || null;
          if (req.method === 'DELETE') {
            const { id } = req.query;
            const existing = id ? await sql`SELECT student_id FROM attendance_records WHERE id = ${id}` : [];
            targetStudentId = existing.length ? existing[0].student_id : null;
          }
          const inScope = targetStudentId && scope.classTeacherOf &&
            (await sql`SELECT 1 FROM students WHERE id = ${targetStudentId} AND class_name = ${scope.classTeacherOf.className} AND section = ${scope.classTeacherOf.section}`).length > 0;
          if (!inScope) return res.status(403).json({ error: 'You can only manage attendance for your own homeroom class.' });
        }
      }
      if (resource === 'exam-results') {
        const isMySubjectSection = (subject, className, section) =>
          scope.subjectSections.some(ss => ss.subject === subject && ss.className === className && ss.section === section);
        if (req.method === 'GET') {
          if (!scope.subjectSections.length) return res.status(200).json([]);
          const allRows = await sql`SELECT * FROM exam_results ORDER BY created_at ASC NULLS LAST`;
          const studentIds = [...new Set(allRows.map(r => r.student_id))];
          const classMap = await studentClassMap(studentIds);
          const filtered = allRows.filter(r => {
            const cls = classMap[r.student_id];
            return cls && isMySubjectSection(r.subject, cls.className, cls.section);
          });
          return res.status(200).json(filtered.map(r => simpleToAppShape(r, SIMPLE_RESOURCES['exam-results'].fields)));
        }
        if (['POST', 'PUT', 'DELETE'].includes(req.method)) {
          let targetStudentId, targetSubject;
          if (req.method === 'DELETE') {
            const { id } = req.query;
            const existing = id ? await sql`SELECT student_id, subject FROM exam_results WHERE id = ${id}` : [];
            targetStudentId = existing.length ? existing[0].student_id : null;
            targetSubject = existing.length ? existing[0].subject : null;
          } else {
            targetStudentId = (req.body || {}).studentId || null;
            targetSubject = (req.body || {}).subject || null;
          }
          const cls = targetStudentId ? (await studentClassMap([targetStudentId]))[targetStudentId] : null;
          const inScope = cls && targetSubject && isMySubjectSection(targetSubject, cls.className, cls.section);
          if (!inScope) return res.status(403).json({ error: 'You can only enter marks for a class/subject you are assigned to teach.' });
        }
      }
    }
    // A Teacher login has no 'staff' module access — that's the Staff
    // directory, a separate concern — but the class/subject-teacher duty
    // scoping just above (and myTeacherScope() on the client) both need
    // every staff record's linkedUserId/classTeacherClass/classTeacherSection
    // just to work at all: resolving "which staff record is me" and,
    // elsewhere in the app, "who is the Class Teacher of this student's
    // section." Without this, a Teacher's own classTeacherClass lookup
    // silently comes back empty and their homeroom class never appears —
    // which is exactly the bug this carve-out fixes. It exposes only that
    // narrow, non-sensitive scheduling subset for every OTHER staff
    // member — never a colleague's phone, address, salary, or any other
    // personal field that might live in their `extra` — while the caller's
    // own record still comes back in full (their own data, nothing to
    // protect it from).
    if (req.method === 'GET' && resource === 'staff' && req.authUser && req.authUser.role === 'Teacher') {
      const rows = await sql`SELECT * FROM staff ORDER BY created_at ASC NULLS LAST`;
      return res.status(200).json(rows.map(r => {
        const shapedCore = {};
        HYBRID_RESOURCES.staff.core.forEach(f => { shapedCore[f.app] = r[f.col]; });
        const extra = r.extra || {};
        if (extra.linkedUserId === req.authUser.id) return { ...shapedCore, ...extra };
        const safeExtra = {};
        if (extra.classTeacherClass !== undefined) safeExtra.classTeacherClass = extra.classTeacherClass;
        if (extra.classTeacherSection !== undefined) safeExtra.classTeacherSection = extra.classTeacherSection;
        if (extra.linkedUserId !== undefined) safeExtra.linkedUserId = extra.linkedUserId;
        return { ...shapedCore, ...safeExtra };
      }));
    }
    // Roles & Permissions enforcement (see the block above HYBRID_RESOURCES):
    // a resource mapped here 403s for a role that the admin has explicitly
    // denied that module to; anything unmapped is unaffected. A
    // Student/Parent login reading one of PARENT_SHARED_REFERENCE_RESOURCES
    // (see above) skips this — there's nothing per-student to leak in a fee
    // schedule, an exam's dates, or the subject list, and the self-service
    // portal can't work correctly without being able to read them.
    const parentSharedBypass = req.method === 'GET' && req.authUser && PARENT_LOGIN_ROLES.includes(req.authUser.role) && PARENT_SHARED_REFERENCE_RESOURCES.includes(resource);
    if (RESOURCE_TO_MODULE[resource]) {
      // Plan gating (see checkPlanModuleAccess above) applies regardless of
      // role — including Admin and the parent/student shared-reference
      // bypass — since it's about what the school paid for, not who's asking.
      const planOk = await checkPlanModuleAccess(req, res, RESOURCE_TO_MODULE[resource]);
      if (!planOk) return;
    }
    if (RESOURCE_TO_MODULE[resource] && !parentSharedBypass) {
      const allowed = await checkModuleAccess(req, res, RESOURCE_TO_MODULE[resource]);
      if (!allowed) return; // checkModuleAccess already sent the 403
    }
    // 'users' is also in SIMPLE_RESOURCES (its column/field list is reused
    // by handleUsers above), but takes its own dedicated handler instead of
    // the generic one because of the password rules described there.
    if (resource === 'users') return await handleUsers(req, res);
    if (SIMPLE_RESOURCES[resource]) return await handleSimple(req, res, SIMPLE_RESOURCES[resource], resource);
    if (HYBRID_RESOURCES[resource]) return await handleHybrid(req, res, HYBRID_RESOURCES[resource]);
    if (resource === 'subjects') return await handleSubjects(req, res);
    if (resource === 'exam-defs') return await handleExamDefs(req, res);
    if (resource === 'roles') return await handleRoles(req, res);
    if (resource === 'fee-structure') return await handleFeeStructure(req, res);
    if (resource === 'attendance-settings') return await handleAttendanceSettings(req, res);
    if (resource === 'school-info') return await handleSchoolInfo(req, res);
    return res.status(404).json({ error: `Unknown resource: ${resource}` });
  } catch (err) {
    console.error(`${resource} API error:`, err);
    reportVendorError(err, { route: req.path });
    return res.status(500).json({ error: 'Something went wrong on the server.' });
  }
});

// A request body that's still too large (bigger than the 25mb limit above)
// or isn't valid JSON reaches here as an error instead of a route handler.
// Without this, Express's default error page is a raw HTML blob with a 413
// or 400 status — the frontend's fetch calls now check response.ok (see
// index.html), so they need a real JSON body to work with, and a person
// checking the browser's Network tab gets an actual explanation instead of
// a wall of HTML.
app.use((err, req, res, next) => {
  if (err && err.type === 'entity.too.large') {
    return res.status(413).json({ error: 'That upload is too large. Try a smaller photo or file.' });
  }
  if (err && err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'Malformed request.' });
  }
  if (err) {
    console.error('Unhandled error:', err);
    return res.status(500).json({ error: 'Something went wrong on the server.' });
  }
  next();
});

// ---------- Serve the ERP itself ----------
// Put your ERP's index.html (and any other static assets) in the "public"
// folder next to this file — Express serves it directly, same origin as
// the API, so the frontend's existing fetch('/api/...') calls just work.
app.use(express.static(path.join(__dirname, 'public')));
app.get(/.*/, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
