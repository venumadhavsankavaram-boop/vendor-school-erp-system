// Vendor Fleet Reporting Client — a small, optional, fail-silent module a
// school's own ERP server can load to report its status to your Vendor
// Fleet Dashboard (see ../vendor-dashboard). It sends a periodic heartbeat
// and reports unhandled errors. It is entirely opt-in per deployment:
//
//   - If the three env vars below aren't set, this does absolutely
//     nothing — no crash, no log noise, no network calls. A school you
//     haven't wired up to the dashboard yet is completely unaffected.
//   - Every network call is wrapped in try/catch with a short timeout and
//     never throws or blocks — the dashboard being slow, asleep, or
//     unreachable can never cause a problem for the school's own ERP.
//   - It never sends anything about the school's actual data (no student
//     records, no attendance, no fees) — only operational signals: "I'm
//     alive", and "here's an error message and stack trace".
//
// ---------------------------------------------------------------------
// HOW TO ADD THIS TO A SCHOOL'S server.js
// ---------------------------------------------------------------------
// 1. Copy this file into that school's project (e.g. alongside server.js).
// 2. Near the top of server.js, after the other imports, add:
//
//      import { startVendorReporting, reportVendorError } from './vendor-reporting.js';
//      startVendorReporting();
//
// 3. To also catch errors from within a specific route handler's catch
//    block (recommended for your main resource handler), call:
//
//      reportVendorError(err, { route: req.path });
//
//    in a catch block, alongside your existing console.error(...) — this
//    is additive, not a replacement for the school's own error logging.
//
// 4. In that school's Render service, set three environment variables:
//      VENDOR_DASHBOARD_URL   e.g. https://your-vendor-dashboard.onrender.com
//      VENDOR_SCHOOL_ID       from the dashboard's "Add School" / "Edit School" screen
//      VENDOR_API_KEY         from the same screen (regenerate any time if it leaks)
//
// That's it — nothing else in server.js needs to change, and leaving these
// env vars unset (e.g. for a school you don't want reporting) is fully
// supported and silent.
// ---------------------------------------------------------------------

const DASHBOARD_URL = process.env.VENDOR_DASHBOARD_URL;
const SCHOOL_ID = process.env.VENDOR_SCHOOL_ID;
const API_KEY = process.env.VENDOR_API_KEY;
const ENABLED = Boolean(DASHBOARD_URL && SCHOOL_ID && API_KEY);

const HEARTBEAT_INTERVAL_MS = 5 * 60 * 1000; // every 5 minutes
const FETCH_TIMEOUT_MS = 8000;
const ERROR_DEDUPE_WINDOW_MS = 5 * 60 * 1000; // don't spam the same error repeatedly

let lastErrorSignatures = new Map(); // message -> last-sent timestamp

async function postToDashboard(path, body) {
  if (!ENABLED) return;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    await fetch(DASHBOARD_URL.replace(/\/$/, '') + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(Object.assign({ schoolId: SCHOOL_ID, apiKey: API_KEY }, body)),
      signal: controller.signal,
    });
  } catch (e) {
    // Deliberately silent — the vendor dashboard being unreachable must
    // never affect this school's own server. Nothing to log here that
    // the dashboard's own "offline" status won't already show you.
  } finally {
    clearTimeout(timeout);
  }
}

function sendHeartbeat() {
  postToDashboard('/api/ingest/heartbeat', {
    meta: {
      uptimeSeconds: Math.round(process.uptime()),
      nodeVersion: process.version,
      reportedAt: new Date().toISOString(),
    },
  });
}

/** Call once, near the top of server.js, after the other imports. */
export function startVendorReporting() {
  if (!ENABLED) return;
  sendHeartbeat();
  setInterval(sendHeartbeat, HEARTBEAT_INTERVAL_MS).unref();

  // Best-effort net for anything that slips past the app's own error
  // handling — catches truly unhandled cases without changing how they're
  // otherwise handled (Node still logs/exits per its own default behavior).
  process.on('uncaughtException', err => reportVendorError(err, { source: 'uncaughtException' }));
  process.on('unhandledRejection', reason => {
    const err = reason instanceof Error ? reason : new Error(String(reason));
    reportVendorError(err, { source: 'unhandledRejection' });
  });
}

/**
 * Call from a catch block to report an error, e.g.:
 *   catch (err) { console.error('save error:', err); reportVendorError(err, { route: req.path }); }
 * Safe to call even when reporting is disabled (env vars unset) — it's a no-op.
 */
export function reportVendorError(err, meta) {
  if (!ENABLED || !err) return;
  const message = String((err && err.message) || err).slice(0, 500);
  const now = Date.now();
  const lastSent = lastErrorSignatures.get(message);
  if (lastSent && now - lastSent < ERROR_DEDUPE_WINDOW_MS) return; // same error recently reported — skip
  lastErrorSignatures.set(message, now);
  // Keep the dedupe map from growing unbounded over a long-running process.
  if (lastErrorSignatures.size > 200) {
    const cutoff = now - ERROR_DEDUPE_WINDOW_MS;
    for (const [k, t] of lastErrorSignatures) if (t < cutoff) lastErrorSignatures.delete(k);
  }
  postToDashboard('/api/ingest/error', {
    message,
    stack: err && err.stack ? String(err.stack).slice(0, 4000) : undefined,
    meta,
  });
}
