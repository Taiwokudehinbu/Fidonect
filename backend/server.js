// Fidonect backend stub — run with `npm install && npm start` (requires Node 18+).
// Phase-1 stub: in-memory stores. Replace with DB + auth + RAG in Phase 2.
require("dotenv").config();
const express = require("express");
const cors = require("cors");
const path = require("path");
const supabase = require("./supabaseClient");
const app = express();
app.use(cors()); app.use(express.json({ limit: "100kb" }));

// Cheap-slice input validation: valid requests behave exactly as before;
// malformed bodies get 400 instead of polluting the stores.
function isText(v, max = 200) { return typeof v === "string" && v.trim().length > 0 && v.length <= max; }
function bad(res, msg) { return res.status(400).json({ error: msg }); }
function isEmail(v) { return typeof v === "string" && v.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v); }

// Serve the homepage from the same service (repo-root index.html).
// Only this file is exposed — backend/.env and other files are never served.
app.get(["/", "/index.html"], (req, res) => res.sendFile(path.join(__dirname, "..", "index.html")));

const db = { users: [], connections: [], posts: [], reports: [], mentors: [] };

app.get("/health", (req, res) => res.json({ ok: true, service: "fidonect-api", phase: "mvp-stub" }));
app.get("/api/institutions/test", async (req, res) => {
  if (!supabase) return res.status(500).json({ error: "Supabase not configured. Set SUPABASE_URL and SUPABASE_ANON_KEY in backend/.env" });
  const { data, error } = await supabase.from("institutions").select("id,name,location").limit(10);
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// ---- Phase 1: Auth + profiles (Supabase Auth; RLS enforced in the database) ----
function authedClient(req) {
  const token = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  if (!token || !process.env.SUPABASE_URL || !process.env.SUPABASE_ANON_KEY) return null;
  const { createClient } = require("@supabase/supabase-js");
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: "Bearer " + token } }
  });
}
async function authedUser(req) {
  const me = authedClient(req);
  if (!me) return null;
  const { data: { user } } = await me.auth.getUser();
  return user ? { me, user } : null;
}

app.post("/api/auth/signup", async (req, res) => {
  const { name, email, password, type, school, visibility, consent } = req.body || {};
  if (!isText(name, 100)) return bad(res, "name is required (text, max 100 chars)");
  if (!isEmail(email)) return bad(res, "email is invalid");
  if (typeof password !== "string" || password.length < 6) return bad(res, "password must be at least 6 characters");
  if (consent !== true) return bad(res, "consent is required (see PRD §23.2)");
  if (!supabase) return res.status(500).json({ error: "Supabase not configured" });
  const vis = ["public", "connections", "private"].includes(visibility) ? visibility : "connections";
  const { data, error } = await supabase.auth.signUp({ email, password });
  if (error) return res.status(400).json({ error: error.message });
  if (!data.session) return res.json({ needsConfirmation: true, message: "Account created. Confirm your email, then log in. (For MVP testing you may turn Confirm email OFF in Supabase Auth settings.)" });
  const me = authedClient({ headers: { authorization: "Bearer " + data.session.access_token } });
  const { error: pErr } = await me.from("profiles").insert({
    id: data.user.id, email, name: name.trim(),
    user_type: ["prospective", "existing", "alumni"].includes(type) ? type : "prospective",
    school: school || null, visibility: vis, consent_at: new Date().toISOString()
  });
  if (pErr) return res.status(500).json({ error: "Account created but profile failed: " + pErr.message });
  res.json({ user: data.user, session: data.session });
});

app.post("/api/auth/login", async (req, res) => {
  const { email, password } = req.body || {};
  if (!isEmail(email) || typeof password !== "string" || !password) return bad(res, "email and password are required");
  if (!supabase) return res.status(500).json({ error: "Supabase not configured" });
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) return res.status(401).json({ error: error.message });
  res.json({ user: data.user, session: data.session });
});

app.get("/api/profile", async (req, res) => {
  const auth = await authedUser(req).catch(() => null);
  if (!auth) return res.status(401).json({ error: "Missing or invalid Authorization Bearer token" });
  const { data, error } = await auth.me.from("profiles").select("*").eq("id", auth.user.id).single();
  if (error) return res.status(404).json({ error: "Profile not found" });
  res.json(data);
});

app.put("/api/profile", async (req, res) => {
  const auth = await authedUser(req).catch(() => null);
  if (!auth) return res.status(401).json({ error: "Missing or invalid Authorization Bearer token" });
  const patch = {};
  if (req.body.name !== undefined) {
    if (!isText(req.body.name, 100)) return bad(res, "name invalid (text, max 100 chars)");
    patch.name = req.body.name.trim();
  }
  for (const f of ["school", "faculty", "dept", "programme", "session", "interests"]) {
    if (req.body[f] !== undefined) {
      if (typeof req.body[f] !== "string" || req.body[f].length > 200) return bad(res, f + " invalid (text, max 200 chars)");
      patch[f] = req.body[f];
    }
  }
  if (req.body.visibility !== undefined) {
    if (!["public", "connections", "private"].includes(req.body.visibility)) return bad(res, "visibility must be public, connections, or private");
    patch.visibility = req.body.visibility;
  }
  if (!Object.keys(patch).length) return bad(res, "nothing to update");
  const { data, error } = await auth.me.from("profiles").update(patch).eq("id", auth.user.id).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});
app.post("/api/users", (req, res) => {
  if (!req.body || !isText(req.body.name, 100)) return bad(res, "name is required (text, max 100 chars)");
  if (req.body.email !== undefined && !isEmail(req.body.email)) return bad(res, "email is invalid");
  const u = { id: Date.now(), ...req.body }; db.users.push(u); res.json(u);
});
app.get("/api/discover", (req, res) => res.json(db.users));
app.post("/api/connections", (req, res) => {
  if (!req.body || req.body.fromId === undefined || req.body.toId === undefined) return bad(res, "fromId and toId are required");
  db.connections.push(req.body); res.json({ ok: true });
});
app.get("/api/communities/:school/posts", (req, res) => res.json(db.posts.filter(p => p.school === req.params.school)));
app.post("/api/communities/:school/posts", (req, res) => {
  if (!isText(req.params.school)) return bad(res, "school is required");
  if (!req.body || !isText(req.body.text, 1000)) return bad(res, "text is required (max 1000 chars)");
  const p = { school: req.params.school, ...req.body }; db.posts.push(p); res.json(p);
});
app.post("/api/fido/ask", (req, res) => res.json({ source: "AI guidance", answer: "Stub: wire LLM + institutional knowledge base with source attribution (Official/Community/AI)." }));
app.get("/api/mentors", (req, res) => res.json(db.mentors));
app.post("/api/reports", (req, res) => {
  if (!req.body || !isText(req.body.target, 200) || !isText(req.body.reason, 500)) return bad(res, "target and reason are required");
  db.reports.push(req.body); res.json({ ok: true });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Fidonect API stub on :${PORT}`));
