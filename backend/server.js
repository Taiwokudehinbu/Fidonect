// Fidonect backend stub — run with `npm install && npm start` (requires Node 18+).
// Phase-1 stub: in-memory stores. Replace with DB + auth + RAG in Phase 2.
require("dotenv").config();
const express = require("express");
const cors = require("cors");
const path = require("path");
const multer = require("multer");
const supabase = require("./supabaseClient");
const app = express();
app.use(cors()); app.use(express.json({ limit: "100kb" }));
app.set("trust proxy", 1); // correct protocol/host behind Render's proxy
function appUrl(req) {
  const env = (process.env.APP_URL || "").replace(/\/$/, "");
  if (env) return env;
  return req.protocol + "://" + req.get("host");
}
// PWA assets (manifest, service worker, icons) — this folder only, never secrets.
app.use(express.static(path.join(__dirname, "public")));
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 2 * 1024 * 1024 } });

// Cheap-slice input validation: valid requests behave exactly as before;
// malformed bodies get 400 instead of polluting the stores.
function isText(v, max = 200) { return typeof v === "string" && v.trim().length > 0 && v.length <= max; }
function bad(res, msg) { return res.status(400).json({ error: msg }); }
function isEmail(v) { return typeof v === "string" && v.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v); }

// Serve the homepage from the same service (repo-root index.html).
// Only this file is exposed — backend/.env and other files are never served.
app.get(["/", "/index.html"], (req, res) => res.sendFile(path.join(__dirname, "..", "index.html")));
// Dedicated admin login page (public chrome; all data behind requireAdmin).
app.get("/admin", (req, res) => res.sendFile(path.join(__dirname, "public", "admin.html")));

const db = { users: [], connections: [], posts: [], reports: [], mentors: [] };

