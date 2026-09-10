// Vendor Support Login — a small, optional module a school's ERP server can
// use to accept a short-lived, signed "troubleshooting" link issued by the
// Vendor Dashboard (Schools tab → Support Login). It lets you (the vendor)
// open that school's ERP to help troubleshoot without ever knowing or
// resetting that school's own admin password.
//
// This is entirely opt-in, exactly like vendor-reporting.js, and reuses the
// SAME VENDOR_API_KEY env var that reporting already needs — the dashboard
// signs each token with that same per-school key, so there's no extra
// secret to provision or rotate separately.
//
// ---------------------------------------------------------------------
// HOW TO ADD THIS TO A SCHOOL'S server.js
// ---------------------------------------------------------------------
// 1. Copy this file into that school's project, alongside server.js.
// 2. Near the top of server.js, after the other imports:
//
//      import { handleVendorSupportLogin } from './vendor-support-login.js';
//
// 3. Add ONE route, alongside your other routes that don't require a
//    normal login — this route protects itself with the signed token, the
//    same way /api/ingest/heartbeat protects itself with schoolId+apiKey:
//
//      app.get('/api/vendor-support-login', (req, res) => {
//        handleVendorSupportLogin(req.query.token, {
//          onValid: async (payload) => {
//            // Create YOUR app's own session here, exactly the way a normal
//            // admin login does after a correct password — e.g.:
//            //   await createSession(req, res, { id: 'support', name: 'Vendor Support (' + payload.adminName + ')' });
//            //   res.redirect('/');
//          },
//          onInvalid: (reason) => {
//            res.status(401).send('This support login link is invalid or has expired (' + reason + '). Ask your vendor to generate a new one.');
//          },
//        });
//      });
//
//    The session `onValid` creates is entirely up to your app — give it
//    the same admin-level access a real login would, but name it
//    distinctly (e.g. "Vendor Support") so it's obviously not a real staff
//    login if anyone reviews an audit trail later.
//
// 4. Set VENDOR_API_KEY in this school's environment — the exact same value
//    already used for vendor-reporting.js (see that file). If reporting
//    isn't wired up yet, get this school's API key from the dashboard's
//    Edit School screen (Regenerate rotates it — update the env var here
//    to match if you do).
//
// Leaving VENDOR_API_KEY unset means Support Login can never succeed for
// this school (every token fails verification) — safe, not a crash. Each
// token is single-purpose and expires 10 minutes after the vendor
// generates it; the dashboard also logs every issuance for accountability
// (Overview tab → Recent Activity, and GET /api/support-logins).
// ---------------------------------------------------------------------

import crypto from 'crypto';

const API_KEY = process.env.VENDOR_API_KEY;

function base64urlDecode(str) {
  return Buffer.from(str, 'base64url').toString('utf8');
}

/**
 * Verify a support-login token. Returns { valid: true, payload } with
 * payload = { schoolId, adminId, adminName, iat, exp }, or
 * { valid: false, reason }. Pure/synchronous — no network calls, so it's
 * safe to call from inside a request handler with no extra latency.
 */
export function verifyVendorSupportToken(token) {
  if (!API_KEY) return { valid: false, reason: 'not_configured' };
  if (!token || typeof token !== 'string' || !token.includes('.')) return { valid: false, reason: 'malformed' };
  const [body, sig] = token.split('.');
  if (!body || !sig) return { valid: false, reason: 'malformed' };
  let sigBuf, expectedBuf;
  try {
    const expectedSig = crypto.createHmac('sha256', API_KEY).update(body).digest('base64url');
    sigBuf = Buffer.from(sig);
    expectedBuf = Buffer.from(expectedSig);
  } catch (e) {
    return { valid: false, reason: 'malformed' };
  }
  // Constant-time comparison — this is a security boundary, so a naive
  // === must never be used here (it can leak the secret via timing).
  if (sigBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(sigBuf, expectedBuf)) {
    return { valid: false, reason: 'bad_signature' };
  }
  let payload;
  try {
    payload = JSON.parse(base64urlDecode(body));
  } catch (e) {
    return { valid: false, reason: 'malformed' };
  }
  if (!payload || typeof payload.exp !== 'number') return { valid: false, reason: 'malformed' };
  if (Date.now() > payload.exp) return { valid: false, reason: 'expired' };
  return { valid: true, payload };
}

/**
 * Convenience wrapper for the one route this needs — see the usage example
 * at the top of this file. `onValid(payload)` should establish this app's
 * own session and respond (e.g. redirect to '/'); `onInvalid(reason)`
 * should respond with an error. Exactly one of the two is called.
 */
export function handleVendorSupportLogin(token, { onValid, onInvalid }) {
  const result = verifyVendorSupportToken(token);
  if (result.valid) onValid(result.payload);
  else onInvalid(result.reason);
}
