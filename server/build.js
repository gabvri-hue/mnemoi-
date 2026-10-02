// Crea supabase/functions/partite/index.ts unendo motore + logica del server.
// Uso: node server/build.js
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const engine = fs.readFileSync(path.join(root, 'engine.js'), 'utf8');
const handler = fs.readFileSync(path.join(__dirname, 'handler.js'), 'utf8')
  .replace(/\nif \(typeof module[^\n]*\n?$/, '\n');
const out = `// @ts-nocheck
// Mnemoi · server delle partite online (Supabase Edge Function "partite").
// File generato da server/build.js: non modificarlo a mano.
import postgres from 'npm:postgres@3.4.5';

${engine}
const Engine = globalThis.MnemoiEngine;

${handler}
const SUPABASE_URL = Deno.env.get('SUPABASE_URL');
const sql = postgres(Deno.env.get('SUPABASE_DB_URL'), { prepare: false, max: 3, idle_timeout: 20 });

async function getUser(token, apikey) {
  const r = await fetch(SUPABASE_URL + '/auth/v1/user', {
    headers: { Authorization: 'Bearer ' + token, apikey: apikey || Deno.env.get('SUPABASE_ANON_KEY') || '' }
  });
  if (!r.ok) return null;
  return await r.json();
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405, headers: CORS });
  const token = (req.headers.get('Authorization') || '').replace(/^Bearer\\s+/i, '');
  const apikey = req.headers.get('apikey');
  let body = null;
  try { body = await req.json(); } catch (_) { body = null; }
  const handle = createHandler({ sql, Engine, getUser: (t) => getUser(t, apikey) });
  const res = await handle(token, body);
  return new Response(JSON.stringify(res.body), {
    status: res.status,
    headers: { ...CORS, 'Content-Type': 'application/json' }
  });
});
`;
fs.writeFileSync(path.join(root, 'supabase/functions/partite/index.ts'), out);
console.log('ok', out.length, 'byte');
