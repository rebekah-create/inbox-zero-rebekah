#!/usr/bin/env node
// One-shot operator script. Self-contained — uses only Node built-ins (crypto, fetch).
// Designed to run inside the production `inbox-zero-app` container, where the
// Next.js standalone bundle does not include tsx or arbitrary source files.
//
// Reads encrypted tokens passed via env vars (ENC_ACCESS / ENC_REFRESH), decrypts
// using the project's aes-256-gcm scheme (matches apps/web/utils/encryption.ts),
// refreshes if needed via Google's token endpoint, then queries
// oauth2.googleapis.com/tokeninfo for the live granted scope list.
//
// Read-only: makes no DB writes and persists no rotated tokens.
//
// Required env:
//   EMAIL_ENCRYPT_SECRET, EMAIL_ENCRYPT_SALT   — key derivation inputs
//   GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET     — for refresh grant
//   ENC_ACCESS, ENC_REFRESH                    — ciphertext from CalendarConnection row

import crypto from "node:crypto";

const required = [
  "EMAIL_ENCRYPT_SECRET",
  "EMAIL_ENCRYPT_SALT",
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
  "ENC_ACCESS",
  "ENC_REFRESH",
];
for (const k of required) {
  if (!process.env[k]) {
    console.error(`Missing required env var: ${k}`);
    process.exit(3);
  }
}

const KEY = crypto.scryptSync(
  process.env.EMAIL_ENCRYPT_SECRET,
  process.env.EMAIL_ENCRYPT_SALT,
  32,
);

// SECURITY: keep in sync with apps/web/utils/encryption.ts (canonical impl).
// This script is intentionally standalone (no imports from the bundle) because
// it runs inside the production standalone container which doesn't ship source.
// If the canonical impl gains a new key version, port the version dispatch
// here too. Currently only v1 is supported — unknown versions throw.
const SUPPORTED_VERSION = 1;
const IV_LENGTH = 16;
const AUTH_TAG_LENGTH = 16;
const MIN_CIPHERTEXT_BYTES = IV_LENGTH + AUTH_TAG_LENGTH; // 32

function decryptToken(value) {
  if (!value) return null;
  const versioned = value.match(/^v(\d+):([0-9a-f]+)$/i);
  if (versioned) {
    const version = Number(versioned[1]);
    if (version !== SUPPORTED_VERSION) {
      // Canonical impl throws "Unknown encryption version" — match that.
      throw new Error(`Unknown encryption version: v${version}`);
    }
    const buf = Buffer.from(versioned[2], "hex");
    if (buf.length < MIN_CIPHERTEXT_BYTES) {
      // Canonical impl throws "Ciphertext too short" — match that rather
      // than silently returning the still-encrypted input.
      throw new Error("Ciphertext too short");
    }
    return decryptBuffer(buf);
  }
  // Legacy unversioned path: try to decrypt as raw hex ciphertext; on failure
  // warn and treat as plaintext (matches canonical tryLegacyDecrypt).
  if (!/^[0-9a-f]+$/i.test(value)) return value; // plaintext passthrough
  if (value.length < MIN_CIPHERTEXT_BYTES * 2) return value;
  const buf = Buffer.from(value, "hex");
  try {
    return decryptBuffer(buf);
  } catch (err) {
    console.warn(
      `Legacy decrypt attempt failed; treating as plaintext: ${err?.message ?? String(err)}`,
    );
    return value;
  }
}

function decryptBuffer(buf) {
  const iv = buf.subarray(0, IV_LENGTH);
  const tag = buf.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
  const enc = buf.subarray(IV_LENGTH + AUTH_TAG_LENGTH);
  const d = crypto.createDecipheriv("aes-256-gcm", KEY, iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(enc), d.final()]).toString("utf8");
}

async function tokeninfo(token) {
  const resp = await fetch(
    `https://oauth2.googleapis.com/tokeninfo?access_token=${encodeURIComponent(token)}`,
  );
  const body = await resp.text();
  return { ok: resp.ok, status: resp.status, body };
}

async function refresh(refreshToken) {
  const params = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID,
    client_secret: process.env.GOOGLE_CLIENT_SECRET,
    refresh_token: refreshToken,
    grant_type: "refresh_token",
  });
  const resp = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params,
  });
  const body = await resp.text();
  return { ok: resp.ok, status: resp.status, body };
}

let accessToken;
let refreshTokenVal;
try {
  accessToken = decryptToken(process.env.ENC_ACCESS);
  refreshTokenVal = decryptToken(process.env.ENC_REFRESH);
} catch (err) {
  console.log(
    `CALENDAR_SCOPE_VERDICT: FAIL — could not decrypt tokens: ${err?.message ?? String(err)}`,
  );
  process.exit(2);
}

if (!accessToken || !refreshTokenVal) {
  console.log("CALENDAR_SCOPE_VERDICT: FAIL — could not decrypt tokens");
  process.exit(2);
}

let ti = await tokeninfo(accessToken);
let refreshed = false;
if (!ti.ok) {
  console.log(
    `Stored access token rejected by tokeninfo (${ti.status}). Refreshing...`,
  );
  const r = await refresh(refreshTokenVal);
  if (!r.ok) {
    console.log(`Refresh failed: ${r.status} ${r.body.slice(0, 300)}`);
    console.log(
      "CALENDAR_SCOPE_VERDICT: FAIL — token refresh failed; re-consent required",
    );
    process.exit(2);
  }
  refreshed = true;
  const newToken = JSON.parse(r.body).access_token;
  ti = await tokeninfo(newToken);
}

if (!ti.ok) {
  console.log(`tokeninfo failed: ${ti.status} ${ti.body.slice(0, 300)}`);
  console.log("CALENDAR_SCOPE_VERDICT: FAIL — tokeninfo unavailable");
  process.exit(2);
}

const data = JSON.parse(ti.body);
const scopeStr = (data.scope ?? "").trim();
const scopes = scopeStr ? scopeStr.split(/\s+/) : [];

console.log(`refreshed_during_probe: ${refreshed}`);
console.log(`LIVE_TOKENINFO_SCOPES: ${scopeStr}`);
console.log("");

const READONLY = "https://www.googleapis.com/auth/calendar.readonly";
const EVENTS = "https://www.googleapis.com/auth/calendar.events";
const hasReadonly = scopes.includes(READONLY);
const hasEvents = scopes.includes(EVENTS);

console.log(`has calendar.readonly: ${hasReadonly}`);
console.log(`has calendar.events:   ${hasEvents}`);

let verdict;
if (hasReadonly && hasEvents) verdict = "OK";
else if (hasReadonly && !hasEvents)
  verdict =
    "PARTIAL — phase 8 ok, phase 9 will 403 on event creation (calendar.events not granted; re-consent required before phase 9 ships)";
else if (!hasReadonly) verdict = "FAIL — re-consent required";
else verdict = "UNEXPECTED — investigate manually";

console.log("");
console.log(`CALENDAR_SCOPE_VERDICT: ${verdict}`);
