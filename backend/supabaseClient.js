// backend/supabaseClient.js — backend only. Never import this file from index.html.
// Reads keys from backend/.env (gitignored). Anon key is used here, service_role is never used.
const { createClient } = require("@supabase/supabase-js");

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_ANON_KEY;

let client = null;
if (url && key) {
  client = createClient(url, key);
} else {
  console.warn("Supabase not configured: set SUPABASE_URL and SUPABASE_ANON_KEY in backend/.env");
}

module.exports = client;
