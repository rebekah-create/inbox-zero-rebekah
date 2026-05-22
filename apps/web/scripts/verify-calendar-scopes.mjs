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

function decryptToken(value) {
  if (!value) return null;
  const versioned = value.match(/^v(\d+):([0-9a-f]+)$/i);
  const hex = versioned ? versioned[2] : value;
  if (!/^[0-9a-f]+$/i.test(hex)) return value; // plaintext passthrough
  const buf = Buffer.from(hex, "hex");
  if (buf.length < 32) return value;
  const iv = buf.subarray(0, 16);
  const tag = buf.subarray(16, 32);
  const enc = buf.subarray(32);
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

const accessToken = decryptToken(process.env.ENC_ACCESS);
const refreshTokenVal = decryptToken(process.env.ENC_REFRESH);

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