app.get("/health", (req, res) => res.json({ ok: true, service: "fidonect-api", phase: "mvp-stub" }));
app.get("/api/status", async (req, res) => {
  const out = { ok: true, time: new Date().toISOString(), institutions: null };
  if (supabase) {
    const r = await supabase.from("institutions").select("id", { count: "exact", head: true });
    if (!r.error) out.institutions = r.count;
  }
  res.json(out);
});
app.get("/api/institutions/test", async (req, res) => {
  if (!supabase) return res.status(500).json({ error: "Supabase not configured. Set SUPABASE_URL and SUPABASE_ANON_KEY in backend/.env" });
  const { data, error } = await supabase.from("institutions").select("id,name,location").limit(10);
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// ---- Phase 2: Institution data (public reads; RLS enforced in the database) ----
app.get("/api/institutions", async (req, res) => {
  if (!supabase) return res.status(500).json({ error: "Supabase not configured" });
  const own = req.query.ownership;
  const kind = req.query.kind;
  if (own !== undefined && !["Federal", "State", "Private"].includes(own)) return bad(res, "ownership must be Federal, State, or Private");
  if (kind !== undefined && !["University", "Polytechnic", "College of Education"].includes(kind)) return bad(res, "kind must be University, Polytechnic, or College of Education");
  const run = (select) => {
    // Explicit limit: never let PostgREST fall back to a smaller default page (588 rows live).
    let q = supabase.from("institutions").select(select).order("name").limit(1000);
    if (own && select.includes("ownership")) q = q.eq("ownership", own);
    if (kind && select.includes("kind")) q = q.eq("kind", kind);
    return q;
  };
  const full = await run("id,name,location,ownership,state,kind");
  if (!full.error) return res.json(full.data);
  if (!/column/i.test(full.error.message)) return res.status(500).json({ error: full.error.message });
  if (kind) return res.json([]); // kind unknown pre-upgrade: honestly empty
  const mid = await run("id,name,location,ownership,state");
  if (!mid.error) return res.json(mid.data);
  if (!/column/i.test(mid.error.message)) return res.status(500).json({ error: mid.error.message });
  const base = await run("id,name,location");
  if (base.error) return res.status(500).json({ error: base.error.message });
  return res.json(own ? [] : (base.data || []));
});

app.get("/api/institutions/:id/tree", async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return bad(res, "id must be a positive integer");
  if (!supabase) return res.status(500).json({ error: "Supabase not configured" });
  const { data: inst, error: iErr } = await (async () => {
    const full = await supabase.from("institutions").select("id,name,location,ownership,state").eq("id", id).single();
    if (full.error && /column/i.test(full.error.message)) {
      return supabase.from("institutions").select("id,name,location").eq("id", id).single();
    }
    return full;
  })();
  if (iErr || !inst) return res.status(404).json({ error: "Institution not found" });
  const { data: facs, error: fErr } = await supabase.from("faculties").select("id,name").eq("institution_id", id).order("name");
  if (fErr) return res.status(500).json({ error: fErr.message });
  const facIds = (facs || []).map(f => f.id);
  let depts = [];
  if (facIds.length) {
    const { data, error } = await supabase.from("departments").select("id,faculty_id,name").in("faculty_id", facIds).order("name");
    if (error) return res.status(500).json({ error: error.message });
    depts = data || [];
  }
  const deptIds = depts.map(d => d.id);
  let progs = [];
  if (deptIds.length) {
    const { data, error } = await supabase.from("programmes").select("id,department_id,name").in("department_id", deptIds).order("name");
    if (error) return res.status(500).json({ error: error.message });
    progs = data || [];
  }
  const { data: hub } = await supabase.from("hub_pages").select("overview,clearance,fees,accommodation,source").eq("institution_id", id).single();
  const tree = (facs || []).map(f => ({
    ...f,
    departments: depts.filter(d => d.faculty_id === f.id).map(d => ({
      ...d, programmes: progs.filter(p => p.department_id === d.id)
    }))
  }));
  res.json({ ...inst, faculties: tree, hub: hub || null });
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
function adminEmails() { return (process.env.ADMIN_EMAILS || "").split(",").map(e => e.trim().toLowerCase()).filter(Boolean); }
async function requireAdmin(req, res) {
  const auth = await authedUser(req).catch(() => null);
  if (!auth) { res.status(401).json({ error: "Missing or invalid Authorization Bearer token" }); return null; }
  if (!adminEmails().includes((auth.user.email || "").toLowerCase())) { res.status(403).json({ error: "Admin only" }); return null; }
  return auth;
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

app.post("/api/auth/resend", async (req, res) => {
  const { email } = req.body || {};
  if (!isEmail(email)) return bad(res, "email is invalid");
  if (!supabase) return res.status(500).json({ error: "Supabase not configured" });
  const { error } = await supabase.auth.resend({ type: "signup", email });
  if (error) return res.status(400).json({ error: error.message });
  res.json({ ok: true, message: "Confirmation email re-sent if the account exists." });
});

app.post("/api/auth/forgot", async (req, res) => {
  const { email } = req.body || {};
  if (!isEmail(email)) return bad(res, "email is invalid");
  if (!supabase) return res.status(500).json({ error: "Supabase not configured" });
  const { error } = await supabase.auth.resetPasswordForEmail(email, { redirectTo: appUrl(req) + "/" });
  if (error) return res.status(400).json({ error: error.message });
  res.json({ ok: true, message: "If that email is registered, a reset link is on its way." });
});

app.post("/api/auth/recover", async (req, res) => {
  const { code } = req.body || {};
  if (typeof code !== "string" || !code) return bad(res, "code is required");
  if (!supabase) return res.status(500).json({ error: "Supabase not configured" });
  const { data, error } = await supabase.auth.exchangeCodeForSession(code);
  if (error) return res.status(400).json({ error: error.message });
  res.json({ user: data.user, session: data.session });
});

app.put("/api/auth/password", async (req, res) => {
  const auth = await authedUser(req).catch(() => null);
  if (!auth) return res.status(401).json({ error: "Missing or invalid Authorization Bearer token" });
  const { password } = req.body || {};
  if (typeof password !== "string" || password.length < 6) return bad(res, "password must be at least 6 characters");
  const { data, error } = await auth.me.auth.updateUser({ password });
  if (error) return res.status(400).json({ error: error.message });
  res.json({ ok: true, user: data.user });
});

app.post("/api/profile/complete", async (req, res) => {
  const auth = await authedUser(req).catch(() => null);
  if (!auth) return res.status(401).json({ error: "Missing or invalid Authorization Bearer token" });
  const { name, type, school, visibility, consent } = req.body || {};
  if (!isText(name, 100)) return bad(res, "name is required (text, max 100 chars)");
  if (consent !== true) return bad(res, "consent is required (see PRD §23.2)");
  const vis = ["public", "connections", "private"].includes(visibility) ? visibility : "connections";
  const { data: existing } = await auth.me.from("profiles").select("id").eq("id", auth.user.id).single();
  if (existing) return res.status(409).json({ error: "Profile already exists" });
  const { data, error } = await auth.me.from("profiles").insert({
    id: auth.user.id, email: auth.user.email, name: name.trim(),
    user_type: ["prospective", "existing", "alumni"].includes(type) ? type : "prospective",
    school: school || null, visibility: vis, consent_at: new Date().toISOString()
  }).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.get("/api/profile", async (req, res) => {
  const auth = await authedUser(req).catch(() => null);
  if (!auth) return res.status(401).json({ error: "Missing or invalid Authorization Bearer token" });
  const { data, error } = await auth.me.from("profiles").select("*").eq("id", auth.user.id).single();
  if (error) return res.status(404).json({ error: "Profile not found" });
  res.json({ ...data, authMeta: { emailConfirmed: !!auth.user.email_confirmed_at, lastSignInAt: auth.user.last_sign_in_at || null } });
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

app.post("/api/profile/photo", upload.single("photo"), async (req, res) => {
  const auth = await authedUser(req).catch(() => null);
  if (!auth) return res.status(401).json({ error: "Missing or invalid Authorization Bearer token" });
  if (!req.file) return bad(res, "photo file is required");
  if (!["image/jpeg", "image/png", "image/webp"].includes(req.file.mimetype)) return bad(res, "photo must be JPG, PNG, or WebP");
  const ext = req.file.mimetype === "image/jpeg" ? "jpg" : req.file.mimetype.split("/")[1];
  const objectPath = auth.user.id + "/" + Date.now() + "." + ext;
  const { error: upErr } = await auth.me.storage.from("avatars").upload(objectPath, req.file.buffer, { contentType: req.file.mimetype, upsert: true });
  if (upErr) return res.status(500).json({ error: upErr.message });
  const { data: pub } = auth.me.storage.from("avatars").getPublicUrl(objectPath);
  const { data, error } = await auth.me.from("profiles").update({ photo_url: pub.publicUrl }).eq("id", auth.user.id).select("id,photo_url").single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.use((err, req, res, next) => {
  if (err && err.code === "LIMIT_FILE_SIZE") return bad(res, "photo must be under 2MB");
  next(err);
});

// ---- Phase 3: Connections (Supabase; RLS enforced in the database) ----
app.get("/api/students", async (req, res) => {
  const auth = await authedUser(req).catch(() => null);
  if (!auth) return res.status(401).json({ error: "Missing or invalid Authorization Bearer token" });
  const { data, error } = await auth.me.from("profiles")
    .select("id,name,user_type,school,dept,session").neq("visibility", "private").neq("id", auth.user.id).limit(50);
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.post("/api/connections/request", async (req, res) => {
  const auth = await authedUser(req).catch(() => null);
  if (!auth) return res.status(401).json({ error: "Missing or invalid Authorization Bearer token" });
  const toId = req.body && req.body.toId;
  if (typeof toId !== "string" || !toId) return bad(res, "toId is required");
  if (toId === auth.user.id) return bad(res, "cannot connect to yourself");
  const { data, error } = await auth.me.from("connections")
    .insert({ requester_id: auth.user.id, addressee_id: toId }).select().single();
  if (error) {
    if (error.code === "23505") return res.status(409).json({ error: "Request already exists" });
    return res.status(500).json({ error: error.message });
  }
  res.json(data);
});

app.get("/api/connections/mine", async (req, res) => {
  const auth = await authedUser(req).catch(() => null);
  if (!auth) return res.status(401).json({ error: "Missing or invalid Authorization Bearer token" });
  const { data, error } = await auth.me.from("connections").select("*")
    .or("requester_id.eq." + auth.user.id + ",addressee_id.eq." + auth.user.id).order("created_at", { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  const ids = [...new Set((data || []).flatMap(c => [c.requester_id, c.addressee_id]).filter(id => id !== auth.user.id))];
  let names = {};
  if (ids.length) {
    const { data: profs } = await auth.me.from("profiles").select("id,name,school").in("id", ids);
    (profs || []).forEach(p => { names[p.id] = p; });
  }
  res.json((data || []).map(c => ({ ...c, other: names[c.requester_id === auth.user.id ? c.addressee_id : c.requester_id] || null })));
});

app.post("/api/connections/:id/respond", async (req, res) => {
  const auth = await authedUser(req).catch(() => null);
  if (!auth) return res.status(401).json({ error: "Missing or invalid Authorization Bearer token" });
  const id = Number(req.params.id);
  const action = req.body && req.body.action;
  if (!Number.isInteger(id) || id <= 0) return bad(res, "id must be a positive integer");
  if (!["accept", "decline"].includes(action)) return bad(res, "action must be accept or decline");
  const { data, error } = await auth.me.from("connections")
    .update({ status: action === "accept" ? "accepted" : "declined" })
    .eq("id", id).eq("addressee_id", auth.user.id).eq("status", "pending").select();
  if (error) return res.status(500).json({ error: error.message });
  if (!data || !data.length) return res.status(404).json({ error: "Pending request not found" });
  res.json(data[0]);
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
app.get("/api/communities/:school/posts", async (req, res) => {
  const auth = await authedUser(req).catch(() => null);
  if (!auth) return res.status(401).json({ error: "Log in to read the community" });
  if (!isText(req.params.school)) return bad(res, "school is required");
  const { data, error } = await auth.me.from("posts").select("id,author_name,text,created_at")
    .eq("school", req.params.school).order("created_at", { ascending: false }).limit(50);
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});
app.post("/api/communities/:school/posts", async (req, res) => {
  const auth = await authedUser(req).catch(() => null);
  if (!auth) return res.status(401).json({ error: "Log in to post" });
  if (!isText(req.params.school)) return bad(res, "school is required");
  if (!req.body || !isText(req.body.text, 1000)) return bad(res, "text is required (max 1000 chars)");
  const { data: prof } = await auth.me.from("profiles").select("name").eq("id", auth.user.id).single();
  const { data, error } = await auth.me.from("posts").insert({
    school: req.params.school, author_id: auth.user.id,
    author_name: (prof && prof.name) || "Student", text: req.body.text.trim()
  }).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});
// ---- Phase 5: Basic Fido (rule-based; PRD §§5, 25 labels; no AI provider yet) ----
const FIDO_ALIASES = { unilag: "University of Lagos", akoka: "University of Lagos", ui: "University of Ibadan", ibadan: "University of Ibadan", oau: "Obafemi Awolowo University", ife: "Obafemi Awolowo University", "ile-ife": "Obafemi Awolowo University", unn: "University of Nigeria", nsukka: "University of Nigeria", abu: "Ahmadu Bello University", zaria: "Ahmadu Bello University", uniben: "University of Benin", unilorin: "University of Ilorin", unical: "University of Calabar", uniport: "University of Port-Harcourt", buk: "Bayero University", futa: "Federal University of Technology, Akure", akure: "Federal University of Technology, Akure", futminna: "Federal University of Technology Minna", futo: "Federal University of Technology Owerri", unizik: "Nnamdi Azikiwe University", uniuyo: "University of Uyo", unijos: "University of Jos", unimaid: "University of Maiduguri", noun: "National Open University of Nigeria", lasu: "Lagos State University", ojo: "Lagos State University", oou: "Olabisi Onabanjo University", covenant: "Covenant University", ota: "Covenant University", abuad: "Afe Babalola University", babcock: "Babcock University", laspotech: "Lagos State Polytechnic", yabatech: "Yaba College of Technology", yaba: "Yaba College of Technology", mapoly: "Moshood Abiola University of Science and Technology" };
let schoolCache = [], schoolCacheAt = 0;
async function findSchool(text) {
  const q = (" " + text.toLowerCase().replace(/[^a-z0-9]+/g, " ") + " ");
  for (const [alias, frag] of Object.entries(FIDO_ALIASES)) {
    const norm = (" " + alias.toLowerCase().replace(/[^a-z0-9]+/g, " ") + " ");
    if (q.includes(norm)) {
      if (supabase) {
        const { data } = await supabase.from("institutions").select("id,name,location,ownership,state").ilike("name", "%" + frag + "%").limit(1);
        if (data && data.length) return data[0];
      }
      return { name: frag };
    }
  }
  if (supabase && (Date.now() - schoolCacheAt > 10 * 60 * 1000 || !schoolCache.length)) {
    const { data } = await supabase.from("institutions").select("name,location,ownership,state");
    if (data) { schoolCache = data; schoolCacheAt = Date.now(); }
  }
  const words = q.split(/[^a-z]+/).filter(w => w.length >= 5);
  return schoolCache.find(s => words.some(w => s.name.toLowerCase().includes(w))) || null;
}
async function findHub(institutionId) {
  if (!supabase || !institutionId) return null;
  const { data } = await supabase.from("hub_pages").select("overview,clearance,fees,accommodation,source").eq("institution_id", institutionId).single();
  return data || null;
}
async function findCourses(text) {
  // Live lookup in department records (covers only some schools so far — never invent).
  if (!supabase) return [];
  const stop = new Set(["where","study","studies","offer","offers","offered","offering","which","schools","school","course","courses","department","departments","programme","programmes","available","there","their","admission","learn","best","good","with","that","this","from","about","does","what","have","has","want","like"]);
  const keys = [...new Set(text.toLowerCase().split(/[^a-z]+/).filter(w => w.length >= 4 && !stop.has(w)))].slice(0, 3);
  const out = [];
  const safeQuery = async (fn) => { try { return await fn(); } catch (e) { return { data: [] }; } };
  for (const k of keys) {
    const r = await safeQuery(() => supabase.from("departments").select("id,name,faculty_id").ilike("name", "%" + k + "%").limit(8));
    const depts = (r && r.data) || [];
    if (depts.length) {
      const facIds = [...new Set(depts.map(d => d.faculty_id))];
      const fr = await safeQuery(() => supabase.from("faculties").select("id,name,institution_id").in("id", facIds));
      const facs = (fr && fr.data) || [];
      const byId = {};
      facs.forEach(f => { byId[f.id] = f; });
      const instIds = [...new Set(facs.map(f => f.institution_id))];
      let instById = {};
      if (instIds.length) {
        const ir = await safeQuery(() => supabase.from("institutions").select("id,name").in("id", instIds));
        ((ir && ir.data) || []).forEach(i => { instById[i.id] = i.name; });
      }
      depts.slice(0, 8).forEach(d => {
        const f = byId[d.faculty_id] || {};
        out.push(d.name + (f.name ? " (" + f.name + (instById[f.institution_id] ? ", " + instById[f.institution_id] : "") + ")" : ""));
      });
    }
    if (out.length >= 6) break;
  }
  return [...new Set(out)].slice(0, 6);
}
app.post("/api/fido/ask", async (req, res) => {
  const question = req.body && req.body.question;
  if (typeof question !== "string" || question.trim().length < 3 || question.length > 500) return bad(res, "question must be 3–500 characters");
  const q = question.toLowerCase();
  let school = await findSchool(q).catch(() => null);
  // Conversation threading: callers may pass { context: { school } } from a previous
  // answer's echoed context, so follow-ups like "what about fees?" stay school-aware.
  const ctxSchool = req.body && req.body.context && req.body.context.school;
  if (!school && typeof ctxSchool === "string" && ctxSchool.trim() && supabase) {
    try {
      const hit = await supabase.from("institutions").select("id,name,location,ownership,state").eq("name", ctxSchool.trim()).limit(1);
      if (hit && hit.data && hit.data.length) school = hit.data[0];
    } catch (e) { /* ignore — fall through school-less */ }
  }
  const sName = school ? school.name : null;
  const hub = await findHub(school && school.id).catch(() => null);
  const official = (text) => ({ answer: text, source: "Official", school: sName, verify: true, context: { school: sName } });
  const community = (text) => ({ answer: text, source: "Community", school: sName, verify: true, context: { school: sName } });
  const ai = (text) => ({ answer: text, source: "AI guidance", school: sName, verify: true, context: { school: sName } });
  const where = sName ? " at " + sName : "";
  // Directory intelligence: answer from the live NUC/NBTE/NCCE dataset (Official source).
  // Skipped for course/department questions — those go to the live course lookup below.
  if (supabase && /list|show|display|how many|number of|count|which/.test(q) && /school|institution|universit|polytechnic|college/.test(q) && !/course|programme|department|study|offer/.test(q)) {
    const STATES = ["Abia","Adamawa","Akwa Ibom","Anambra","Bauchi","Bayelsa","Benue","Borno","Cross River","Delta","Ebonyi","Edo","Ekiti","Enugu","FCT","Abuja","Gombe","Imo","Jigawa","Kaduna","Kano","Katsina","Kebbi","Kogi","Kwara","Lagos","Nasarawa","Niger","Ogun","Ondo","Osun","Oyo","Plateau","Rivers","Sokoto","Taraba","Yobe","Zamfara"];
    const kindQ = /polytechnic|\bpoly\b/.test(q) ? "Polytechnic" : (/college of education|\bcoe\b/.test(q) ? "College of Education" : (/universit/.test(q) ? "University" : null));
    const ownQ = /\bfederal\b/.test(q) ? "Federal" : (/\bprivate\b/.test(q) ? "Private" : (/\bstate\b/.test(q) ? "State" : null));
    let stHit = STATES.find(st => q.includes(st.toLowerCase()));
    if (stHit === "Abuja") stHit = "FCT";
    try {
      if (kindQ || ownQ || stHit) {
        let query = supabase.from("institutions").select("name,location,ownership,state,kind", { count: "exact" }).order("name").limit(25);
        if (kindQ) query = query.eq("kind", kindQ);
        if (ownQ) query = query.eq("ownership", ownQ);
        if (stHit) query = query.eq("state", stHit);
        const { data, error, count } = await query;
        if (!error && data) {
          const label = [ownQ, stHit, kindQ ? kindQ + "s" : ""].filter(Boolean).join(" ");
          const names = data.map(r => r.name).join("; ");
          return res.json({ answer: (count || data.length) + " matching " + (label || "schools") + " (showing " + data.length + "): " + names + ". Open any school in the directory below for departments and campus info.", source: "Official", school: null, verify: true, context: { school: null } });
        }
      } else {
        const { data, error } = await supabase.from("institutions").select("kind", { count: "exact" });
        if (!error) {
          const all = await supabase.from("institutions").select("kind").limit(1000);
          const n = { University: 0, Polytechnic: 0, "College of Education": 0 };
          (all.data || []).forEach(r => { if (n[r.kind] !== undefined) n[r.kind]++; });
          const total = n.University + n.Polytechnic + n["College of Education"];
          return res.json({ answer: "Fidonect lists " + total + " institutions: " + n.University + " universities, " + n.Polytechnic + " polytechnics, " + n["College of Education"] + " colleges of education — Federal, State, and Private. Try: 'list federal universities in Lagos' or 'how many polytechnics'.", source: "Official", school: null, verify: true, context: { school: null } });
        }
      }
    } catch (e) { /* fall through to topic rules */ }
  }
  if (/^(hi|hey|hello|good (morning|afternoon|evening)|thanks|thank you|bye|goodbye)\b/.test(q) || /who are you|what can you do|help me/.test(q)) {
    return res.json(ai("Hello! I'm Fido, your campus guide. I can walk you through admission steps, clearance documents, fees, accommodation, course registration, finding courses, and resumption prep" + where + ". Try: 'I just got admitted — what next?'"));
  }
  if (/admitted|after admission|just got|newly admitted|next step/.test(q)) {
    return res.json(ai("Congrats on your admission" + where + "! Typical next steps: (1) accept the offer on JAMB CAPS and print your JAMB admission letter; (2) watch your school portal for the admission and screening list; (3) gather clearance documents — O-level results, birth certificate, LGA letter, passport photos; (4) pay acceptance and school fees only through official portal channels; (5) sort accommodation early; (6) complete course registration within the window; (7) attend orientation and matriculation." + (sName ? " Ask in the " + sName + " community — students there have done this recently." : " Tell me your school and I'll share its campus info.")));
  }
  if (/subject combin|combination of subjects|what subjects|jamb subjects|utme subjects|olevel requirements|o-level requirements/.test(q)) {
    return res.json(ai("For JAMB subject combinations" + where + ": English is compulsory for every course, plus any three subjects the course requires — and the exact mix differs per course and per school. Steps: (1) open the current JAMB brochure; (2) look up your exact course; (3) confirm against your school's own requirements on its portal, since schools vary. Tell me your course" + (sName ? " and I'll also check our course records." : " and school, and I'll check our course records.")));
  }
  if (/caps/.test(q) || (/jamb/.test(q) && !/cut.?off|post-utme|postutme/.test(q))) {
    return res.json(ai("On JAMB CAPS" + where + ": (1) log in and check your admission status often; (2) click Accept once offered — ignoring it can forfeit the slot; (3) print your admission letter from the portal; (4) confirm your O-level results are uploaded on the JAMB portal. Only trust offers shown on CAPS or the official school portal — anyone asking for money to 'secure' admission is running a scam."));
  }
  if (/regist|enrol|course form/.test(q)) {
    return res.json(ai("For course registration" + where + ": (1) pay your acceptance and school fees first — most portals block registration until payment; (2) log in to the student portal inside the registration window; (3) select the semester's courses using your departmental handbook; (4) submit and print your registration forms; (5) confirm with your level adviser. Late registration attracts extra charges, so don't wait."));
  }
  if (/direct entry|de form|de admission|transcript|a-level|a level|nd result|hnd/.test(q)) {
    return res.json(ai("For Direct Entry" + where + ": (1) buy the JAMB Direct Entry form when sales open; (2) you need an A-level, ND, HND, NCE, or degree result on top of O-levels — each department sets which qualifications it accepts; (3) send your transcript early through your former school, since late transcripts stall screening; (4) watch the school portal for the DE screening list. Requirements differ per department, so confirm on the portal." + (sName ? "" : " Tell me your school and target course for tailored steps.")));
  }
  if (/scholarship|bursary|financial aid|funding|student loan/.test(q)) {
    return res.json(ai("On scholarships and bursaries" + where + ": (1) watch your school notice board and portal — most institutional bursaries are announced there; (2) check federal and state government bursary schemes you qualify for; (3) prepare O-level results, admission letter, and school ID early, since windows are short; (4) never pay anyone to 'process' a scholarship, and treat guaranteed-award promises as scams. Tell me your level and school and I'll suggest where to look first."));
  }
  if (/where.*(study|offer|do)|does .*offer|can i study|course|programme|department|available/.test(q)) {
    const hits = await findCourses(q).catch(() => null);
    if (hits && hits.length) return res.json(official("From our department records: " + hits.join("; ") + ". These records currently cover only some schools — confirm availability and entry requirements on the school portal or JAMB brochure."));
    if (sName) return res.json(ai("I don't hold department-level records for " + sName + " yet — our directory covers institution-level info for 588 schools, with department details for only some so far. Check " + sName + "'s portal or the JAMB brochure for that course, and ask in the community — a student there may know."));
    return res.json(ai("Tell me the course and the school — e.g. 'Does UNILAG offer Computer Science?' — and I'll check our records. Note department data covers only some schools so far; for the full picture, check the school portal or JAMB brochure."));
  }
  if (/clearance|screening/.test(q)) {
    if (hub && hub.clearance) return res.json(official("For clearance" + where + ": " + hub.clearance + " Go in this order: confirm your name on the admission list, present originals plus photocopies, then keep every receipt. Always confirm on your school portal — requirements vary by department."));
    return res.json(ai("For clearance" + where + ", go in this order: (1) confirm your name on the admission or screening list; (2) gather originals plus 3–4 photocopies of each — JAMB admission letter, O-level result(s), birth certificate or age declaration, LGA identification letter, passport photos; (3) present them at the screening venue; (4) keep every receipt." + (sName ? " Ask in the " + sName + " community for department-specific experience." : " Tell me your school for its specific requirements.")));
  }
  if (/document|what .*(need|require|bring)|checklist/.test(q)) {
    if (hub && hub.clearance) return res.json(official("Documents" + where + ": " + hub.clearance + " Carry originals plus photocopies, and confirm the exact list on your school portal."));
    return res.json(ai("Most schools ask for: JAMB admission letter and result slip, O-level result(s), birth certificate or age declaration, LGA or state identification letter, 8–12 passport photographs, acceptance fee receipt, and departmental screening forms. Carry originals plus 3–4 photocopies of each in a file jacket. Exact lists vary — confirm on your school portal before travelling."));
  }
  if (/accommod|hostel|housing|lodge/.test(q)) {
    if (hub && hub.accommodation) return res.json(official("Accommodation" + where + ": " + hub.accommodation + " Apply the moment clearance opens — school hostels fill fast."));
    return res.json(community("Accommodation plan" + where + ": (1) apply for the school hostel immediately after clearance; (2) line up a private hostel nearby as backup; (3) before paying, inspect security, water, light, and distance to campus; (4) never pay into personal accounts or before seeing the room. Ask connected students where they stay."));
  }
  if (/fee|school charges|payment|tuition/.test(q)) {
    if (hub && hub.fees) return res.json(official("Fees" + where + ": " + hub.fees + " Pay only through channels named on the official portal and keep every receipt."));
    return res.json(ai("I don't hold verified fee figures for every school" + (sName ? " — including " + sName + " — " : "") + " so tell me your school and I'll share what we hold. Generally: check the official school portal for the current schedule (it changes per session and faculty), pay only through official channels, keep receipts, and never pay into personal accounts — report payment scams."));
  }
  if (/cut.?off|post-utme|postutme|merit list|supplementary|supplemental/.test(q)) {
    return res.json(ai("On cut-off marks and screening" + where + ": (1) meet the general JAMB cut-off, then the departmental cut-off — departments set theirs separately and figures change every year, so last year's numbers are a guide only; (2) register for the school's post-UTME or screening exercise before its deadline; (3) track merit, supplementary, and VC lists on the portal. Only trust lists on the official portal or JAMB CAPS."));
  }
  if (/admission|jamb/.test(q)) {
    return res.json(ai("For admission" + where + ": (1) track JAMB CAPS and accept your offer there; (2) watch the school portal for merit, supplementary, or VC lists; (3) note departmental cut-off marks change every year, so treat last year's figures as a guide only; (4) print your JAMB admission letter early. Only trust offers on CAPS or the official portal — anyone asking for money to 'secure' admission is running a scam."));
  }
  if (/resum|prepare|first semester|freshers|fresher|new student|packing|pack/.test(q)) {
    return res.json(ai("Resumption prep" + where + ": documents — originals plus photocopies in a file jacket; accommodation — confirmed before you travel; academics — departmental reading list and basic stationery; living — bedding, cooking basics, toiletries, and a lockable box; people — connect with 2–3 classmates and one mentor here before you arrive. Travel light on day one and buy bulky items near campus." + (sName ? "" : " Tell me your school for campus-specific tips.")));
  }
  if (/orientation|matric|matriculation/.test(q)) {
    return res.json(ai("Orientation and matriculation" + where + ": expect campus tours, faculty and department introductions, library and portal training, and the matriculation oath that formally admits you. Go with writing materials and your admission documents — and use the week to meet classmates and find a mentor. It's the easiest week to make friends you'll keep all through school."));
  }
  if (/\bnysc\b|youth service|service year|mobiliz/.test(q)) {
    return res.json(ai("On NYSC (looking ahead): after graduation your school mobilizes you — (1) finish strong, since graduation and clearance come first; (2) keep your personal details consistent across JAMB, school, and NYSC records to avoid mobilization issues; (3) watch your school's student-affairs notices in final year for the mobilization timetable. Focus on getting admitted and settled first — we'll walk the NYSC road when you get there."));
  }
  if (/campus life|safe|safety|secur|scam|fraud|theft|night|emergency|health/.test(q)) {
    return res.json(community("Staying safe on campus" + where + ": (1) avoid lonely routes at night and share your movement with a roommate; (2) lock your room and travel light with valuables; (3) use the school health centre early when sick — don't self-medicate for long; (4) verify every payment, hostel offer, and 'exam expo' before committing — scams target freshers most. Save your department and security contacts in your phone. Ask in the community which areas students recommend." + (sName ? "" : " Tell me your school for campus-specific pointers.")));
  }
  if (/study|exam|gp|grade|reading|tutorial|past question/.test(q)) {
    return res.json(ai("Study smart" + where + ": (1) get each course outline in week one; (2) build a weekly timetable and protect study hours; (3) join department study threads and ask mentors for past questions; (4) revise weekly instead of cramming; (5) guard your first-semester GPA — it sets your foundation. Which course is giving you trouble? I can share how to approach it."));
  }
  return res.json(ai("I can guide you step by step on: next steps after admission, JAMB CAPS and subject combinations, cut-off marks, Direct Entry, clearance documents, course registration, fees, accommodation, scholarships, finding courses, orientation, resumption prep, campus safety, NYSC, and study tips" + where + ". Try: 'I just got admitted — what next?' or 'What subjects do I need for Medicine?'"));
});
app.get("/api/mentors", (req, res) => res.json(db.mentors));
app.post("/api/reports", async (req, res) => {
  const auth = await authedUser(req).catch(() => null);
  if (!auth) return res.status(401).json({ error: "Log in to report" });
  if (!req.body || !isText(req.body.target, 200) || !isText(req.body.reason, 500)) return bad(res, "target and reason are required");
  const { data, error } = await auth.me.from("reports").insert({
    reporter_id: auth.user.id, target: req.body.target.trim(), reason: req.body.reason.trim()
  }).select("id,created_at").single();
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true, id: data.id });
});

app.get("/api/admin/me", async (req, res) => {
  const auth = await authedUser(req).catch(() => null);
  if (!auth) return res.status(401).json({ error: "Missing or invalid Authorization Bearer token" });
  res.json({ isAdmin: adminEmails().includes((auth.user.email || "").toLowerCase()), email: auth.user.email });
});

app.get("/api/admin/stats", async (req, res) => {
  const auth = await requireAdmin(req, res);
  if (!auth) return;
  async function count(table, client) {
    try {
      const r = await (client || auth.me).from(table).select("id", { count: "exact", head: true });
      if (r.error) return { status: "pending", detail: String(r.error.message || r.error).slice(0, 120) };
      return { status: "ok", count: r.count };
    } catch (e) { return { status: "pending", detail: String((e && e.message) || e).slice(0, 120) }; }
  }
  // Institutions are public data whose read policy covers the anon role only;
  // count them with the anon client so the admin card matches /api/status.
  const [users, posts, institutions] = await Promise.all([count("profiles"), count("posts"), count("institutions", supabase)]);
  let recentUsers = [];
  if (users.status === "ok") {
    const r = await auth.me.from("profiles").select("name,email,school,visibility,created_at").order("created_at", { ascending: false }).limit(20);
    if (!r.error) recentUsers = r.data || [];
  }
  let recentPosts = [];
  if (posts.status === "ok") {
    const r = await auth.me.from("posts").select("author_name,school,text,created_at").order("created_at", { ascending: false }).limit(20);
    if (!r.error) recentPosts = r.data || [];
  }
  res.json({
    users, posts, institutions, recentUsers, recentPosts,
    reports: { status: "dashboard", detail: "Review reports in Supabase dashboard > Table Editor > reports." },
    generatedAt: new Date().toISOString()
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Fidonect API stub on :${PORT}`));
