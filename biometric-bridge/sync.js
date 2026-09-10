#!/usr/bin/env node
/*
 * Biometric attendance bridge — run this on a PC on the SAME local network
 * as the school's biometric device(s), never on the ERP's own server (the
 * ERP is cloud-hosted and has no route into a school's private LAN).
 *
 * What it does, every cycle:
 *   1. Connects to the device over the network using its own SDK protocol
 *      (ZKTeco-protocol, TCP, port 4370 by default — see README.md for why
 *      this covers most budget/mid-range devices sold under eSSL, ZKTeco,
 *      Realtime, and Mantra branding).
 *   2. Reads its attendance log.
 *   3. Keeps only punches newer than the last successful sync (tracked in
 *      .sync-state.json next to this file) — so a device holding months of
 *      history doesn't get re-sent every cycle.
 *   4. POSTs the new ones to that school's ERP (/api/biometric/punches),
 *      authenticated with BIOMETRIC_API_KEY.
 *   5. Only advances the "last synced" watermark after the ERP confirms
 *      receipt — a failed push is retried next cycle instead of being lost.
 *
 * See README.md in this folder before running this for the first time.
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

const STATE_FILE = path.join(__dirname, '.sync-state.json');

const CONFIG = {
  deviceIp: process.env.DEVICE_IP,
  devicePort: parseInt(process.env.DEVICE_PORT || '4370', 10),
  deviceSerial: process.env.DEVICE_SERIAL || process.env.DEVICE_IP || 'device',
  erpUrl: (process.env.ERP_URL || '').replace(/\/$/, ''),
  apiKey: process.env.BIOMETRIC_API_KEY,
  pollIntervalMs: Math.max(1, parseInt(process.env.POLL_INTERVAL_MINUTES || '5', 10)) * 60 * 1000,
};

function assertConfigured() {
  const missing = [];
  if (!CONFIG.deviceIp) missing.push('DEVICE_IP');
  if (!CONFIG.erpUrl || CONFIG.erpUrl.includes('REPLACE-WITH')) missing.push('ERP_URL');
  if (!CONFIG.apiKey) missing.push('BIOMETRIC_API_KEY');
  if (missing.length) {
    console.error(`[biometric-bridge] Missing required setting(s) in .env: ${missing.join(', ')}`);
    console.error('[biometric-bridge] Copy .env.example to .env and fill it in — see README.md.');
    process.exit(1);
  }
}

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch (e) {
    return { lastSyncedAt: null };
  }
}
function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

// node-zklib's exact return shape has drifted across versions/forks, and
// different device firmwares report field names differently too (userId vs
// deviceUserId vs uid; timestamp vs recordTime). Rather than assume one
// shape and silently drop records that don't match it, this tries every
// name seen in practice and logs a clear warning (with the raw record) for
// anything it can't recognize, so a first-time setup surfaces the mismatch
// immediately instead of silently syncing nothing.
function normalizeRecord(raw) {
  const userId = raw.userId ?? raw.deviceUserId ?? raw.uid ?? raw.user_id ?? raw.id;
  const rawTime = raw.timestamp ?? raw.recordTime ?? raw.record_time ?? raw.time ?? raw.checkTime;
  if (userId === undefined || userId === null || !rawTime) return null;
  const when = rawTime instanceof Date ? rawTime : new Date(rawTime);
  if (isNaN(when.getTime())) return null;
  return { deviceUserId: String(userId).trim(), timestamp: when.toISOString() };
}

async function fetchDeviceLogs() {
  // Required lazily so `--test`/setup errors about a missing DEVICE_IP
  // surface before this dependency is even touched.
  const ZKLib = require('node-zklib');
  const zk = new ZKLib(CONFIG.deviceIp, CONFIG.devicePort, 10000, 4000);
  await zk.createSocket();
  try {
    const result = await zk.getAttendances();
    const records = (result && result.data) || [];
    return records;
  } finally {
    try { await zk.disconnect(); } catch (e) { /* already gone, fine */ }
  }
}

