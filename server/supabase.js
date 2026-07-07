'use strict';
// Minimal Supabase client over its REST APIs (PostgREST + Realtime broadcast).
// Plain fetch, no dependencies. Only active when the env vars are present —
// otherwise the engine runs on its local file store exactly as before.

const URL_ = process.env.SUPABASE_URL ? process.env.SUPABASE_URL.replace(/\/+$/, '') : null;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || null;
const ANON = process.env.SUPABASE_ANON_KEY || null;

const enabled = !!(URL_ && KEY);

async function req(method, path, body, prefer) {
  const headers = {
    apikey: KEY,
    Authorization: 'Bearer ' + KEY,
    'Content-Type': 'application/json'
  };
  if (prefer) headers.Prefer = prefer;
  const r = await fetch(URL_ + path, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  if (!r.ok) {
    const detail = await r.text().catch(() => '');
    throw new Error(`Supabase ${method} ${path} → ${r.status} ${detail}`.slice(0, 400));
  }
  if (r.status === 204) return null;
  const text = await r.text();
  return text ? JSON.parse(text) : null;
}

const select = (table, query) => req('GET', `/rest/v1/${table}?${query}`);
const insert = (table, rows, prefer) => req('POST', `/rest/v1/${table}`, rows, prefer || 'return=minimal');
const upsert = (table, rows) => req('POST', `/rest/v1/${table}`, rows, 'return=minimal,resolution=merge-duplicates');
const update = (table, query, patch) => req('PATCH', `/rest/v1/${table}?${query}`, patch, 'return=minimal');
const del = (table, query) => req('DELETE', `/rest/v1/${table}?${query}`);
const rpc = (name, args) => req('POST', `/rest/v1/rpc/${name}`, args || {});

// Realtime broadcast: a "sync" ping tells every connected client to refetch
// state. No world data travels on the channel, so the anon key stays harmless.
async function broadcast(topic, event, payload) {
  try {
    await req('POST', '/realtime/v1/api/broadcast', { messages: [{ topic, event, payload: payload || {} }] });
  } catch (e) {
    console.error('realtime broadcast failed:', e.message); // clients fall back to polling
  }
}

module.exports = { enabled, url: URL_, anonKey: ANON, select, insert, upsert, update, del, rpc, broadcast };