function postJson(url, body, headers) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    const data = JSON.stringify(body);
    const req = lib.request(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), ...headers },
    }, (res) => {
      let raw = '';
      res.on('data', (c) => { raw += c; });
      res.on('end', () => {
        let parsed = null;
        try { parsed = JSON.parse(raw); } catch (e) { /* non-JSON error page, handled below */ }
        if (res.statusCode >= 200 && res.statusCode < 300) resolve(parsed || {});
        else reject(new Error(`ERP responded ${res.statusCode}: ${(parsed && parsed.error) || raw.slice(0, 200)}`));
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

async function runOnce() {
  const state = loadState();
  const since = state.lastSyncedAt ? new Date(state.lastSyncedAt) : null;
  console.log(`[biometric-bridge] Connecting to device at ${CONFIG.deviceIp}:${CONFIG.devicePort}...`);

  let rawRecords;
  try {
    rawRecords = await fetchDeviceLogs();
  } catch (err) {
    console.error(`[biometric-bridge] Could not read the device — ${err.message}. Will retry next cycle.`);
    return;
  }

  const normalized = [];
  let unrecognized = 0;
  for (const raw of rawRecords) {
    const rec = normalizeRecord(raw);
    if (!rec) { unrecognized++; continue; }
    if (since && new Date(rec.timestamp) <= since) continue; // already synced
    normalized.push(rec);
  }
  if (unrecognized) {
    console.warn(`[biometric-bridge] ${unrecognized} record(s) from the device didn't match any known field names — sample:`, rawRecords[0]);
    console.warn('[biometric-bridge] If this keeps happening, this device/firmware may report fields differently — see the normalizeRecord() comment in sync.js.');
  }

  if (!normalized.length) {
    console.log('[biometric-bridge] No new punches since last sync.');
    return;
  }

  console.log(`[biometric-bridge] Sending ${normalized.length} new punch(es) to ${CONFIG.erpUrl}...`);
  try {
    const result = await postJson(`${CONFIG.erpUrl}/api/biometric/punches`, {
      deviceSerial: CONFIG.deviceSerial,
      punches: normalized,
    }, { 'x-biometric-api-key': CONFIG.apiKey });
    console.log(`[biometric-bridge] Sent. Matched to staff: ${result.matched ?? '?'}, unmatched: ${result.unmatched ?? '?'}.`);
    const maxTs = normalized.reduce((max, r) => (r.timestamp > max ? r.timestamp : max), since ? since.toISOString() : normalized[0].timestamp);
    saveState({ lastSyncedAt: maxTs });
  } catch (err) {
    console.error(`[biometric-bridge] Could not reach the ERP — ${err.message}. Nothing marked as synced; will retry these punches next cycle.`);
  }
}

async function testConnection() {
  console.log(`[biometric-bridge] Test mode — connecting to ${CONFIG.deviceIp}:${CONFIG.devicePort} and printing up to 3 raw records, without sending anything.`);
  try {
    const records = await fetchDeviceLogs();
    console.log(`[biometric-bridge] Device responded with ${records.length} total record(s) in its log. Sample:`);
    console.log(JSON.stringify(records.slice(0, 3), null, 2));
    console.log('[biometric-bridge] Compare the field names above against normalizeRecord() in sync.js — adjust it if this device reports different field names.');
  } catch (err) {
    console.error(`[biometric-bridge] Could not connect: ${err.message}`);
    console.error('[biometric-bridge] Double-check DEVICE_IP/DEVICE_PORT in .env, and that this PC is on the same network as the device.');
    process.exit(1);
  }
}

async function main() {
  assertConfigured();
  const mode = process.argv.includes('--test') ? 'test' : process.argv.includes('--once') ? 'once' : 'loop';
  if (mode === 'test') return testConnection();
  if (mode === 'once') return runOnce();
  console.log(`[biometric-bridge] Starting — polling every ${CONFIG.pollIntervalMs / 60000} minute(s). Press Ctrl+C to stop.`);
  await runOnce();
  setInterval(runOnce, CONFIG.pollIntervalMs);
}

main().catch((err) => {
  console.error('[biometric-bridge] Unexpected error:', err);
  process.exit(1);
});
