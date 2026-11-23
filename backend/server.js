// Fidonect API — Express app served by Vercel (and optionally Render).
require("dotenv").config({ path: require("path").join(__dirname, ".env") });
require("express-async-errors"); // converts rejected async handlers into next(err)
const express = require("express");
const cors = require("cors");
const path = require("path");
const fs = require("fs");
const { createClient } = require("@supabase/supabase-js");
const supabase = require("./supabaseClient");
const { isText, isEmail, isHttpUrl, isIsoDate, parsePositiveInt, cleanText, uniqueSlug } = require("./lib/validation");
const app = express();
app.set("trust proxy", 1);
app.disable("x-powered-by");

// CORS allowlist: official site, its main preview alias, local development,
// plus explicit CORS_ORIGINS. Arbitrary *.vercel.app origins are not trusted.
// Requests without an Origin header (curl, server-to-server, same-origin) pass.
const OFFICIAL_ORIGINS = new Set([
  "https://fidonect.vercel.app",
  "https://fidonect-git-main-taiwokudehinbu.vercel.app",
  "http://localhost:3000",
  "http://127.0.0.1:3000"
]);
function originAllowed(origin) {
  if (!origin) return true;
  if (OFFICIAL_ORIGINS.has(origin)) return true;
  const extra = (process.env.CORS_ORIGINS || "").split(",").map(s => s.trim()).filter(Boolean);
  if (extra.includes(origin)) return true;
  if (process.env.NODE_ENV !== "production" && origin === "null") return true;
  return false;
}
app.use(cors({
  origin(origin, cb) { cb(null, originAllowed(origin)); },
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
  maxAge: 86400
}));
app.use(express.json({ limit: "100kb" }));

// Conservative security headers that do not break the existing inline UI.
app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  if (req.path.startsWith("/api/")) res.setHeader("Cache-Control", "no-store");
  next();
});

// Best-effort in-memory rate limit. Serverless instances are isolated, so this
// is a speed bump, not a global quota; it stops casual brute-force loops.
const rateBuckets = new Map();
function rateLimit(name, max, windowMs) {
  return function (req, res, next) {
    const key = name + ":" + (req.ip || (req.socket && req.socket.remoteAddress) || "unknown");
    const now = Date.now();
    const hits = (rateBuckets.get(key) || []).filter(t => now - t < windowMs);
    if (hits.length >= max) {
      res.setHeader("Retry-After", String(Math.ceil(windowMs / 1000)));
      return res.status(429).json({ error: "Too many requests. Please wait a minute and try again." });
    }
    hits.push(now);
    rateBuckets.set(key, hits);
    if (rateBuckets.size > 5000) {
      for (const [k, v] of rateBuckets) {
        if (!v.length || now - v[v.length - 1] > windowMs) rateBuckets.delete(k);
      }
    }
    next();
  };
}
function appUrl(req) {
  const env = (process.env.APP_URL || "").replace(/\/$/, "");
  if (env) return env;
  return req.protocol + "://" + req.get("host");
}
// PWA assets (manifest, service worker, icons) — this folder only, never secrets.
// Long-cache images/icons, but always revalidate the service worker and HTML.
app.use(express.static(path.join(__dirname, "public"), {
  setHeaders(res, filePath) {
    if (/sw\.js$/i.test(filePath)) res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
    else if (/\.(?:png|jpe?g|webp|svg|ico|woff2?)$/i.test(filePath)) res.setHeader("Cache-Control", "public, max-age=604800");
    else res.setHeader("Cache-Control", "public, max-age=300");
  }
}));
// User-specific API responses must never be cached by the browser or CDN.
app.use((req, res, next) => {
  if (req.headers.authorization) res.setHeader("Cache-Control", "no-store");
  next();
});
let photoUploadMiddleware = null;
function photoUpload(req, res, next) {
  if (!photoUploadMiddleware) {
    const multer = require("multer");
    photoUploadMiddleware = multer({ storage: multer.memoryStorage(), limits: { fileSize: 4 * 1024 * 1024 } }).single("photo");
  }
  photoUploadMiddleware(req, res, next);
}
const CACHE_MS = 5 * 60 * 1000;
const PUBLIC_CACHE = "public, max-age=120, s-maxage=600, stale-while-revalidate=86400";
const STATUS_CACHE = "public, max-age=30, s-maxage=60, stale-while-revalidate=300";
const instCache = new Map();
const statusCache = { at: 0, body: null };
const treeCache = new Map();

// Verified institution information (Phase 2). The full select is tried first;
// pre-migration deployments fall back to the original Phase 2 columns.
const HUB_FULL_FIELDS = "overview,clearance,fees,accommodation,admission,registration,dates,transport,facilities,faq,official_links,source,source_url,verified,updated_at";
const HUB_LEGACY_FIELDS = "overview,clearance,fees,accommodation,source";
async function readHub(institutionId) {
  if (!supabase || !institutionId) return null;
  let result = await supabase.from("hub_pages").select(HUB_FULL_FIELDS)
    .eq("institution_id", institutionId).maybeSingle();
  if (result.error && /column/i.test(result.error.message || "")) {
    result = await supabase.from("hub_pages").select(HUB_LEGACY_FIELDS)
      .eq("institution_id", institutionId).maybeSingle();
  }
  return result.error ? null : (result.data || null);
}

function bad(res, msg) { return res.status(400).json({ error: msg }); }

// Optional service-role client. Admin routes use it when configured; otherwise
// they fall back to the verified admin's own JWT and the database admin policies.
let serviceClient = null;
function adminDb() {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) return null;
  if (!serviceClient) {
    serviceClient = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false }
    });
  }
  return serviceClient;
}
function missingRelation(error) {
  const code = String((error && error.code) || "");
  const message = String((error && error.message) || "");
  return code === "PGRST205" || code === "42P01" ||
    /could not find the table|relation .* does not exist|does not exist/i.test(message);
}
// Read from the privacy-safe view when it exists; fall back to profiles before
// the security migration has been applied so deployments stay backward-compatible.
async function profilesFrom(client, build) {
  let result = await build(client.from("visible_profiles"));
  if (result && result.error && missingRelation(result.error)) {
    result = await build(client.from("profiles"));
  }
  return result;
}

// Serve the homepage from the same service (repo-root index.html).
// Only this file is exposed — backend/.env and other files are never served.
function sendHome(req, res) {
  if (!sendHome.html) sendHome.html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
  res.setHeader("Cache-Control", "public, max-age=0, s-maxage=60, stale-while-revalidate=300");
  res.type("html").send(sendHome.html);
}
app.get(["/", "/index.html"], sendHome);
// Dedicated admin login page (public chrome; all data behind requireAdmin).
app.get("/admin", (req, res) => {
  res.setHeader("Cache-Control", "no-cache");
  res.sendFile(path.join(__dirname, "public", "admin.html"));
});
// Dedicated school profile pages (client-side route; data via /api/institutions/:id/tree).
app.get(["/schools", "/schools/:id"], sendHome);
// Feature pages (client-side router in index.html; same shell, no new backend logic).
app.get(["/institutions", "/connections", "/mentors", "/housing", "/accommodation", "/partners", "/alumni", "/opportunities", "/ai-honesty", "/about", "/messages", "/scholarships", "/profile"], sendHome);
app.get("/chat/:id", sendHome);

const db = { users: [], connections: [], posts: [], reports: [], mentors: [] };

app.get("/health", (req, res) => res.json({ ok: true, service: "fidonect-api", phase: "mvp-stub" }));
app.get("/api/status", async (req, res) => {
  const now = Date.now();
  if (statusCache.body && now - statusCache.at < CACHE_MS) {
    res.setHeader("Cache-Control", STATUS_CACHE);
    return res.json(statusCache.body);
  }
  const out = { ok: true, time: new Date().toISOString(), institutions: null };
  if (supabase) {
    const r = await supabase.from("institutions").select("id", { count: "exact", head: true });
    if (!r.error) out.institutions = r.count;
  }
  statusCache.at = now; statusCache.body = out;
  res.setHeader("Cache-Control", STATUS_CACHE);
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
  const cacheKey = (own || "") + "|" + (kind || "");
  const cached = instCache.get(cacheKey);
  if (cached && Date.now() - cached.at < CACHE_MS) {
    res.setHeader("Cache-Control", PUBLIC_CACHE);
    return res.json(cached.data);
  }
  const send = (data) => {
    instCache.set(cacheKey, { at: Date.now(), data });
    res.setHeader("Cache-Control", PUBLIC_CACHE);
    return res.json(data);
  };
  const run = (select) => {
    // Explicit limit: never let PostgREST fall back to a smaller default page (588 rows live).
    let q = supabase.from("institutions").select(select).order("name").limit(1000);
    if (own && select.includes("ownership")) q = q.eq("ownership", own);
    if (kind && select.includes("kind")) q = q.eq("kind", kind);
    return q;
  };
  const full = await run("id,name,location,ownership,state,kind");
  if (!full.error) return send(full.data);
  if (!/column/i.test(full.error.message)) return res.status(500).json({ error: full.error.message });
  if (kind) return send([]); // kind unknown pre-upgrade: honestly empty
  const mid = await run("id,name,location,ownership,state");
  if (!mid.error) return send(mid.data);
  if (!/column/i.test(mid.error.message)) return res.status(500).json({ error: mid.error.message });
  const base = await run("id,name,location");
  if (base.error) return res.status(500).json({ error: base.error.message });
  return send(own ? [] : (base.data || []));
});

app.get("/api/institutions/:id/tree", async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return bad(res, "id must be a positive integer");
  if (!supabase) return res.status(500).json({ error: "Supabase not configured" });
  const cached = treeCache.get(id);
  if (cached && Date.now() - cached.at < CACHE_MS) {
    res.setHeader("Cache-Control", PUBLIC_CACHE);
    return res.json(cached.data);
  }
  const { data: inst, error: iErr } = await (async () => {
    const full = await supabase.from("institutions").select("id,name,location,ownership,state").eq("id", id).single();
    if (full.error && /column/i.test(full.error.message)) {
      return supabase.from("institutions").select("id,name,location").eq("id", id).single();
    }
    return full;
  })();
  if (iErr || !inst) return res.status(404).json({ error: "Institution not found" });
  // Faculties and hub are independent; run them together.
  const [facRes, hub] = await Promise.all([
    supabase.from("faculties").select("id,name").eq("institution_id", id).order("name"),
    readHub(id)
  ]);
  const facs = facRes.data, fErr = facRes.error;
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
  const tree = (facs || []).map(f => ({
    ...f,
    departments: depts.filter(d => d.faculty_id === f.id).map(d => ({
      ...d, programmes: progs.filter(p => p.department_id === d.id)
    }))
  }));
  const body = { ...inst, faculties: tree, hub: hub || null };
  treeCache.set(id, { at: Date.now(), data: body });
  if (treeCache.size > 200) treeCache.delete(treeCache.keys().next().value);
  res.setHeader("Cache-Control", PUBLIC_CACHE);
  res.json(body);
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
// Read identity straight from the bearer token instead of calling the auth
// server on every request (one less network hop in the hot path). Safe because
// PostgREST still verifies the JWT signature on the very next query — a forged
// token cannot read or write anything, and an expired one is rejected here
// (exp) or there (PGRST301 -> 401 via dbErr).
function bearerUser(req) {
  const token = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  if (!token || !process.env.SUPABASE_URL || !process.env.SUPABASE_ANON_KEY) return null;
  try {
    const p = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"));
    if (!p || typeof p.sub !== "string" || !p.sub) return null;
    if (p.exp && p.exp * 1000 <= Date.now()) return null;
    return { id: p.sub, email: p.email || null };
  } catch (e) { return null; }
}
async function authedUser(req) {
  const user = bearerUser(req);
  const me = authedClient(req);
  if (!user || !me) return null;
  return { me, user };
}
// Full verification (network call to the auth server) — only where the email
// claim alone is not enough, e.g. admin checks.
async function verifiedUser(req) {
  const me = authedClient(req);
  if (!me) return null;
  const { data: { user } } = await me.auth.getUser();
  return user ? { me, user } : null;
}
// Map PostgREST auth failures (forged/expired token surfacing on the first
// signature-verified query) to 401 instead of a generic 500.
function dbErr(res, error) {
  const auth = !!(error && (error.status === 401 || /^PGRST30/.test(error.code || "") || /\bjwt\b/i.test(error.message || "")));
  res.status(auth ? 401 : 500).json({ error: (error && error.message) || "Database error" });
}
function adminEmails() { return (process.env.ADMIN_EMAILS || "").split(",").map(e => e.trim().toLowerCase()).filter(Boolean); }
// Admin access is either the legacy env allowlist or a seeded user_roles row.
// The role lookup uses the user's own JWT ("read own roles" RLS policy), so it
// works before/without a service-role key.
async function dbAdminRole(auth) {
  try {
    const { data, error } = await auth.me.from("user_roles").select("role").eq("user_id", auth.user.id);
    if (error) return null;
    const roles = (data || []).map(r => r.role);
    // Prefer the highest privilege when a user has more than one role row.
    return ["super_admin", "content_admin", "moderator"].find(r => roles.includes(r)) || null;
  } catch (e) {
    return null;
  }
}
async function isAdminUser(auth) {
  if (adminEmails().includes((auth.user.email || "").toLowerCase())) return true;
  return !!(await dbAdminRole(auth));
}
async function requireAdmin(req, res) {
  const auth = await verifiedUser(req).catch(() => null);
  if (!auth) { res.status(401).json({ error: "Missing or invalid Authorization Bearer token" }); return null; }
  if (!(await isAdminUser(auth))) { res.status(403).json({ error: "Admin only" }); return null; }
  return auth;
}

app.post("/api/auth/signup", rateLimit("signup", 10, 60 * 1000), async (req, res) => {
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

app.post("/api/auth/login", rateLimit("login", 20, 60 * 1000), async (req, res) => {
  const { email, password } = req.body || {};
  if (!isEmail(email) || typeof password !== "string" || !password) return bad(res, "email and password are required");
  if (!supabase) return res.status(500).json({ error: "Supabase not configured" });
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) return res.status(401).json({ error: error.message });
  res.json({ user: data.user, session: data.session });
});

app.post("/api/auth/refresh", async (req, res) => {
  const { refresh_token } = req.body || {};
  if (typeof refresh_token !== "string" || !refresh_token) return bad(res, "refresh_token is required");
  if (!supabase) return res.status(500).json({ error: "Supabase not configured" });
  const { data, error } = await supabase.auth.refreshSession({ refresh_token });
  if (error) return res.status(401).json({ error: error.message });
  res.json({ user: data.user, session: data.session });
});

app.post("/api/auth/resend", rateLimit("resend", 5, 60 * 1000), async (req, res) => {
  const { email } = req.body || {};
  if (!isEmail(email)) return bad(res, "email is invalid");
  if (!supabase) return res.status(500).json({ error: "Supabase not configured" });
  const { error } = await supabase.auth.resend({ type: "signup", email });
  if (error) return res.status(400).json({ error: error.message });
  res.json({ ok: true, message: "Confirmation email re-sent if the account exists." });
});

app.post("/api/auth/forgot", rateLimit("forgot", 5, 60 * 1000), async (req, res) => {
  const { email } = req.body || {};
  if (!isEmail(email)) return bad(res, "email is invalid");
  if (!supabase) return res.status(500).json({ error: "Supabase not configured" });
  const { error } = await supabase.auth.resetPasswordForEmail(email, { redirectTo: appUrl(req) + "/" });
  if (error) return res.status(400).json({ error: error.message });
  res.json({ ok: true, message: "If that email is registered, a reset link is on its way." });
});

app.post("/api/auth/recover", rateLimit("recover", 20, 60 * 1000), async (req, res) => {
  const { code } = req.body || {};
  if (typeof code !== "string" || !code) return bad(res, "code is required");
  if (!supabase) return res.status(500).json({ error: "Supabase not configured" });
  const { data, error } = await supabase.auth.exchangeCodeForSession(code);
  if (error) return res.status(400).json({ error: error.message });
  res.json({ user: data.user, session: data.session });
});

app.put("/api/auth/password", rateLimit("password", 20, 60 * 1000), async (req, res) => {
  const auth = await authedUser(req).catch(() => null);
  if (!auth) return res.status(401).json({ error: "Missing or invalid Authorization Bearer token" });
  const { password } = req.body || {};
  if (typeof password !== "string" || password.length < 6) return bad(res, "password must be at least 6 characters");
  const { data, error } = await auth.me.auth.updateUser({ password });
  if (error) return res.status(400).json({ error: error.message });
  res.json({ ok: true, user: data.user });
});

app.post("/api/auth/logout", async (req, res) => {
  const auth = await authedUser(req).catch(() => null);
  if (auth) {
    try { await auth.me.auth.signOut(); } catch (e) { /* session may already be gone */ }
  }
  res.json({ ok: true });
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

app.post("/api/profile/photo", rateLimit("photo", 20, 60 * 1000), photoUpload, async (req, res) => {
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
  if (!data || !data.photo_url) return res.status(500).json({ error: "Photo uploaded but your profile was not updated. Check the avatars storage policy." });
  res.json(data);
});

app.use((err, req, res, next) => {
  if (err && err.code === "LIMIT_FILE_SIZE") return bad(res, "photo must be under 4MB");
  next(err);
});

// ---- Phase 3: Connections (Supabase; RLS enforced in the database) ----
app.get("/api/students", async (req, res) => {
  const auth = await authedUser(req).catch(() => null);
  if (!auth) return res.status(401).json({ error: "Missing or invalid Authorization Bearer token" });
  const { data, error } = await profilesFrom(auth.me, q => q
    .select("id,name,user_type,school,dept,session,photo_url")
    .neq("visibility", "private").neq("id", auth.user.id).limit(50));
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.post("/api/connections/request", rateLimit("connect", 60, 60 * 1000), async (req, res) => {
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
    const { data: profs } = await profilesFrom(auth.me, q => q.select("id,name,school,photo_url").in("id", ids));
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

// ---- Phase 6: Private 1-to-1 messaging (connection-gated; Supabase tables, never local files) ----
const msgRate = {}; // light per-user send throttle (best-effort; restarts clear it)
function msgAllowed(uid) {
  const now = Date.now(), windowMs = 60 * 1000, max = 30;
  const hits = (msgRate[uid] || []).filter(t => now - t < windowMs);
  if (hits.length >= max) return false;
  hits.push(now); msgRate[uid] = hits;
  return true;
}
async function acceptedConnection(client, uid, otherId) {
  const { data, error } = await client.from("connections").select("requester_id,addressee_id")
    .eq("status", "accepted").or("requester_id.eq." + uid + ",addressee_id.eq." + uid).limit(200);
  if (error || !data) return false;
  return data.some(c => (c.requester_id === uid && c.addressee_id === otherId) ||
    (c.addressee_id === uid && c.requester_id === otherId));
}
// Phase 2: an accepted mentorship request is also a valid messaging gate.
// A missing mentor_requests table means the migration is not applied yet, so
// this simply falls back to connection-only messaging.
async function acceptedMentorRequest(client, uid, otherId) {
  try {
    const { data, error } = await client.from("mentor_requests").select("requester_id,mentor_id")
      .eq("status", "accepted")
      .or("requester_id.eq." + uid + ",mentor_id.eq." + uid).limit(200);
    if (error || !data) return false;
    return data.some(r => (r.requester_id === uid && r.mentor_id === otherId) ||
      (r.mentor_id === uid && r.requester_id === otherId));
  } catch (e) { return false; }
}
// Phase 3: an accepted accommodation/service listing request is also a valid
// messaging gate. Missing tables fall back to connection/mentor-only messaging.
async function acceptedListingRequest(client, uid, otherId) {
  try {
    const { data, error } = await client.from("listing_requests").select("requester_id,owner_id")
      .eq("status", "accepted")
      .or("requester_id.eq." + uid + ",owner_id.eq." + uid).limit(200);
    if (error || !data) return false;
    return data.some(r => (r.requester_id === uid && r.owner_id === otherId) ||
      (r.owner_id === uid && r.requester_id === otherId));
  } catch (e) { return false; }
}
async function myConversationIds(client, uid) {
  const { data, error } = await client.from("participants").select("conversation_id").eq("user_id", uid).limit(200);
  if (error || !data) return null;
  return data.map(p => p.conversation_id);
}
async function findSharedConversation(client, uid, otherId) {
  const ids = await myConversationIds(client, uid);
  if (ids === null) return { error: "lookup failed" };
  if (!ids.length) return { id: null };
  const { data, error } = await client.from("participants").select("conversation_id")
    .in("conversation_id", ids).eq("user_id", otherId).limit(1);
  if (error) return { error: error.message };
  return { id: data && data.length ? data[0].conversation_id : null };
}
async function threadOther(client, uid, convoId) {
  const { data, error } = await client.from("participants").select("user_id").eq("conversation_id", convoId);
  if (error || !data) return null;
  const other = (data.map(p => p.user_id).filter(id => id !== uid))[0] || null;
  if (!other) return null;
  const { data: prof } = await profilesFrom(client, q => q.select("id,name,photo_url,school").eq("id", other).single());
  return prof || { id: other, name: "Student" };
}
async function requireThread(req, res) {
  const auth = await authedUser(req).catch(() => null);
  if (!auth) { res.status(401).json({ error: "Missing or invalid Authorization Bearer token" }); return null; }
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) { bad(res, "id must be a positive integer"); return null; }
  // One query answers both "am I in this thread?" (RLS hides threads I'm not
  // in, so no rows = not found) and "who is the other side?" for the response.
  const { data: rows, error } = await auth.me.from("participants").select("user_id")
    .eq("conversation_id", id);
  if (error) { dbErr(res, error); return null; }
  const uids = (rows || []).map(p => p.user_id);
  if (!uids.includes(auth.user.id)) { res.status(404).json({ error: "Conversation not found" }); return null; }
  const otherId = uids.filter(u => u !== auth.user.id)[0] || null;
  return { me: auth.me, uid: auth.user.id, id, otherId };
}

app.post("/api/conversations/open", async (req, res) => {
  const auth = await authedUser(req).catch(() => null);
  if (!auth) return res.status(401).json({ error: "Missing or invalid Authorization Bearer token" });
  const otherId = req.body && req.body.otherId;
  if (typeof otherId !== "string" || !otherId) return bad(res, "otherId is required");
  if (otherId === auth.user.id) return bad(res, "cannot message yourself");
  if (!supabase && !auth.me) return res.status(500).json({ error: "Supabase not configured" });
  // independent reads — run them together instead of one after the other
  const [ok, mentorOk, listingOk, found] = await Promise.all([
    acceptedConnection(auth.me, auth.user.id, otherId),
    acceptedMentorRequest(auth.me, auth.user.id, otherId),
    acceptedListingRequest(auth.me, auth.user.id, otherId),
    findSharedConversation(auth.me, auth.user.id, otherId),
  ]);
  if (!ok && !mentorOk && !listingOk) {
    return res.status(403).json({ error: "You need an accepted connection, mentorship, or listing request to message this user." });
  }
  if (found.error) return res.status(500).json({ error: found.error });
  let convoId = found.id;
  if (!convoId) {
    // Thread creation is atomic in the database: INSERT ... RETURNING (what
    // .insert().select() sends) must also pass the SELECT policy, which a
    // brand-new conversation with no participants cannot (42501). The
    // open_conversation() definer function writes both rows in one step and
    // re-checks the accepted connection itself.
    const { data: cid, error: rpcErr } = await auth.me.rpc("open_conversation", { other: otherId });
    if (rpcErr) return res.status(500).json({ error: rpcErr.message });
    convoId = cid;
  }
  const other = await threadOther(auth.me, auth.user.id, convoId);
  res.json({ id: convoId, other });
});

app.get("/api/conversations", async (req, res) => {
  const auth = await authedUser(req).catch(() => null);
  if (!auth) return res.status(401).json({ error: "Missing or invalid Authorization Bearer token" });
  const ids = await myConversationIds(auth.me, auth.user.id);
  if (ids === null) return res.status(500).json({ error: "lookup failed" });
  const cids = ids.slice(0, 50);
  if (!cids.length) return res.json({ conversations: [], totalUnread: 0 });

  // Batch what used to be 4 serial queries per conversation: one participants
  // fetch, one profiles fetch, one unread fetch — and the per-thread last
  // message (PostgREST has no group-by) in parallel rather than in a loop.
  const { data: parts, error: pErr } = await auth.me.from("participants")
    .select("conversation_id,user_id").in("conversation_id", cids);
  if (pErr) return dbErr(res, pErr);
  const otherByConvo = {};
  (parts || []).forEach(p => {
    if (p.user_id !== auth.user.id && !(p.conversation_id in otherByConvo)) otherByConvo[p.conversation_id] = p.user_id;
  });
  const otherIds = [...new Set(Object.values(otherByConvo))];
  const profQ = otherIds.length
    ? profilesFrom(auth.me, q => q.select("id,name,photo_url,school").in("id", otherIds))
    : Promise.resolve({ data: [], error: null });
  const [pr, un, lasts] = await Promise.all([
    profQ,
    auth.me.from("messages").select("conversation_id")
      .in("conversation_id", cids).neq("sender_id", auth.user.id).is("read_at", null),
    Promise.all(cids.map(cid => auth.me.from("messages").select("id,text,created_at,sender_id")
      .eq("conversation_id", cid).order("created_at", { ascending: false }).limit(1))),
  ]);
  if (pr.error) return dbErr(res, pr.error);
  if (un.error) return dbErr(res, un.error);
  const lastErr = lasts.find(l => l.error);
  if (lastErr) return dbErr(res, lastErr.error);
  const profById = {};
  (pr.data || []).forEach(p => { profById[p.id] = p; });
  const unread = {};
  (un.data || []).forEach(m => { unread[m.conversation_id] = (unread[m.conversation_id] || 0) + 1; });
  const out = [];
  for (let i = 0; i < cids.length; i++) {
    const cid = cids[i];
    const oid = otherByConvo[cid];
    if (!oid) continue;
    const other = profById[oid] || { id: oid, name: "Student" };
    const lm = (lasts[i].data && lasts[i].data[0]) || null;
    out.push({ id: cid, other, lastMessage: lm ? { text: lm.text, created_at: lm.created_at, mine: lm.sender_id === auth.user.id } : null, unread: unread[cid] || 0 });
  }
  out.sort((a, b) => {
    const ta = a.lastMessage ? a.lastMessage.created_at : "", tb = b.lastMessage ? b.lastMessage.created_at : "";
    return ta < tb ? 1 : ta > tb ? -1 : 0;
  });
  res.json({ conversations: out, totalUnread: out.reduce((n, c) => n + c.unread, 0) });
});

app.get("/api/conversations/:id/messages", async (req, res) => {
  const t = await requireThread(req, res);
  if (!t) return;
  let limit = parseInt(req.query.limit, 10);
  if (!Number.isInteger(limit) || limit <= 0) limit = 50;
  if (limit > 100) limit = 100;
  const before = Number(req.query.before);
  let q = t.me.from("messages").select("id,sender_id,text,created_at,read_at").eq("conversation_id", t.id);
  if (Number.isInteger(before) && before > 0) q = q.lt("id", before);
  q = q.order("id", { ascending: false }).limit(limit);
  // The other participant's profile and the messages are independent —
  // fetch them together (requireThread already gave us the other id).
  const profQ = t.otherId
    ? profilesFrom(t.me, q => q.select("id,name,photo_url,school").eq("id", t.otherId).single())
    : Promise.resolve({ data: null, error: null });
  const [mr, pr] = await Promise.all([q, profQ]);
  if (mr.error) return dbErr(res, mr.error);
  const other = pr.data || (t.otherId ? { id: t.otherId, name: "Student" } : null);
  res.json({ other, messages: (mr.data || []).reverse().map(m => ({ ...m, mine: m.sender_id === t.uid })) });
});

app.post("/api/conversations/:id/messages", async (req, res) => {
  const auth = await authedUser(req).catch(() => null);
  if (!auth) return res.status(401).json({ error: "Missing or invalid Authorization Bearer token" });
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return bad(res, "id must be a positive integer");
  const text = req.body && req.body.text;
  if (typeof text !== "string" || !text.trim() || text.length > 2000) return bad(res, "text must be 1–2000 characters");
  if (!msgAllowed(auth.user.id)) return res.status(429).json({ error: "Slow down — try again in a minute." });
  // The whole gate rides on RLS inside the insert itself, so a send is one
  // database round trip: not a member -> 42501 (send own thread messages),
  // no such thread -> FK 23503 on conversation_id — both mapped to 404.
  // Membership could only ever be granted over an accepted connection, and
  // connections are immutable in v1 (no revoke endpoint), so nothing is lost
  // by not re-checking them here.
  const { data, error } = await auth.me.from("messages")
    .insert({ conversation_id: id, sender_id: auth.user.id, text: text.trim() }).select().single();
  if (error) {
    const code = String(error.code || "");
    if (code === "42501") return res.status(404).json({ error: "Conversation not found" });
    if (code === "23503" && /conversation_id/.test(error.message || "")) return res.status(404).json({ error: "Conversation not found" });
    return dbErr(res, error);
  }
  // last_message_at only feeds list ordering — don't hold the response for it
  Promise.resolve(auth.me.from("conversations").update({ last_message_at: new Date().toISOString() }).eq("id", id))
    .catch(() => {});
  res.json({ ...data, mine: true });
});

app.post("/api/conversations/:id/read", async (req, res) => {
  const t = await requireThread(req, res);
  if (!t) return;
  const { error, count } = await t.me.from("messages").update({ read_at: new Date().toISOString() }, { count: "exact" })
    .eq("conversation_id", t.id).neq("sender_id", t.uid).is("read_at", null);
  if (error) return dbErr(res, error);
  res.json({ ok: true, marked: count || 0 });
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
  return readHub(institutionId);
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
function hubVerified(hub) { return !!(hub && hub.verified === true); }
function hubSources(hub) {
  const out = [];
  if (hub && typeof hub.source_url === "string" && /^https?:\/\//i.test(hub.source_url)) {
    out.push({ label: "Institution source", url: hub.source_url });
  }
  const links = hub && Array.isArray(hub.official_links) ? hub.official_links : [];
  links.slice(0, 6).forEach(l => {
    if (l && typeof l.url === "string" && /^https?:\/\//i.test(l.url)) {
      out.push({ label: String(l.label || "Official link").slice(0, 80), url: l.url });
    }
  });
  return out;
}
function findFaq(hub, q) {
  const items = hub && Array.isArray(hub.faq) ? hub.faq : [];
  const words = new Set(q.replace(/[^a-z0-9]+/g, " ").split(" ").filter(w => w.length >= 4));
  let best = null, bestScore = 0;
  for (const item of items) {
    if (!item || typeof item.question !== "string" || typeof item.answer !== "string") continue;
    const qWords = item.question.toLowerCase().replace(/[^a-z0-9]+/g, " ").split(" ").filter(w => w.length >= 4);
    let score = 0;
    qWords.forEach(w => { if (words.has(w)) score++; });
    if (score > bestScore) { bestScore = score; best = item; }
  }
  return bestScore >= 2 ? best : null;
}
app.post("/api/fido/ask", async (req, res) => {
  // PRD §25: Responsible AI principles. This endpoint must always:
  // - Label answers as Official / Community / AI guidance
  // - Never present AI output as institutional decision
  // - Encourage verification against official sources
  // - Include school context when available (so follow-ups stay school-aware)
  // - Hard limits: AI must NEVER decide admissions, scholarships, ability, employment, or financial eligibility
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
  const official = (text) => ({ answer: text, source: "Official", school: sName, verify: true, context: { school: sName }, sources: [] });
  const community = (text) => ({ answer: text, source: "Community", school: sName, verify: true, context: { school: sName }, sources: [] });
  const ai = (text) => {
    // AI guidance: label clearly, always reference official sources where possible,
    // never present as institutional decision, encourage user verification.
    return ({ answer: text, source: "AI guidance", school: sName, verify: true, context: { school: sName }, sources: [] });
  };
  // Hub content is labelled Official only when an admin marked it verified.
  // Otherwise it is community-provided context and must say so.
  const hubAnswer = (text, page) => {
    const verified = hubVerified(page);
    const when = page && page.updated_at ? " Last updated " + new Date(page.updated_at).toLocaleDateString() + "." : "";
    const note = verified
      ? " This institution page is verified by a Fidonect admin." + when
      : " This is community-provided information and is not yet verified by Fidonect — confirm it on the school portal." + when;
    return ({
      answer: text + note,
      source: verified ? "Official" : "Community",
      school: sName,
      verify: true,
      verified,
      updated_at: page && page.updated_at ? page.updated_at : null,
      sources: hubSources(page),
      context: { school: sName }
    });
  };
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
          const kindLabel = kindQ === "University" ? "universities" : (kindQ === "Polytechnic" ? "polytechnics" : (kindQ === "College of Education" ? "colleges of education" : ""));
          const label = [ownQ, stHit, kindLabel].filter(Boolean).join(" ");
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
  // Verified/community institution FAQs are the most specific answer we hold.
  const faq = findFaq(hub, q);
  if (faq) {
    return res.json(hubAnswer("From the institution FAQ — " + faq.question + " " + faq.answer, hub));
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
    if (hub && hub.registration) return res.json(hubAnswer("For course registration" + where + ": " + hub.registration + " Pay fees first, register inside the window, print your forms, and confirm with your level adviser.", hub));
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
    if (hub && hub.clearance) return res.json(hubAnswer("For clearance" + where + ": " + hub.clearance + " Go in this order: confirm your name on the admission list, present originals plus photocopies, then keep every receipt. Always confirm on your school portal — requirements vary by department.", hub));
    return res.json(ai("For clearance" + where + ", go in this order: (1) confirm your name on the admission or screening list; (2) gather originals plus 3–4 photocopies of each — JAMB admission letter, O-level result(s), birth certificate or age declaration, LGA identification letter, passport photos; (3) present them at the screening venue; (4) keep every receipt." + (sName ? " Ask in the " + sName + " community for department-specific experience." : " Tell me your school for its specific requirements.")));
  }
  if (/document|what .*(need|require|bring)|checklist/.test(q)) {
    if (hub && hub.clearance) return res.json(hubAnswer("Documents" + where + ": " + hub.clearance + " Carry originals plus photocopies, and confirm the exact list on your school portal.", hub));
    return res.json(ai("Most schools ask for: JAMB admission letter and result slip, O-level result(s), birth certificate or age declaration, LGA or state identification letter, 8–12 passport photographs, acceptance fee receipt, and departmental screening forms. Carry originals plus 3–4 photocopies of each in a file jacket. Exact lists vary — confirm on your school portal before travelling."));
  }
  if (/accommod|hostel|housing|lodge/.test(q)) {
    if (hub && hub.accommodation) return res.json(hubAnswer("Accommodation" + where + ": " + hub.accommodation + " Apply the moment clearance opens — school hostels fill fast.", hub));
    return res.json(ai("Accommodation plan" + where + ": (1) apply for the school hostel immediately after clearance; (2) line up a private hostel nearby as backup; (3) before paying, inspect security, water, light, and distance to campus; (4) never pay into personal accounts or before seeing the room. Ask connected students where they stay."));
  }
  if (/fee|school charges|payment|tuition/.test(q)) {
    if (hub && hub.fees) return res.json(hubAnswer("Fees" + where + ": " + hub.fees + " Pay only through channels named on the official portal and keep every receipt.", hub));
    return res.json(ai("I don't hold verified fee figures for every school" + (sName ? " — including " + sName + " — " : "") + " so tell me your school and I'll share what we hold. Generally: check the official school portal for the current schedule (it changes per session and faculty), pay only through official channels, keep receipts, and never pay into personal accounts — report payment scams."));
  }
  if (/(important|key|academic|school|admission|resumption).*(date|dates|calendar|timetable)|when.*(resume|resumption|session)/.test(q)) {
    if (hub && hub.dates) return res.json(hubAnswer("Key dates" + where + ": " + hub.dates + " Dates change per session — confirm on the official portal before travelling or paying.", hub));
  }
  if (/transport|bus|shuttle|how.*(get|travel).*(campus|school)|direction/.test(q)) {
    if (hub && hub.transport) return res.json(hubAnswer("Transport" + where + ": " + hub.transport, hub));
  }
  if (/facilit|library|lab|laboratory|clinic|health cent|sports/.test(q)) {
    if (hub && hub.facilities) return res.json(hubAnswer("Facilities" + where + ": " + hub.facilities, hub));
  }
  if (/official (website|site|portal|link)|school (website|portal)|where.*(verify|confirm)/.test(q)) {
    const links = hubSources(hub);
    if (links.length) {
      const label = links.map(l => l.label + ": " + l.url).join("; ");
      return res.json({ ...hubAnswer("Use these official channels" + where + ": " + label + ". Fidonect links out and never asks for your password or payment details.", hub), sources: links });
    }
  }
  if (/cut.?off|post-utme|postutme|merit list|supplementary|supplemental/.test(q)) {
    return res.json(ai("On cut-off marks and screening" + where + ": (1) meet the general JAMB cut-off, then the departmental cut-off — departments set theirs separately and figures change every year, so last year's numbers are a guide only; (2) register for the school's post-UTME or screening exercise before its deadline; (3) track merit, supplementary, and VC lists on the portal. Only trust lists on the official portal or JAMB CAPS."));
  }
  if (/admission|jamb/.test(q)) {
    if (hub && hub.admission) return res.json(hubAnswer("Admission information" + where + ": " + hub.admission + " Also track JAMB CAPS and accept your offer there. Only trust offers on CAPS or the official school portal.", hub));
    return res.json(ai("For admission" + where + ": (1) track JAMB CAPS and accept your offer there; (2) watch the school portal for merit, supplementary, or VC lists; (3) note departmental cut-off marks change every year, so treat last year's figures as a guide only; (4) print your JAMB admission letter early. Only trust offers on CAPS or the official portal — anyone asking for money to 'secure' admission is running a scam."));
  }
  if (/resum|prepare|first semester|freshers|fresher|new student|packing|pack/.test(q)) {
    return res.json(ai("Resumption prep" + where + ": documents — originals plus photocopies in a file jacket; accommodation — confirmed before you travel; academics — departmental reading list and basic stationery; living — bedding, cooking basics, toiletries, and a lockable box; people — connect with 2–3 classmates, find a mentor here before you arrive, and join a recognized faith fellowship on campus (BLW, RCF, MSSN or equivalents where present) that is approved by the school authority. Travel light on day one and buy bulky items near campus." + (sName ? "" : " Tell me your school for campus-specific tips.")));
  }
  if (/orientation|matric|matriculation/.test(q)) {
    return res.json(ai("Orientation and matriculation" + where + ": expect campus tours, faculty and department introductions, library and portal training, and the matriculation oath that formally admits you. Go with writing materials and your admission documents — and use the week to meet classmates and find a mentor. Settle socially too: join your department association and a recognized campus fellowship matching your faith — e.g. Believers' Loveworld, Redeemed Christian Fellowship, MSSN, or equivalents present on your campus — but stick only to groups approved by the school authority."));
  }
  if (/\bnysc\b|youth service|service year|mobiliz/.test(q)) {
    return res.json(ai("On NYSC (looking ahead): after graduation your school mobilizes you — (1) finish strong, since graduation and clearance come first; (2) keep your personal details consistent across JAMB, school, and NYSC records to avoid mobilization issues; (3) watch your school's student-affairs notices in final year for the mobilization timetable. Focus on getting admitted and settled first — we'll walk the NYSC road when you get there."));
  }
  if (/campus life|safe|safety|secur|scam|fraud|theft|night|emergency|health/.test(q)) {
    return res.json(ai("Staying safe on campus" + where + ": (1) avoid lonely routes at night and share your movement with a roommate; (2) lock your room and travel light with valuables; (3) use the school health centre early when sick — don't self-medicate for long; (4) verify every payment, hostel offer, and 'exam expo' before committing — scams target freshers most. Save your department and security contacts in your phone. Ask in the community which areas students recommend." + (sName ? "" : " Tell me your school for campus-specific pointers.")));
  }
  if (/study|exam|gp|grade|reading|tutorial|past question/.test(q)) {
    return res.json(ai("Study smart" + where + ": (1) get each course outline in week one; (2) build a weekly timetable and protect study hours; (3) join department study threads and ask mentors for past questions; (4) revise weekly instead of cramming; (5) guard your first-semester GPA — it sets your foundation. Which course is giving you trouble? I can share how to approach it."));
  }
  return res.json(ai("I can guide you step by step on: next steps after admission, JAMB CAPS and subject combinations, cut-off marks, Direct Entry, clearance documents, course registration, fees, accommodation, scholarships, finding courses, orientation, resumption prep, campus safety, NYSC, and study tips" + where + ". Try: 'I just got admitted — what next?' or 'What subjects do I need for Medicine?'"));
});
// ---- Phase 2: Mentorship, verified institution info, Fido feedback ----
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isUuid(v) { return typeof v === "string" && UUID_RE.test(v); }
function phase2DbError(res, error, label) {
  if (missingRelation(error)) {
    return res.status(503).json({
      error: (label || "Phase 2 content") + " is not set up yet. Run backend/migrations/20261116_phase2_mentorship_hubs_fido.sql in the Supabase SQL Editor.",
      setupRequired: true
    });
  }
  if (error && (error.code === "42501" || error.code === "PGRST301")) {
    return res.status(403).json({ error: "Permission denied. Sign in with an admin account or run the Phase 2 migration." });
  }
  return res.status(500).json({ error: (error && error.message) || "Database error" });
}
const MENTOR_PUBLIC_FIELDS = "user_id,name,photo_url,user_type,institution_id,institution_name,faculty,department,programme,level,bio,help_areas,verified_at,updated_at,institution_location,ownership,kind";
const MENTOR_ADMIN_FIELDS = "*";

function mentorInput(body) {
  const src = body || {};
  if (!isText(src.school, 160) || src.school.trim().length < 2) return { error: "school is required (2–160 chars)" };
  if (!isText(src.bio, 2000) || src.bio.trim().length < 20) return { error: "bio is required (20–2000 chars)" };
  let areas = src.help_areas;
  if (typeof areas === "string") areas = areas.split(",");
  if (!Array.isArray(areas)) return { error: "help_areas must be an array of up to 8 short areas" };
  areas = [...new Set(areas.map(a => typeof a === "string" ? a.trim() : "").filter(Boolean))];
  if (areas.length < 1 || areas.length > 8) return { error: "help_areas must contain 1–8 areas" };
  if (areas.some(a => a.length < 2 || a.length > 80)) return { error: "each help area must be 2–80 chars" };
  const method = src.verification_method;
  if (!["institutional_email", "student_id", "other"].includes(method)) {
    return { error: "verification_method must be institutional_email, student_id, or other" };
  }
  const optional = {};
  for (const [field, max] of Object.entries({ faculty: 160, department: 160, programme: 160, level: 80 })) {
    if (src[field] === undefined || src[field] === null || src[field] === "") continue;
    if (typeof src[field] !== "string" || src[field].length > max) return { error: field + " is invalid (max " + max + " chars)" };
    optional[field] = src[field].trim();
  }
  let detail = null;
  if (src.verification_detail !== undefined && src.verification_detail !== null) {
    if (typeof src.verification_detail !== "string" || src.verification_detail.length > 300) {
      return { error: "verification_detail is invalid (max 300 chars)" };
    }
    detail = src.verification_detail.trim() || null;
  }
  return {
    data: {
      school: src.school.trim(),
      institution_id: src.institution_id === undefined ? undefined : parsePositiveInt(src.institution_id, 0),
      bio: src.bio.trim(),
      help_areas: areas,
      verification_method: method,
      verification_detail: detail,
      ...optional
    }
  };
}

app.get("/api/mentors", async (req, res) => {
  if (!supabase) return res.status(500).json({ error: "Supabase not configured" });
  const limit = parsePositiveInt(req.query.limit, 30, 100);
  const institutionId = req.query.institution_id === undefined ? null : parsePositiveInt(req.query.institution_id, 0);
  if (req.query.institution_id !== undefined && !institutionId) return bad(res, "institution_id must be a positive integer");
  const q = cleanText(req.query.q, 80).replace(/[%,()]/g, " ").trim();
  let query = supabase.from("mentor_directory").select(MENTOR_PUBLIC_FIELDS, { count: "exact" });
  if (institutionId) query = query.eq("institution_id", institutionId);
  if (q) query = query.or("name.ilike.%" + q + "%,institution_name.ilike.%" + q + "%,department.ilike.%" + q + "%,bio.ilike.%" + q + "%");
  const { data, error, count } = await query.order("verified_at", { ascending: false, nullsFirst: false }).limit(limit);
  if (error) {
    if (missingRelation(error)) return res.json({ mentors: [], total: 0, setupRequired: true });
    return res.status(500).json({ error: error.message });
  }
  res.setHeader("Cache-Control", PUBLIC_CACHE);
  res.json({ mentors: data || [], total: count || 0, setupRequired: false });
});

app.get("/api/mentors/me", async (req, res) => {
  const auth = await authedUser(req).catch(() => null);
  if (!auth) return res.status(401).json({ error: "Missing or invalid Authorization Bearer token" });
  const { data, error } = await auth.me.from("mentor_profiles").select("*").eq("user_id", auth.user.id).maybeSingle();
  if (error) {
    if (missingRelation(error)) return res.json({ mentor: null, setupRequired: true });
    return res.status(500).json({ error: error.message });
  }
  res.json({ mentor: data || null, setupRequired: false });
});

app.post("/api/mentors/apply", rateLimit("mentorapply", 10, 60 * 1000), async (req, res) => {
  const auth = await authedUser(req).catch(() => null);
  if (!auth) return res.status(401).json({ error: "Missing or invalid Authorization Bearer token" });
  const parsed = mentorInput(req.body);
  if (parsed.error) return bad(res, parsed.error);
  const input = parsed.data;
  let institution = null;
  if (input.institution_id) {
    const { data, error } = await supabase.from("institutions").select("id,name").eq("id", input.institution_id).single();
    if (error || !data) return bad(res, "institution_id was not found in the directory");
    institution = data;
  } else {
    const { data } = await supabase.from("institutions").select("id,name").ilike("name", input.school).limit(1);
    institution = data && data[0] ? data[0] : null;
  }
  if (!institution) return bad(res, "Choose an institution from the Fidonect directory.");
  const row = {
    user_id: auth.user.id,
    institution_id: institution.id,
    institution_name: institution.name,
    faculty: input.faculty || null,
    department: input.department || null,
    programme: input.programme || null,
    level: input.level || null,
    bio: input.bio,
    help_areas: input.help_areas,
    verification_method: input.verification_method,
    verification_detail: input.verification_detail,
    listed: req.body.listed !== false,
    status: "pending",
    verified_at: null,
    verified_by: null,
    admin_note: null
  };
  const { data, error } = await auth.me.from("mentor_profiles")
    .upsert(row, { onConflict: "user_id" }).select(MENTOR_ADMIN_FIELDS).single();
  if (error) return phase2DbError(res, error, "Mentorship");
  res.json({ mentor: data, setupRequired: false });
});

app.post("/api/mentor-requests", rateLimit("mentorrequest", 20, 60 * 1000), async (req, res) => {
  const auth = await authedUser(req).catch(() => null);
  if (!auth) return res.status(401).json({ error: "Missing or invalid Authorization Bearer token" });
  const mentorId = req.body && req.body.mentor_id;
  const topic = req.body && req.body.topic;
  const message = req.body && req.body.message;
  if (!isUuid(mentorId)) return bad(res, "mentor_id is required");
  if (mentorId === auth.user.id) return bad(res, "cannot request mentorship from yourself");
  if (!isText(topic, 120) || topic.trim().length < 3) return bad(res, "topic must be 3–120 characters");
  if (!isText(message, 2000) || message.trim().length < 10) return bad(res, "message must be 10–2000 characters");
  const { data: mentor, error: findError } = await supabase.from("mentor_directory")
    .select("user_id").eq("user_id", mentorId).maybeSingle();
  if (findError) return phase2DbError(res, findError, "Mentorship");
  if (!mentor) return res.status(404).json({ error: "Mentor not found or not verified" });
  const { data, error } = await auth.me.from("mentor_requests").insert({
    requester_id: auth.user.id, mentor_id: mentorId, topic: topic.trim(), message: message.trim()
  }).select().single();
  if (error) {
    if (error.code === "23505") return res.status(409).json({ error: "You already have a pending request with this mentor." });
    return phase2DbError(res, error, "Mentorship requests");
  }
  res.json(data);
});

app.get("/api/mentor-requests/mine", async (req, res) => {
  const auth = await authedUser(req).catch(() => null);
  if (!auth) return res.status(401).json({ error: "Missing or invalid Authorization Bearer token" });
  const { data, error } = await auth.me.from("mentor_requests").select("*")
    .or("requester_id.eq." + auth.user.id + ",mentor_id.eq." + auth.user.id)
    .order("created_at", { ascending: false }).limit(100);
  if (error) {
    if (missingRelation(error)) return res.json({ incoming: [], outgoing: [], setupRequired: true });
    return res.status(500).json({ error: error.message });
  }
  const ids = [...new Set((data || []).flatMap(r => [r.requester_id, r.mentor_id]).filter(id => id !== auth.user.id))];
  let profiles = {};
  if (ids.length) {
    const pr = await profilesFrom(auth.me, q => q.select("id,name,photo_url,school,dept,user_type").in("id", ids));
    (pr.data || []).forEach(p => { profiles[p.id] = p; });
  }
  const shape = r => {
    const otherId = r.requester_id === auth.user.id ? r.mentor_id : r.requester_id;
    return { ...r, other: profiles[otherId] || { id: otherId, name: "Student" } };
  };
  res.json({
    incoming: (data || []).filter(r => r.mentor_id === auth.user.id).map(shape),
    outgoing: (data || []).filter(r => r.requester_id === auth.user.id).map(shape),
    setupRequired: false
  });
});

app.post("/api/mentor-requests/:id/respond", async (req, res) => {
  const auth = await authedUser(req).catch(() => null);
  if (!auth) return res.status(401).json({ error: "Missing or invalid Authorization Bearer token" });
  const id = parsePositiveInt(req.params.id, 0);
  const action = req.body && req.body.action;
  if (!id) return bad(res, "id must be a positive integer");
  if (!["accept", "decline", "cancel", "complete"].includes(action)) {
    return bad(res, "action must be accept, decline, cancel, or complete");
  }
  const { data: row, error } = await auth.me.from("mentor_requests").select("*").eq("id", id).maybeSingle();
  if (error) return phase2DbError(res, error, "Mentorship requests");
  if (!row) return res.status(404).json({ error: "Mentorship request not found" });
  let next = null;
  if (action === "accept" || action === "decline") {
    if (row.mentor_id !== auth.user.id) return res.status(403).json({ error: "Only the mentor can respond to this request" });
    if (row.status !== "pending") return res.status(409).json({ error: "This request is no longer pending" });
    next = action === "accept" ? "accepted" : "declined";
  } else if (action === "cancel") {
    if (row.requester_id !== auth.user.id) return res.status(403).json({ error: "Only the requester can cancel this request" });
    if (row.status !== "pending") return res.status(409).json({ error: "Only a pending request can be cancelled" });
    next = "cancelled";
  } else {
    if (row.requester_id !== auth.user.id && row.mentor_id !== auth.user.id) return res.status(403).json({ error: "Not your request" });
    if (row.status !== "accepted") return res.status(409).json({ error: "Only an accepted request can be completed" });
    next = "completed";
  }
  const { data, error: upErr } = await auth.me.from("mentor_requests")
    .update({ status: next, responded_at: new Date().toISOString() })
    .eq("id", id).eq("status", row.status).select().single();
  if (upErr) return phase2DbError(res, upErr, "Mentorship requests");
  res.json(data);
});

// ---- Phase 3A: accommodation + campus-service discovery (no bookings/payments) ----
function phase3DbError(res, error, label) {
  if (missingRelation(error)) {
    return res.status(503).json({
      error: (label || "Accommodation and services") + " are not set up yet. Run backend/migrations/20261118_phase3_accommodation_services.sql in the Supabase SQL Editor.",
      setupRequired: true
    });
  }
  if (error && (error.code === "42501" || error.code === "PGRST301")) {
    return res.status(403).json({ error: "Permission denied. Sign in with an admin account or run the Phase 3 migration." });
  }
  return res.status(500).json({ error: (error && error.message) || "Database error" });
}

const LISTING_PUBLIC_FIELDS = "id,kind,owner_id,owner_name,owner_photo_url,owner_user_type,institution_id,institution_name,title,description,area,price_text,price_period,distance_text,amenities,available_from,source,verified,verified_at,updated_at,institution_location,ownership,institution_kind";
const LISTING_KINDS = ["accommodation", "service"];
const LISTING_PERIODS = ["year", "month", "semester", "one-off", "negotiable"];

function listingContentInput(src) {
  const body = src || {};
  if (!LISTING_KINDS.includes(body.kind)) return { error: "kind must be accommodation or service" };
  if (!isText(body.school, 160) || body.school.trim().length < 2) return { error: "school is required (2–160 chars)" };
  if (!isText(body.title, 120) || body.title.trim().length < 3) return { error: "title must be 3–120 characters" };
  if (!isText(body.description, 2000) || body.description.trim().length < 20) {
    return { error: "description must be 20–2000 characters" };
  }
  const out = {
    kind: body.kind,
    school: body.school.trim(),
    title: body.title.trim(),
    description: body.description.trim(),
    area: null,
    price_text: null,
    price_period: null,
    distance_text: null,
    amenities: [],
    available_from: null,
    source_url: null
  };
  for (const [field, max] of Object.entries({ area: 120, price_text: 120, distance_text: 120 })) {
    if (body[field] === undefined || body[field] === null || body[field] === "") continue;
    if (typeof body[field] !== "string" || body[field].length > max) return { error: field + " is invalid (max " + max + " chars)" };
    out[field] = body[field].trim() || null;
  }
  if (body.price_period !== undefined && body.price_period !== null && body.price_period !== "") {
    if (!LISTING_PERIODS.includes(body.price_period)) return { error: "price_period must be year, month, semester, one-off, or negotiable" };
    out.price_period = body.price_period;
  }
  let amenities = body.amenities;
  if (typeof amenities === "string") amenities = amenities.split(",");
  if (amenities !== undefined && amenities !== null) {
    if (!Array.isArray(amenities)) return { error: "amenities must be an array of up to 12 short items" };
    amenities = [...new Set(amenities.map(a => typeof a === "string" ? a.trim() : "").filter(Boolean))];
    if (amenities.length > 12) return { error: "amenities must contain at most 12 items" };
    if (amenities.some(a => a.length < 2 || a.length > 80)) return { error: "each amenity must be 2–80 chars" };
    out.amenities = amenities;
  }
  if (body.available_from !== undefined && body.available_from !== null && body.available_from !== "") {
    if (!isIsoDate(body.available_from)) return { error: "available_from must be YYYY-MM-DD" };
    out.available_from = body.available_from;
  }
  if (body.source_url !== undefined && body.source_url !== null && body.source_url !== "") {
    if (!isHttpUrl(body.source_url)) return { error: "source_url must be a valid http(s) URL" };
    out.source_url = body.source_url.trim();
  }
  if (body.institution_id !== undefined && body.institution_id !== null && body.institution_id !== "") {
    const id = parsePositiveInt(body.institution_id, 0);
    if (!id) return { error: "institution_id must be a positive integer" };
    out.institution_id = id;
  }
  return { data: out };
}

async function resolveListingInstitution(input) {
  if (input.institution_id) {
    const { data, error } = await supabase.from("institutions").select("id,name").eq("id", input.institution_id).maybeSingle();
    if (error || !data) return null;
    return data;
  }
  const safe = String(input.school || "").replace(/[%_]/g, " ").trim();
  if (!safe) return null;
  const { data, error } = await supabase.from("institutions").select("id,name").ilike("name", safe).limit(1);
  if (error || !data) return null;
  return data[0] || null;
}

app.get("/api/listings", async (req, res) => {
  if (!supabase) return res.status(500).json({ error: "Supabase not configured" });
  const limit = parsePositiveInt(req.query.limit, 50, 100);
  const kind = String(req.query.kind || "");
  if (kind && !LISTING_KINDS.includes(kind)) return bad(res, "kind must be accommodation or service");
  const institutionId = req.query.institution_id === undefined ? null : parsePositiveInt(req.query.institution_id, 0);
  if (req.query.institution_id !== undefined && !institutionId) return bad(res, "institution_id must be a positive integer");
  const q = cleanText(req.query.q, 80).replace(/[%,()]/g, " ").trim();
  let query = supabase.from("campus_listing_directory").select(LISTING_PUBLIC_FIELDS, { count: "exact" });
  if (kind) query = query.eq("kind", kind);
  if (institutionId) query = query.eq("institution_id", institutionId);
  if (q) query = query.or("title.ilike.%" + q + "%,area.ilike.%" + q + "%,institution_name.ilike.%" + q + "%,description.ilike.%" + q + "%");
  const { data, error, count } = await query
    .order("verified", { ascending: false })
    .order("updated_at", { ascending: false })
    .limit(limit);
  if (error) {
    if (missingRelation(error)) return res.json({ listings: [], total: 0, setupRequired: true });
    return res.status(500).json({ error: error.message });
  }
  res.setHeader("Cache-Control", PUBLIC_CACHE);
  res.json({ listings: data || [], total: count || 0, setupRequired: false });
});

app.get("/api/listings/me", async (req, res) => {
  const auth = await authedUser(req).catch(() => null);
  if (!auth) return res.status(401).json({ error: "Missing or invalid Authorization Bearer token" });
  const { data, error } = await auth.me.from("campus_listings").select("*")
    .eq("owner_id", auth.user.id).order("updated_at", { ascending: false }).limit(100);
  if (error) {
    if (missingRelation(error)) return res.json({ listings: [], setupRequired: true });
    return res.status(500).json({ error: error.message });
  }
  res.json({ listings: data || [], setupRequired: false });
});

app.post("/api/listings", rateLimit("listingcreate", 20, 60 * 1000), async (req, res) => {
  const auth = await authedUser(req).catch(() => null);
  if (!auth) return res.status(401).json({ error: "Missing or invalid Authorization Bearer token" });
  const parsed = listingContentInput(req.body);
  if (parsed.error) return bad(res, parsed.error);
  const institution = await resolveListingInstitution(parsed.data);
  if (!institution) return bad(res, "Choose an institution from the Fidonect directory.");
  const { count, error: countError } = await auth.me.from("campus_listings")
    .select("*", { count: "exact", head: true }).eq("owner_id", auth.user.id);
  if (countError) return phase3DbError(res, countError, "Accommodation and services");
  if ((count || 0) >= 20) return res.status(429).json({ error: "You already have 20 listings. Edit an existing listing instead." });
  const row = {
    kind: parsed.data.kind,
    owner_id: auth.user.id,
    institution_id: institution.id,
    institution_name: institution.name,
    title: parsed.data.title,
    description: parsed.data.description,
    area: parsed.data.area,
    price_text: parsed.data.price_text,
    price_period: parsed.data.price_period,
    distance_text: parsed.data.distance_text,
    amenities: parsed.data.amenities,
    available_from: parsed.data.available_from,
    source: "Community",
    source_url: parsed.data.source_url,
    status: "pending",
    verified: false,
    verified_at: null,
    verified_by: null,
    admin_note: null
  };
  const { data, error } = await auth.me.from("campus_listings").insert(row).select("*").single();
  if (error) return phase3DbError(res, error, "Accommodation and services");
  res.status(201).json({ listing: data, setupRequired: false });
});

app.patch("/api/listings/:id", rateLimit("listingupdate", 30, 60 * 1000), async (req, res) => {
  const auth = await authedUser(req).catch(() => null);
  if (!auth) return res.status(401).json({ error: "Missing or invalid Authorization Bearer token" });
  const id = parsePositiveInt(req.params.id, 0);
  if (!id) return bad(res, "id must be a positive integer");
  const { data: existing, error: findError } = await auth.me.from("campus_listings").select("*")
    .eq("id", id).eq("owner_id", auth.user.id).maybeSingle();
  if (findError) return phase3DbError(res, findError, "Accommodation and services");
  if (!existing) return res.status(404).json({ error: "Listing not found" });
  const body = req.body || {};
  const merged = {
    kind: existing.kind,
    school: existing.institution_name,
    institution_id: existing.institution_id,
    title: existing.title,
    description: existing.description,
    area: existing.area,
    price_text: existing.price_text,
    price_period: existing.price_period,
    distance_text: existing.distance_text,
    amenities: existing.amenities,
    available_from: existing.available_from,
    source_url: existing.source_url,
    ...body
  };
  // If the owner edits the school name without supplying an institution ID,
  // resolve the new name instead of keeping the old institution ID.
  if (body.school !== undefined && body.institution_id === undefined) delete merged.institution_id;
  const parsed = listingContentInput(merged);
  if (parsed.error) return bad(res, parsed.error);
  const institution = await resolveListingInstitution(parsed.data);
  if (!institution) return bad(res, "Choose an institution from the Fidonect directory.");
  const patch = {
    kind: parsed.data.kind,
    institution_id: institution.id,
    institution_name: institution.name,
    title: parsed.data.title,
    description: parsed.data.description,
    area: parsed.data.area,
    price_text: parsed.data.price_text,
    price_period: parsed.data.price_period,
    distance_text: parsed.data.distance_text,
    amenities: parsed.data.amenities,
    available_from: parsed.data.available_from,
    source: "Community",
    source_url: parsed.data.source_url,
    status: "pending",
    verified: false,
    verified_at: null,
    verified_by: null,
    admin_note: null
  };
  const { data, error } = await auth.me.from("campus_listings").update(patch)
    .eq("id", id).eq("owner_id", auth.user.id).select("*").single();
  if (error) return phase3DbError(res, error, "Accommodation and services");
  res.json({ listing: data, setupRequired: false });
});

app.post("/api/listings/:id/requests", rateLimit("listingrequest", 30, 60 * 1000), async (req, res) => {
  const auth = await authedUser(req).catch(() => null);
  if (!auth) return res.status(401).json({ error: "Missing or invalid Authorization Bearer token" });
  const id = parsePositiveInt(req.params.id, 0);
  if (!id) return bad(res, "id must be a positive integer");
  const message = req.body && req.body.message;
  if (!isText(message, 1000) || message.trim().length < 10) return bad(res, "message must be 10–1000 characters");
  const { data: listing, error: findError } = await supabase.from("campus_listing_directory")
    .select("id,owner_id,title").eq("id", id).maybeSingle();
  if (findError) return phase3DbError(res, findError, "Accommodation and services");
  if (!listing) return res.status(404).json({ error: "Listing not found or not approved" });
  if (listing.owner_id === auth.user.id) return bad(res, "You cannot request contact on your own listing");
  const { data, error } = await auth.me.from("listing_requests").insert({
    listing_id: id, requester_id: auth.user.id, owner_id: listing.owner_id, message: message.trim()
  }).select().single();
  if (error) {
    if (error.code === "23505") return res.status(409).json({ error: "You already have a pending request for this listing." });
    return phase3DbError(res, error, "Listing requests");
  }
  res.json(data);
});

app.get("/api/listing-requests/mine", async (req, res) => {
  const auth = await authedUser(req).catch(() => null);
  if (!auth) return res.status(401).json({ error: "Missing or invalid Authorization Bearer token" });
  const { data, error } = await auth.me.from("listing_requests").select("*")
    .or("requester_id.eq." + auth.user.id + ",owner_id.eq." + auth.user.id)
    .order("created_at", { ascending: false }).limit(100);
  if (error) {
    if (missingRelation(error)) return res.json({ incoming: [], outgoing: [], setupRequired: true });
    return res.status(500).json({ error: error.message });
  }
  const otherIds = [...new Set((data || []).flatMap(r => [r.requester_id, r.owner_id]).filter(id => id !== auth.user.id))];
  const listingIds = [...new Set((data || []).map(r => r.listing_id))];
  let profiles = {};
  if (otherIds.length) {
    const pr = await profilesFrom(auth.me, q => q.select("id,name,photo_url,school,dept,user_type").in("id", otherIds));
    (pr.data || []).forEach(p => { profiles[p.id] = p; });
  }
  let listings = {};
  if (listingIds.length) {
    // Both sides of a request can read the public directory, even when the
    // requester cannot read the owner-only campus_listings row.
    const lr = await supabase.from("campus_listing_directory").select("id,title,kind,institution_name,owner_id").in("id", listingIds);
    (lr.data || []).forEach(l => { listings[l.id] = l; });
  }
  const shape = r => {
    const otherId = r.requester_id === auth.user.id ? r.owner_id : r.requester_id;
    return { ...r, listing: listings[r.listing_id] || null, other: profiles[otherId] || { id: otherId, name: "Student" } };
  };
  res.json({
    incoming: (data || []).filter(r => r.owner_id === auth.user.id).map(shape),
    outgoing: (data || []).filter(r => r.requester_id === auth.user.id).map(shape),
    setupRequired: false
  });
});

app.post("/api/listing-requests/:id/respond", async (req, res) => {
  const auth = await authedUser(req).catch(() => null);
  if (!auth) return res.status(401).json({ error: "Missing or invalid Authorization Bearer token" });
  const id = parsePositiveInt(req.params.id, 0);
  const action = req.body && req.body.action;
  if (!id) return bad(res, "id must be a positive integer");
  if (!["accept", "decline", "cancel", "complete"].includes(action)) {
    return bad(res, "action must be accept, decline, cancel, or complete");
  }
  const { data: row, error } = await auth.me.from("listing_requests").select("*").eq("id", id).maybeSingle();
  if (error) return phase3DbError(res, error, "Listing requests");
  if (!row) return res.status(404).json({ error: "Listing request not found" });
  let next = null;
  if (action === "accept" || action === "decline") {
    if (row.owner_id !== auth.user.id) return res.status(403).json({ error: "Only the listing owner can respond to this request" });
    if (row.status !== "pending") return res.status(409).json({ error: "This request is no longer pending" });
    next = action === "accept" ? "accepted" : "declined";
  } else if (action === "cancel") {
    if (row.requester_id !== auth.user.id) return res.status(403).json({ error: "Only the requester can cancel this request" });
    if (row.status !== "pending") return res.status(409).json({ error: "Only a pending request can be cancelled" });
    next = "cancelled";
  } else {
    if (row.requester_id !== auth.user.id && row.owner_id !== auth.user.id) return res.status(403).json({ error: "Not your request" });
    if (row.status !== "accepted") return res.status(409).json({ error: "Only an accepted request can be completed" });
    next = "completed";
  }
  const { data, error: upErr } = await auth.me.from("listing_requests")
    .update({ status: next, responded_at: new Date().toISOString() })
    .eq("id", id).eq("status", row.status).select().single();
  if (upErr) return phase3DbError(res, upErr, "Listing requests");
  res.json(data);
});

app.get("/api/admin/listings", async (req, res) => {
  const auth = await requireAdmin(req, res);
  if (!auth) return;
  const db = adminDb() || auth.me;
  const status = String(req.query.status || "");
  let query = db.from("campus_listings").select("*", { count: "exact" });
  if (["pending", "approved", "rejected", "paused"].includes(status)) query = query.eq("status", status);
  if (isText(req.query.q, 80)) {
    const q = req.query.q.trim().replace(/[%,()]/g, " ");
    query = query.or("title.ilike.%" + q + "%,institution_name.ilike.%" + q + "%,area.ilike.%" + q + "%");
  }
  const { data, error, count } = await query.order("updated_at", { ascending: false }).limit(100);
  if (error) return phase3DbError(res, error, "Accommodation and services");
  const ownerIds = [...new Set((data || []).map(l => l.owner_id))];
  const institutionIds = [...new Set((data || []).map(l => l.institution_id).filter(Boolean))];
  let profiles = {};
  let institutions = {};
  if (ownerIds.length) {
    const pr = await db.from("profiles").select("id,name,email,school,photo_url,visibility").in("id", ownerIds);
    (pr.data || []).forEach(p => { profiles[p.id] = p; });
  }
  if (institutionIds.length) {
    const ir = await supabase.from("institutions").select("id,name,location,ownership,kind").in("id", institutionIds);
    (ir.data || []).forEach(i => { institutions[i.id] = i; });
  }
  res.json({
    listings: (data || []).map(l => ({ ...l, owner: profiles[l.owner_id] || null, institution: institutions[l.institution_id] || null })),
    total: count || 0
  });
});

app.get("/api/admin/listing-requests", async (req, res) => {
  const auth = await requireAdmin(req, res);
  if (!auth) return;
  const db = adminDb() || auth.me;
  const { data, error, count } = await db.from("listing_requests").select("*", { count: "exact" })
    .order("created_at", { ascending: false }).limit(100);
  if (error) return phase3DbError(res, error, "Listing requests");
  const ids = [...new Set((data || []).flatMap(r => [r.requester_id, r.owner_id]))];
  const listingIds = [...new Set((data || []).map(r => r.listing_id))];
  let profiles = {};
  let listings = {};
  if (ids.length) {
    const pr = await db.from("profiles").select("id,name,email,school").in("id", ids);
    (pr.data || []).forEach(p => { profiles[p.id] = p; });
  }
  if (listingIds.length) {
    const lr = await db.from("campus_listings").select("id,title,kind,institution_name").in("id", listingIds);
    (lr.data || []).forEach(l => { listings[l.id] = l; });
  }
  res.json({
    requests: (data || []).map(r => ({
      ...r,
      requester: profiles[r.requester_id] || null,
      owner: profiles[r.owner_id] || null,
      listing: listings[r.listing_id] || null
    })),
    total: count || 0
  });
});

app.patch("/api/admin/listings/:id", async (req, res) => {
  const auth = await requireAdmin(req, res);
  if (!auth) return;
  const id = parsePositiveInt(req.params.id, 0);
  if (!id) return bad(res, "id must be a positive integer");
  const body = req.body || {};
  if (body.status !== undefined && !["pending", "approved", "rejected", "paused"].includes(body.status)) {
    return bad(res, "status must be pending, approved, rejected, or paused");
  }
  if (body.verified !== undefined && typeof body.verified !== "boolean") return bad(res, "verified must be true or false");
  if (body.admin_note !== undefined && (typeof body.admin_note !== "string" || body.admin_note.length > 500)) {
    return bad(res, "admin_note is invalid (max 500 chars)");
  }
  const db = adminDb() || auth.me;
  const { data: existing, error: findError } = await db.from("campus_listings").select("*").eq("id", id).single();
  if (findError) {
    if (findError.code === "PGRST116") return res.status(404).json({ error: "Listing not found" });
    return phase3DbError(res, findError, "Accommodation and services");
  }
  const nextStatus = body.status === undefined ? existing.status : body.status;
  let nextVerified = body.verified === undefined ? existing.verified : body.verified;
  if (nextStatus !== "approved") nextVerified = false;
  if (nextVerified && nextStatus !== "approved") return bad(res, "Approve the listing before verifying its source");
  const patch = { status: nextStatus, verified: nextVerified };
  if (body.admin_note !== undefined) patch.admin_note = body.admin_note.trim() || null;
  if (nextVerified) {
    patch.verified_at = existing.verified_at || new Date().toISOString();
    patch.verified_by = existing.verified_by || auth.user.id;
  } else {
    patch.verified_at = null;
    patch.verified_by = null;
  }
  const { data, error } = await db.from("campus_listings").update(patch).eq("id", id).select("*").single();
  if (error) return phase3DbError(res, error, "Accommodation and services");
  await auditAdmin(auth, "listing." + nextStatus + (nextVerified ? ".verified" : ""), String(id), {
    status: nextStatus, verified: nextVerified, title: data.title
  });
  res.json(data);
});

app.post("/api/fido/feedback", rateLimit("fidofeedback", 30, 60 * 1000), async (req, res) => {
  const auth = await authedUser(req).catch(() => null);
  const body = req.body || {};
  const question = cleanText(body.question, 500);
  if (question.length < 3) return bad(res, "question must be 3–500 characters");
  if (typeof body.helpful !== "boolean") return bad(res, "helpful must be true or false");
  if (body.correction !== undefined && (typeof body.correction !== "string" || body.correction.length > 2000)) {
    return bad(res, "correction is invalid (max 2000 chars)");
  }
  const row = {
    user_id: auth ? auth.user.id : null,
    question,
    answer_source: cleanText(body.source, 40) || null,
    school: cleanText(body.school, 160) || null,
    helpful: body.helpful,
    correction: cleanText(body.correction, 2000) || null
  };
  const client = auth ? auth.me : supabase;
  if (!client) return res.status(500).json({ error: "Supabase not configured" });
  const { error } = await client.from("fido_feedback").insert(row);
  if (error) {
    if (missingRelation(error)) return res.status(503).json({ error: "Fido feedback is not set up yet.", setupRequired: true });
    return res.status(500).json({ error: error.message });
  }
  res.json({ ok: true, setupRequired: false });
});

app.get("/api/admin/mentors", async (req, res) => {
  const auth = await requireAdmin(req, res);
  if (!auth) return;
  const db = adminDb() || auth.me;
  const status = String(req.query.status || "");
  let query = db.from("mentor_profiles").select(MENTOR_ADMIN_FIELDS, { count: "exact" });
  if (["pending", "verified", "rejected", "paused"].includes(status)) query = query.eq("status", status);
  const { data, error, count } = await query.order("updated_at", { ascending: false }).limit(100);
  if (error) return phase2DbError(res, error, "Mentorship");
  const ids = [...new Set((data || []).map(m => m.user_id))];
  let profiles = {};
  if (ids.length) {
    const pr = await db.from("profiles").select("id,name,email,school,photo_url,visibility").in("id", ids);
    (pr.data || []).forEach(p => { profiles[p.id] = p; });
  }
  res.json({ mentors: (data || []).map(m => ({ ...m, profile: profiles[m.user_id] || null })), total: count || 0 });
});

app.patch("/api/admin/mentors/:userId", async (req, res) => {
  const auth = await requireAdmin(req, res);
  if (!auth) return;
  const userId = req.params.userId;
  if (!isUuid(userId)) return bad(res, "userId must be a valid UUID");
  const status = req.body && req.body.status;
  if (!["pending", "verified", "rejected", "paused"].includes(status)) {
    return bad(res, "status must be pending, verified, rejected, or paused");
  }
  if (req.body.admin_note !== undefined && (typeof req.body.admin_note !== "string" || req.body.admin_note.length > 500)) {
    return bad(res, "admin_note is invalid (max 500 chars)");
  }
  if (req.body.listed !== undefined && typeof req.body.listed !== "boolean") return bad(res, "listed must be true or false");
  const db = adminDb() || auth.me;
  const patch = { status };
  if (req.body.admin_note !== undefined) patch.admin_note = req.body.admin_note.trim() || null;
  if (req.body.listed !== undefined) patch.listed = req.body.listed;
  if (status === "verified") { patch.verified_at = new Date().toISOString(); patch.verified_by = auth.user.id; }
  else { patch.verified_at = null; patch.verified_by = null; }
  const { data, error } = await db.from("mentor_profiles").update(patch)
    .eq("user_id", userId).select("*").single();
  if (error) {
    if (error.code === "PGRST116") return res.status(404).json({ error: "Mentor application not found" });
    return phase2DbError(res, error, "Mentorship");
  }
  await auditAdmin(auth, "mentor." + status, userId, { status, listed: data.listed });
  res.json(data);
});

app.get("/api/admin/mentor-requests", async (req, res) => {
  const auth = await requireAdmin(req, res);
  if (!auth) return;
  const db = adminDb() || auth.me;
  const { data, error, count } = await db.from("mentor_requests").select("*", { count: "exact" })
    .order("created_at", { ascending: false }).limit(100);
  if (error) return phase2DbError(res, error, "Mentorship requests");
  const ids = [...new Set((data || []).flatMap(r => [r.requester_id, r.mentor_id]))];
  let profiles = {};
  if (ids.length) {
    const pr = await db.from("profiles").select("id,name,email,school").in("id", ids);
    (pr.data || []).forEach(p => { profiles[p.id] = p; });
  }
  res.json({
    requests: (data || []).map(r => ({ ...r, requester: profiles[r.requester_id] || null, mentor: profiles[r.mentor_id] || null })),
    total: count || 0
  });
});

const HUB_ADMIN_FIELDS = "institution_id,overview,clearance,fees,accommodation,admission,registration,dates,transport,facilities,faq,official_links,source,source_url,verified,verified_at,verified_by,last_reviewed_at,updated_at";
function arrayOfItems(value, kind) {
  if (!Array.isArray(value) || value.length > 20) return { error: kind + " must be an array of up to 20 items" };
  const out = [];
  for (const item of value) {
    if (!item || typeof item !== "object") return { error: kind + " items must be objects" };
    if (kind === "faq") {
      if (!isText(item.question, 200) || item.question.trim().length < 3) return { error: "each FAQ question must be 3–200 chars" };
      if (!isText(item.answer, 2000) || item.answer.trim().length < 3) return { error: "each FAQ answer must be 3–2000 chars" };
      out.push({ question: item.question.trim(), answer: item.answer.trim() });
    } else {
      if (!isText(item.label, 80)) return { error: "each official link needs a label (max 80 chars)" };
      if (!isHttpUrl(item.url)) return { error: "each official link needs a valid http(s) URL" };
      out.push({ label: item.label.trim(), url: item.url.trim() });
    }
  }
  return { value: out };
}
function hubInput(body) {
  const src = body || {};
  const out = {};
  for (const [field, max] of Object.entries({
    overview: 5000, clearance: 5000, fees: 5000, accommodation: 5000,
    admission: 5000, registration: 5000, dates: 5000, transport: 5000, facilities: 5000
  })) {
    if (src[field] === undefined) continue;
    if (src[field] === null || src[field] === "") { out[field] = null; continue; }
    if (typeof src[field] !== "string" || src[field].length > max) return { error: field + " is invalid (max " + max + " chars)" };
    out[field] = src[field].trim();
  }
  if (src.faq !== undefined) {
    const faq = arrayOfItems(src.faq, "faq");
    if (faq.error) return faq;
    out.faq = faq.value;
  }
  if (src.official_links !== undefined) {
    const links = arrayOfItems(src.official_links, "official_links");
    if (links.error) return links;
    out.official_links = links.value;
  }
  if (src.source !== undefined) {
    if (!isText(src.source, 120) || src.source.trim().length < 2) return { error: "source must be 2–120 chars" };
    out.source = src.source.trim();
  }
  if (src.source_url !== undefined) {
    if (src.source_url === null || src.source_url === "") out.source_url = null;
    else if (!isHttpUrl(src.source_url)) return { error: "source_url must be a valid http(s) URL" };
    else out.source_url = src.source_url.trim();
  }
  if (src.verified !== undefined) {
    if (typeof src.verified !== "boolean") return { error: "verified must be true or false" };
    out.verified = src.verified;
  }
  return { data: out };
}

app.get("/api/admin/hubs", async (req, res) => {
  const auth = await requireAdmin(req, res);
  if (!auth) return;
  const db = adminDb() || auth.me;
  const { data, error, count } = await db.from("hub_pages").select(HUB_ADMIN_FIELDS, { count: "exact" })
    .order("updated_at", { ascending: false }).limit(100);
  if (error) return phase2DbError(res, error, "Institution information");
  const ids = [...new Set((data || []).map(h => h.institution_id))];
  let institutions = {};
  if (ids.length) {
    const ir = await supabase.from("institutions").select("id,name,location,ownership,kind").in("id", ids);
    (ir.data || []).forEach(i => { institutions[i.id] = i; });
  }
  res.json({ hubs: (data || []).map(h => ({ ...h, institution: institutions[h.institution_id] || null })), total: count || 0 });
});

app.get("/api/admin/hubs/:institutionId", async (req, res) => {
  const auth = await requireAdmin(req, res);
  if (!auth) return;
  const institutionId = parsePositiveInt(req.params.institutionId, 0);
  if (!institutionId) return bad(res, "institutionId must be a positive integer");
  const { data: institution, error: iErr } = await supabase.from("institutions")
    .select("id,name,location,ownership,kind").eq("id", institutionId).single();
  if (iErr || !institution) return res.status(404).json({ error: "Institution not found" });
  const db = adminDb() || auth.me;
  const { data, error } = await db.from("hub_pages").select(HUB_ADMIN_FIELDS)
    .eq("institution_id", institutionId).maybeSingle();
  if (error) return phase2DbError(res, error, "Institution information");
  res.json({ institution, hub: data || null });
});

app.put("/api/admin/hubs/:institutionId", async (req, res) => {
  const auth = await requireAdmin(req, res);
  if (!auth) return;
  const institutionId = parsePositiveInt(req.params.institutionId, 0);
  if (!institutionId) return bad(res, "institutionId must be a positive integer");
  const parsed = hubInput(req.body);
  if (parsed.error) return bad(res, parsed.error);
  const { data: institution, error: iErr } = await supabase.from("institutions")
    .select("id,name").eq("id", institutionId).single();
  if (iErr || !institution) return res.status(404).json({ error: "Institution not found" });
  const db = adminDb() || auth.me;
  const now = new Date().toISOString();
  const row = {
    institution_id: institutionId,
    source: "Community",
    faq: [],
    official_links: [],
    ...parsed.data,
    verified: parsed.data.verified === true,
    last_reviewed_at: now
  };
  if (row.verified) { row.verified_at = now; row.verified_by = auth.user.id; }
  else { row.verified_at = null; row.verified_by = null; }
  const { data, error } = await db.from("hub_pages")
    .upsert(row, { onConflict: "institution_id" }).select(HUB_ADMIN_FIELDS).single();
  if (error) return phase2DbError(res, error, "Institution information");
  treeCache.delete(institutionId);
  await auditAdmin(auth, "hub.update", String(institutionId), { verified: data.verified, source: data.source });
  res.json(data);
});

app.get("/api/admin/fido-feedback", async (req, res) => {
  const auth = await requireAdmin(req, res);
  if (!auth) return;
  const db = adminDb() || auth.me;
  const limit = parsePositiveInt(req.query.limit, 50, 100);
  const { data, error } = await db.from("fido_feedback").select("*")
    .order("created_at", { ascending: false }).limit(limit);
  if (error) return phase2DbError(res, error, "Fido feedback");
  res.json({ feedback: data || [] });
});

app.post("/api/reports", rateLimit("report", 30, 60 * 1000), async (req, res) => {
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
  // Verify the token with Supabase Auth; never trust an unverified JWT payload.
  const auth = await verifiedUser(req).catch(() => null);
  if (!auth) return res.status(401).json({ error: "Missing or invalid Authorization Bearer token" });
  const email = auth.user.email || null;
  const role = await dbAdminRole(auth);
  res.json({
    isAdmin: adminEmails().includes((email || "").toLowerCase()) || !!role,
    email,
    role: role || (adminEmails().includes((email || "").toLowerCase()) ? "env_admin" : null)
  });
});

app.get("/api/admin/stats", async (req, res) => {
  const auth = await requireAdmin(req, res);
  if (!auth) return;
  const db = adminDb() || auth.me;
  async function count(table, client) {
    try {
      const r = await (client || db).from(table).select("*", { count: "exact", head: true });
      if (r.error) return { status: "pending", detail: String(r.error.message || r.error).slice(0, 120) };
      return { status: "ok", count: r.count };
    } catch (e) { return { status: "pending", detail: String((e && e.message) || e).slice(0, 120) }; }
  }
  // Institutions are public data whose read policy covers the anon role only;
  // count them with the anon client so the admin card matches /api/status.
  const [users, posts, institutions, mentors, mentorRequests, hubs, fidoFeedback, listings, listingRequests, partners, announcements, alumni, opportunities] = await Promise.all([
    count("profiles"), count("posts"), count("institutions", supabase),
    count("mentor_profiles"), count("mentor_requests"), count("hub_pages"), count("fido_feedback"),
    count("campus_listings"), count("listing_requests"),
    count("institution_partners"), count("partner_announcements"), count("alumni_profiles"), count("recruitment_opportunities")
  ]);
  let recentUsers = [];
  if (users.status === "ok") {
    const r = await db.from("profiles").select("name,email,school,visibility,created_at").order("created_at", { ascending: false }).limit(20);
    if (!r.error) recentUsers = r.data || [];
  }
  let recentPosts = [];
  if (posts.status === "ok") {
    const r = await db.from("posts").select("author_name,school,text,created_at").order("created_at", { ascending: false }).limit(20);
    if (!r.error) recentPosts = r.data || [];
  }
  res.json({
    users, posts, institutions, mentors, mentorRequests, hubs, fidoFeedback, listings, listingRequests, partners, announcements, alumni, opportunities, recentUsers, recentPosts,
    reports: { status: "dashboard", detail: "Review reports in Supabase dashboard > Table Editor > reports." },
    generatedAt: new Date().toISOString()
  });
});

// ---- Phase 1: Scholarships (official links only; no invented awards) ----
const SCHOLARSHIP_PUBLIC_FIELDS = "id,slug,title,organisation,country,academic_level,funding_type,description,eligibility,required_documents,deadline,official_url,verified,published_at,created_at,updated_at";
const SCHOLARSHIP_ADMIN_FIELDS = SCHOLARSHIP_PUBLIC_FIELDS + ",status,created_by,verified_at,verified_by";

function scholarshipInput(body, partial) {
  const src = body || {};
  const out = {};
  const required = {
    title: [3, 200], organisation: [2, 160], country: [2, 80],
    academic_level: [2, 80], funding_type: [2, 80]
  };
  if (!partial) {
    for (const [field, [min, max]] of Object.entries(required)) {
      if (!isText(src[field], max) || src[field].trim().length < min) {
        return { error: field + " is required (text, " + min + "–" + max + " chars)" };
      }
    }
    if (!isHttpUrl(src.official_url)) return { error: "official_url must be a valid http(s) URL" };
  }
  for (const [field, [min, max]] of Object.entries(required)) {
    if (src[field] === undefined) continue;
    if (typeof src[field] !== "string" || src[field].trim().length < min || src[field].length > max) {
      return { error: field + " is invalid (text, " + min + "–" + max + " chars)" };
    }
    out[field] = src[field].trim();
  }
  for (const [field, max] of Object.entries({ description: 5000, eligibility: 5000, required_documents: 5000 })) {
    if (src[field] === undefined) continue;
    if (typeof src[field] !== "string" || src[field].length > max) return { error: field + " is invalid (text, max " + max + " chars)" };
    out[field] = src[field].trim();
  }
  if (src.official_url !== undefined) {
    if (!isHttpUrl(src.official_url)) return { error: "official_url must be a valid http(s) URL" };
    out.official_url = src.official_url.trim();
  }
  if (src.deadline !== undefined) {
    if (src.deadline === null || src.deadline === "") out.deadline = null;
    else if (!isIsoDate(src.deadline)) return { error: "deadline must be YYYY-MM-DD" };
    else out.deadline = src.deadline;
  }
  if (src.status !== undefined) {
    if (!["draft", "published", "archived"].includes(src.status)) return { error: "status must be draft, published, or archived" };
    out.status = src.status;
  }
  if (src.verified !== undefined) {
    if (typeof src.verified !== "boolean") return { error: "verified must be true or false" };
    out.verified = src.verified;
  }
  return { patch: out };
}

function scholarshipDbError(res, error) {
  if (missingRelation(error)) {
    return res.status(503).json({
      error: "Scholarships are not set up yet. Run backend/migrations/20261114_phase1_scholarships.sql in the Supabase SQL Editor.",
      setupRequired: true
    });
  }
  if (error && (error.code === "42501" || error.code === "PGRST301")) {
    return res.status(403).json({ error: "Admin content permission denied. Run the security migration and seed an admin role, or set SUPABASE_SERVICE_ROLE_KEY." });
  }
  return res.status(500).json({ error: (error && error.message) || "Database error" });
}

async function auditAdmin(auth, action, target, details) {
  const db = adminDb() || auth.me;
  try {
    await db.from("admin_audit_log").insert({
      actor_id: auth.user.id, actor_email: auth.user.email || null,
      action, target: target || null, details: details || null
    });
  } catch (e) { /* audit is best-effort until its migration is applied */ }
}

app.get("/api/scholarships", async (req, res) => {
  if (!supabase) return res.status(500).json({ error: "Supabase not configured" });
  const limit = parsePositiveInt(req.query.limit, 20, 50);
  let offset = Number(req.query.offset);
  if (!Number.isInteger(offset) || offset < 0) offset = 0;
  if (offset > 5000) offset = 5000;
  const q = cleanText(req.query.q, 80).replace(/[%,()]/g, " ").trim();
  let query = supabase.from("scholarships").select(SCHOLARSHIP_PUBLIC_FIELDS, { count: "exact" })
    .eq("status", "published");
  if (q) query = query.or("title.ilike.%" + q + "%,organisation.ilike.%" + q + "%,country.ilike.%" + q + "%");
  if (isText(req.query.country, 80)) query = query.eq("country", req.query.country.trim());
  if (isText(req.query.level, 80)) query = query.eq("academic_level", req.query.level.trim());
  if (isText(req.query.funding, 80)) query = query.eq("funding_type", req.query.funding.trim());
  if (req.query.verified === "true") query = query.eq("verified", true);
  const { data, error, count } = await query
    .order("deadline", { ascending: true, nullsFirst: false })
    .order("created_at", { ascending: false })
    .range(offset, offset + limit - 1);
  if (error) {
    if (missingRelation(error)) return res.json({ scholarships: [], total: 0, limit, offset, setupRequired: true });
    return res.status(500).json({ error: error.message });
  }
  res.setHeader("Cache-Control", PUBLIC_CACHE);
  res.json({ scholarships: data || [], total: count || 0, limit, offset, setupRequired: false });
});

app.get("/api/scholarships/bookmarks/mine", async (req, res) => {
  const auth = await authedUser(req).catch(() => null);
  if (!auth) return res.status(401).json({ error: "Missing or invalid Authorization Bearer token" });
  const { data, error } = await auth.me.from("scholarship_bookmarks")
    .select("scholarship_id,created_at,scholarships(" + SCHOLARSHIP_PUBLIC_FIELDS + ")")
    .eq("user_id", auth.user.id).order("created_at", { ascending: false });
  if (error) {
    if (missingRelation(error)) return res.json({ bookmarks: [], setupRequired: true });
    return res.status(500).json({ error: error.message });
  }
  res.json({ bookmarks: data || [], setupRequired: false });
});

app.post("/api/scholarships/:id/bookmark", async (req, res) => {
  const auth = await authedUser(req).catch(() => null);
  if (!auth) return res.status(401).json({ error: "Missing or invalid Authorization Bearer token" });
  const id = parsePositiveInt(req.params.id, 0);
  if (!id) return bad(res, "id must be a positive integer");
  const { error } = await auth.me.from("scholarship_bookmarks").insert({ user_id: auth.user.id, scholarship_id: id });
  if (error) {
    if (error.code === "23505") return res.json({ ok: true, bookmarked: true });
    return scholarshipDbError(res, error);
  }
  res.json({ ok: true, bookmarked: true });
});

app.delete("/api/scholarships/:id/bookmark", async (req, res) => {
  const auth = await authedUser(req).catch(() => null);
  if (!auth) return res.status(401).json({ error: "Missing or invalid Authorization Bearer token" });
  const id = parsePositiveInt(req.params.id, 0);
  if (!id) return bad(res, "id must be a positive integer");
  const { error } = await auth.me.from("scholarship_bookmarks")
    .delete().eq("user_id", auth.user.id).eq("scholarship_id", id);
  if (error) return scholarshipDbError(res, error);
  res.json({ ok: true, bookmarked: false });
});

app.get("/api/scholarships/:idOrSlug", async (req, res) => {
  if (!supabase) return res.status(500).json({ error: "Supabase not configured" });
  const key = String(req.params.idOrSlug || "");
  let query = supabase.from("scholarships").select(SCHOLARSHIP_PUBLIC_FIELDS).eq("status", "published");
  query = /^\d+$/.test(key) ? query.eq("id", Number(key)) : query.eq("slug", key);
  const { data, error } = await query.single();
  if (error) {
    if (missingRelation(error)) return res.status(503).json({ error: "Scholarships are not set up yet.", setupRequired: true });
    if (error.code === "PGRST116") return res.status(404).json({ error: "Scholarship not found" });
    return res.status(500).json({ error: error.message });
  }
  res.setHeader("Cache-Control", PUBLIC_CACHE);
  res.json(data);
});

app.get("/api/admin/scholarships", async (req, res) => {
  const auth = await requireAdmin(req, res);
  if (!auth) return;
  const db = adminDb() || auth.me;
  const status = String(req.query.status || "");
  let query = db.from("scholarships").select(SCHOLARSHIP_ADMIN_FIELDS, { count: "exact" });
  if (["draft", "published", "archived"].includes(status)) query = query.eq("status", status);
  if (isText(req.query.q, 80)) {
    const q = req.query.q.trim().replace(/[%,()]/g, " ");
    query = query.or("title.ilike.%" + q + "%,organisation.ilike.%" + q + "%");
  }
  const { data, error, count } = await query.order("updated_at", { ascending: false }).limit(100);
  if (error) return scholarshipDbError(res, error);
  res.json({ scholarships: data || [], total: count || 0 });
});

app.post("/api/admin/scholarships", async (req, res) => {
  const auth = await requireAdmin(req, res);
  if (!auth) return;
  const parsed = scholarshipInput(req.body, false);
  if (parsed.error) return bad(res, parsed.error);
  const db = adminDb() || auth.me;
  const now = new Date().toISOString();
  const row = {
    ...parsed.patch,
    slug: uniqueSlug(parsed.patch.title),
    status: parsed.patch.status || "draft",
    verified: parsed.patch.verified === true,
    created_by: auth.user.id
  };
  if (row.status === "published") row.published_at = now;
  if (row.verified) { row.verified_at = now; row.verified_by = auth.user.id; }
  const { data, error } = await db.from("scholarships").insert(row).select(SCHOLARSHIP_ADMIN_FIELDS).single();
  if (error) return scholarshipDbError(res, error);
  await auditAdmin(auth, "scholarship.create", String(data.id), { title: data.title, status: data.status });
  res.status(201).json(data);
});

app.patch("/api/admin/scholarships/:id", async (req, res) => {
  const auth = await requireAdmin(req, res);
  if (!auth) return;
  const id = parsePositiveInt(req.params.id, 0);
  if (!id) return bad(res, "id must be a positive integer");
  const parsed = scholarshipInput(req.body, true);
  if (parsed.error) return bad(res, parsed.error);
  if (!Object.keys(parsed.patch).length) return bad(res, "nothing to update");
  const db = adminDb() || auth.me;
  const { data: existing, error: findError } = await db.from("scholarships")
    .select("id,status,published_at,verified").eq("id", id).single();
  if (findError) {
    if (findError.code === "PGRST116") return res.status(404).json({ error: "Scholarship not found" });
    return scholarshipDbError(res, findError);
  }
  const patch = { ...parsed.patch };
  const now = new Date().toISOString();
  if (patch.status === "published" && !existing.published_at) patch.published_at = now;
  if (patch.verified === true && !existing.verified) { patch.verified_at = now; patch.verified_by = auth.user.id; }
  if (patch.verified === false && existing.verified) { patch.verified_at = null; patch.verified_by = null; }
  const { data, error } = await db.from("scholarships").update(patch).eq("id", id).select(SCHOLARSHIP_ADMIN_FIELDS).single();
  if (error) return scholarshipDbError(res, error);
  await auditAdmin(auth, "scholarship.update", String(id), patch);
  res.json(data);
});

app.delete("/api/admin/scholarships/:id", async (req, res) => {
  const auth = await requireAdmin(req, res);
  if (!auth) return;
  const id = parsePositiveInt(req.params.id, 0);
  if (!id) return bad(res, "id must be a positive integer");
  const db = adminDb() || auth.me;
  const { data, error } = await db.from("scholarships").update({ status: "archived" })
    .eq("id", id).select(SCHOLARSHIP_ADMIN_FIELDS).single();
  if (error) {
    if (error.code === "PGRST116") return res.status(404).json({ error: "Scholarship not found" });
    return scholarshipDbError(res, error);
  }
  await auditAdmin(auth, "scholarship.archive", String(id), { title: data.title });
  res.json(data);
});

// ---- Phase 4A: institution partners, alumni, recruitment ----
function phase4DbError(res, error, label) {
  if (missingRelation(error)) {
    return res.status(503).json({
      error: (label || "Phase 4 content") + " is not set up yet. Run backend/migrations/20261120_phase4_partnerships_alumni_recruitment.sql in the Supabase SQL Editor.",
      setupRequired: true
    });
  }
  if (error && (error.code === "42501" || error.code === "PGRST301")) {
    return res.status(403).json({ error: "Permission denied. Sign in with the required account or run the Phase 4 migration." });
  }
  return res.status(500).json({ error: (error && error.message) || "Database error" });
}

async function requireSuperAdmin(req, res) {
  const auth = await requireAdmin(req, res);
  if (!auth) return null;
  if (adminEmails().includes((auth.user.email || "").toLowerCase())) return auth;
  const role = await dbAdminRole(auth);
  if (role !== "super_admin") {
    res.status(403).json({ error: "Super admin only" });
    return null;
  }
  return auth;
}

// Content review (announcements, alumni, opportunities) is limited to
// super admins and content admins. Moderators can read review surfaces but
// cannot approve content. This mirrors the Phase 4 database policies.
async function requireContentAdmin(req, res) {
  const auth = await requireAdmin(req, res);
  if (!auth) return null;
  if (adminEmails().includes((auth.user.email || "").toLowerCase())) return auth;
  const role = await dbAdminRole(auth);
  if (role !== "super_admin" && role !== "content_admin") {
    res.status(403).json({ error: "Content admin only" });
    return null;
  }
  return auth;
}

const PARTNER_PUBLIC_FIELDS = "institution_id,institution_name,location,ownership,kind,public_summary,official_url,verified_at,updated_at";
const ANNOUNCEMENT_PUBLIC_FIELDS = "id,institution_id,institution_name,title,body,category,link_url,published_at,expires_at,updated_at,partner_verified_at";
const ALUMNI_PUBLIC_FIELDS = "user_id,name,photo_url,user_type,institution_id,institution_name,graduation_year,faculty,department,programme,job_title,current_organisation,industry,location,bio,help_areas,open_to_mentoring,open_to_referrals,verified_at,updated_at,institution_location,ownership,kind";
const ALUMNI_OWN_FIELDS = "user_id,institution_id,institution_name,graduation_year,faculty,department,programme,job_title,current_organisation,industry,location,bio,help_areas,open_to_mentoring,open_to_referrals,verification_method,verification_detail,listed,status,verified_at,created_at,updated_at";
const OPPORTUNITY_PUBLIC_FIELDS = "id,institution_id,institution_name,title,organisation,description,location,work_mode,role_type,eligibility,deadline,application_url,published_at,updated_at,partner_verified_at";

const PARTNER_STATUSES = ["pending", "verified", "rejected", "paused"];
const ANNOUNCEMENT_CATEGORIES = ["general", "admission", "registration", "event", "deadline", "opportunity"];
const ANNOUNCEMENT_STATUSES = ["pending", "approved", "rejected", "paused"];
const ALUMNI_METHODS = ["institutional_email", "alumni_id", "other"];
const ALUMNI_STATUSES = ["pending", "verified", "rejected", "paused"];
const OPPORTUNITY_TYPES = ["internship", "graduate", "job", "volunteer"];
const OPPORTUNITY_MODES = ["onsite", "hybrid", "remote"];
const OPPORTUNITY_STATUSES = ["pending", "approved", "rejected", "closed"];

function isUuid(value) {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function p4Text(src, field, min, max, required) {
  if (src[field] === undefined) {
    if (required) return { error: field + " is required" };
    return { present: false };
  }
  if (src[field] === null || src[field] === "") {
    if (required) return { error: field + " is required" };
    return { present: true, value: null };
  }
  if (typeof src[field] !== "string" || src[field].trim().length < min || src[field].length > max) {
    return { error: field + " must be " + min + "–" + max + " characters" };
  }
  return { present: true, value: src[field].trim() };
}

function p4Array(src, field, maxItems, required) {
  if (src[field] === undefined) {
    if (required) return { error: field + " is required" };
    return { present: false };
  }
  let items = src[field];
  if (typeof items === "string") items = items.split(",");
  if (!Array.isArray(items)) return { error: field + " must be an array of up to " + maxItems + " short items" };
  items = [...new Set(items.map(item => typeof item === "string" ? item.trim() : "").filter(Boolean))];
  if (required && !items.length) return { error: field + " must contain at least 1 item" };
  if (items.length > maxItems) return { error: field + " must contain at most " + maxItems + " items" };
  if (items.some(item => item.length < 2 || item.length > 80)) return { error: "each " + field + " item must be 2–80 characters" };
  return { present: true, value: items };
}

function p4Bool(src, field) {
  if (src[field] === undefined) return { present: false };
  if (typeof src[field] !== "boolean") return { error: field + " must be true or false" };
  return { present: true, value: src[field] };
}

function p4Year(src, field, required) {
  if (src[field] === undefined) {
    if (required) return { error: field + " is required" };
    return { present: false };
  }
  if (src[field] === null || src[field] === "") {
    if (required) return { error: field + " is required" };
    return { present: true, value: null };
  }
  const n = Number(src[field]);
  if (!Number.isInteger(n) || n < 1950 || n > 2100) return { error: field + " must be a year between 1950 and 2100" };
  return { present: true, value: n };
}

function p4Date(src, field) {
  if (src[field] === undefined) return { present: false };
  if (src[field] === null || src[field] === "") return { present: true, value: null };
  if (!isIsoDate(src[field])) return { error: field + " must be YYYY-MM-DD" };
  return { present: true, value: src[field] };
}

function p4DateTime(src, field) {
  if (src[field] === undefined) return { present: false };
  if (src[field] === null || src[field] === "") return { present: true, value: null };
  if (isIsoDate(src[field])) return { present: true, value: new Date(src[field] + "T23:59:59.999Z").toISOString() };
  const date = new Date(src[field]);
  if (Number.isNaN(date.getTime())) return { error: field + " must be a valid date" };
  return { present: true, value: date.toISOString() };
}

function p4AnnouncementInput(body, partial) {
  const src = body || {};
  const out = {};
  const title = p4Text(src, "title", 3, 160, !partial);
  if (title.error) return title;
  if (title.present) out.title = title.value;
  const text = p4Text(src, "body", 20, 4000, !partial);
  if (text.error) return text;
  if (text.present) out.body = text.value;
  if (src.category !== undefined) {
    if (!ANNOUNCEMENT_CATEGORIES.includes(src.category)) return { error: "category must be " + ANNOUNCEMENT_CATEGORIES.join(", ") };
    out.category = src.category;
  }
  const link = p4Text(src, "link_url", 0, 2048, false);
  if (link.error) return link;
  if (link.present) {
    if (link.value !== null && !isHttpUrl(link.value)) return { error: "link_url must be a valid http(s) URL" };
    out.link_url = link.value;
  }
  const expires = p4DateTime(src, "expires_at");
  if (expires.error) return expires;
  if (expires.present) out.expires_at = expires.value;
  return { data: out };
}

function p4AlumniInput(body, partial) {
  const src = body || {};
  const out = {};
  const schoolValue = src.school !== undefined ? src.school : src.institution_name;
  const school = p4Text({ school: schoolValue }, "school", 2, 160, !partial);
  if (school.error) return school;
  if (school.present) out.school = school.value;
  if (src.institution_id !== undefined) {
    if (src.institution_id === null || src.institution_id === "") out.institution_id = null;
    else {
      const id = parsePositiveInt(src.institution_id, 0);
      if (!id) return { error: "institution_id must be a positive integer" };
      out.institution_id = id;
    }
  }
  const year = p4Year(src, "graduation_year", !partial);
  if (year.error) return year;
  if (year.present) out.graduation_year = year.value;
  for (const [field, max] of Object.entries({ faculty: 160, department: 160, programme: 160, job_title: 160, current_organisation: 160, industry: 120, location: 120 })) {
    const value = p4Text(src, field, 0, max, false);
    if (value.error) return value;
    if (value.present) out[field] = value.value;
  }
  const bio = p4Text(src, "bio", 20, 2000, !partial);
  if (bio.error) return bio;
  if (bio.present) out.bio = bio.value;
  const areas = p4Array(src, "help_areas", 8, false);
  if (areas.error) return areas;
  if (areas.present) out.help_areas = areas.value;
  for (const field of ["open_to_mentoring", "open_to_referrals", "listed"]) {
    const value = p4Bool(src, field);
    if (value.error) return value;
    if (value.present) out[field] = value.value;
  }
  if (src.verification_method !== undefined || !partial) {
    if (!ALUMNI_METHODS.includes(src.verification_method)) return { error: "verification_method must be institutional_email, alumni_id, or other" };
    out.verification_method = src.verification_method;
  }
  const detail = p4Text(src, "verification_detail", 0, 300, false);
  if (detail.error) return detail;
  if (detail.present) out.verification_detail = detail.value;
  return { data: out };
}

function p4OpportunityInput(body, partial) {
  const src = body || {};
  const out = {};
  for (const [field, min, max] of [["title", 3, 160], ["organisation", 2, 160], ["description", 20, 5000]]) {
    const value = p4Text(src, field, min, max, !partial);
    if (value.error) return value;
    if (value.present) out[field] = value.value;
  }
  for (const [field, max] of Object.entries({ location: 160, eligibility: 2000 })) {
    const value = p4Text(src, field, 0, max, false);
    if (value.error) return value;
    if (value.present) out[field] = value.value;
  }
  if (src.work_mode !== undefined || !partial) {
    const mode = src.work_mode || "onsite";
    if (!OPPORTUNITY_MODES.includes(mode)) return { error: "work_mode must be onsite, hybrid, or remote" };
    out.work_mode = mode;
  }
  if (src.role_type !== undefined || !partial) {
    if (!OPPORTUNITY_TYPES.includes(src.role_type)) return { error: "role_type must be internship, graduate, job, or volunteer" };
    out.role_type = src.role_type;
  }
  if (src.application_url !== undefined || !partial) {
    if (!isHttpUrl(src.application_url)) return { error: "application_url must be a valid http(s) URL" };
    out.application_url = src.application_url.trim();
  }
  const source = p4Text(src, "source_url", 0, 2048, false);
  if (source.error) return source;
  if (source.present) {
    if (source.value !== null && !isHttpUrl(source.value)) return { error: "source_url must be a valid http(s) URL" };
    out.source_url = source.value;
  }
  const deadline = p4Date(src, "deadline");
  if (deadline.error) return deadline;
  if (deadline.present) out.deadline = deadline.value;
  return { data: out };
}

function p4PartnerAdminInput(body) {
  const src = body || {};
  const out = {};
  const summary = p4Text(src, "public_summary", 20, 1200, false);
  if (summary.error) return summary;
  if (summary.present) out.public_summary = summary.value;
  const url = p4Text(src, "official_url", 0, 2048, false);
  if (url.error) return url;
  if (url.present) {
    if (url.value !== null && !isHttpUrl(url.value)) return { error: "official_url must be a valid http(s) URL" };
    out.official_url = url.value;
  }
  if (src.verification_method !== undefined) {
    if (!["official_email", "official_letter", "official_website", "other"].includes(src.verification_method)) {
      return { error: "verification_method must be official_email, official_letter, official_website, or other" };
    }
    out.verification_method = src.verification_method;
  }
  for (const [field, max] of Object.entries({ verification_detail: 1000, admin_note: 500 })) {
    const value = p4Text(src, field, 0, max, false);
    if (value.error) return value;
    if (value.present) out[field] = value.value;
  }
  const listed = p4Bool(src, "listed");
  if (listed.error) return listed;
  if (listed.present) out.listed = listed.value;
  if (src.status !== undefined) {
    if (!PARTNER_STATUSES.includes(src.status)) return { error: "status must be pending, verified, rejected, or paused" };
    out.status = src.status;
  }
  return { data: out };
}

function p4AnnouncementAdminPatch(body) {
  const base = p4AnnouncementInput(body, true);
  if (base.error) return base;
  const out = base.data;
  if (body && body.status !== undefined) {
    if (!ANNOUNCEMENT_STATUSES.includes(body.status)) return { error: "status must be pending, approved, rejected, or paused" };
    out.status = body.status;
  }
  const note = p4Text(body || {}, "admin_note", 0, 500, false);
  if (note.error) return note;
  if (note.present) out.admin_note = note.value;
  return { data: out };
}

function p4OpportunityAdminPatch(body) {
  const base = p4OpportunityInput(body, true);
  if (base.error) return base;
  const out = base.data;
  if (body && body.status !== undefined) {
    if (!OPPORTUNITY_STATUSES.includes(body.status)) return { error: "status must be pending, approved, rejected, or closed" };
    out.status = body.status;
  }
  const note = p4Text(body || {}, "admin_note", 0, 500, false);
  if (note.error) return note;
  if (note.present) out.admin_note = note.value;
  return { data: out };
}

function p4AlumniAdminPatch(body) {
  const base = p4AlumniInput(body, true);
  if (base.error) return base;
  const out = base.data;
  if (body && body.status !== undefined) {
    if (!ALUMNI_STATUSES.includes(body.status)) return { error: "status must be pending, verified, rejected, or paused" };
    out.status = body.status;
  }
  const note = p4Text(body || {}, "admin_note", 0, 500, false);
  if (note.error) return note;
  if (note.present) out.admin_note = note.value;
  return { data: out };
}

async function p4PartnerContext(auth) {
  const memberships = await auth.me.from("institution_partner_members")
    .select("*").eq("user_id", auth.user.id).eq("status", "active")
    .order("created_at", { ascending: true });
  if (memberships.error) return { dbError: memberships.error };
  const ids = [...new Set((memberships.data || []).map(m => m.institution_id))];
  let partners = [];
  if (ids.length) {
    const rows = await auth.me.from("institution_partners").select("*").in("institution_id", ids);
    if (rows.error) return { dbError: rows.error };
    partners = rows.data || [];
  }
  return { memberships: memberships.data || [], partners };
}

async function p4PartnerAccess(auth, institutionId) {
  const membership = await auth.me.from("institution_partner_members")
    .select("*").eq("institution_id", institutionId).eq("user_id", auth.user.id)
    .eq("status", "active").maybeSingle();
  if (membership.error) return { dbError: membership.error };
  if (!membership.data) return { status: 403, error: "Active partner access is required" };
  const partner = await auth.me.from("institution_partners")
    .select("*").eq("institution_id", institutionId).maybeSingle();
  if (partner.error) return { dbError: partner.error };
  if (!partner.data || partner.data.status !== "verified") {
    return { status: 403, error: "This partner is not verified yet" };
  }
  return { membership: membership.data, partner: partner.data };
}

// ---- Phase 4A public reads (filtered views only) ----
app.get("/api/partners", async (req, res) => {
  if (!supabase) return res.status(500).json({ error: "Supabase not configured" });
  const limit = parsePositiveInt(req.query.limit, 50, 100);
  let offset = Number(req.query.offset);
  if (!Number.isInteger(offset) || offset < 0) offset = 0;
  if (offset > 5000) offset = 5000;
  const q = cleanText(req.query.q, 80).replace(/[%,()]/g, " ").trim();
  let query = supabase.from("institution_partner_directory").select(PARTNER_PUBLIC_FIELDS, { count: "exact" });
  if (q) query = query.or("institution_name.ilike.%" + q + "%,public_summary.ilike.%" + q + "%,location.ilike.%" + q + "%");
  const { data, error, count } = await query
    .order("verified_at", { ascending: false })
    .range(offset, offset + limit - 1);
  if (error) {
    if (missingRelation(error)) return res.json({ partners: [], total: 0, limit, offset, setupRequired: true });
    return res.status(500).json({ error: error.message });
  }
  res.setHeader("Cache-Control", PUBLIC_CACHE);
  res.json({ partners: data || [], total: count || 0, limit, offset, setupRequired: false });
});

app.get("/api/partners/:institutionId", async (req, res) => {
  if (!supabase) return res.status(500).json({ error: "Supabase not configured" });
  const institutionId = parsePositiveInt(req.params.institutionId, 0);
  if (!institutionId) return bad(res, "institutionId must be a positive integer");
  const { data, error } = await supabase.from("institution_partner_directory")
    .select(PARTNER_PUBLIC_FIELDS).eq("institution_id", institutionId).maybeSingle();
  if (error) {
    if (missingRelation(error)) return res.status(503).json({ error: "Partners are not set up yet.", setupRequired: true });
    return res.status(500).json({ error: error.message });
  }
  if (!data) return res.status(404).json({ error: "Verified partner not found" });
  const announcements = await supabase.from("partner_announcement_directory")
    .select(ANNOUNCEMENT_PUBLIC_FIELDS).eq("institution_id", institutionId)
    .order("published_at", { ascending: false }).limit(20);
  if (announcements.error && !missingRelation(announcements.error)) {
    return res.status(500).json({ error: announcements.error.message });
  }
  res.setHeader("Cache-Control", PUBLIC_CACHE);
  res.json({ partner: data, announcements: announcements.data || [], setupRequired: false });
});

app.get("/api/partner-announcements", async (req, res) => {
  if (!supabase) return res.status(500).json({ error: "Supabase not configured" });
  const limit = parsePositiveInt(req.query.limit, 50, 100);
  let offset = Number(req.query.offset);
  if (!Number.isInteger(offset) || offset < 0) offset = 0;
  if (offset > 5000) offset = 5000;
  const institutionId = req.query.institution_id === undefined ? null : parsePositiveInt(req.query.institution_id, 0);
  if (req.query.institution_id !== undefined && !institutionId) return bad(res, "institution_id must be a positive integer");
  const category = String(req.query.category || "");
  if (category && !ANNOUNCEMENT_CATEGORIES.includes(category)) return bad(res, "category is invalid");
  const q = cleanText(req.query.q, 80).replace(/[%,()]/g, " ").trim();
  let query = supabase.from("partner_announcement_directory").select(ANNOUNCEMENT_PUBLIC_FIELDS, { count: "exact" });
  if (institutionId) query = query.eq("institution_id", institutionId);
  if (category) query = query.eq("category", category);
  if (q) query = query.or("title.ilike.%" + q + "%,body.ilike.%" + q + "%,institution_name.ilike.%" + q + "%");
  const { data, error, count } = await query
    .order("published_at", { ascending: false })
    .range(offset, offset + limit - 1);
  if (error) {
    if (missingRelation(error)) return res.json({ announcements: [], total: 0, limit, offset, setupRequired: true });
    return res.status(500).json({ error: error.message });
  }
  res.setHeader("Cache-Control", PUBLIC_CACHE);
  res.json({ announcements: data || [], total: count || 0, limit, offset, setupRequired: false });
});

app.get("/api/alumni", async (req, res) => {
  if (!supabase) return res.status(500).json({ error: "Supabase not configured" });
  const limit = parsePositiveInt(req.query.limit, 50, 100);
  let offset = Number(req.query.offset);
  if (!Number.isInteger(offset) || offset < 0) offset = 0;
  if (offset > 5000) offset = 5000;
  const institutionId = req.query.institution_id === undefined ? null : parsePositiveInt(req.query.institution_id, 0);
  if (req.query.institution_id !== undefined && !institutionId) return bad(res, "institution_id must be a positive integer");
  let graduationYear = null;
  if (req.query.graduation_year !== undefined && req.query.graduation_year !== "") {
    graduationYear = Number(req.query.graduation_year);
    if (!Number.isInteger(graduationYear) || graduationYear < 1950 || graduationYear > 2100) {
      return bad(res, "graduation_year must be a year between 1950 and 2100");
    }
  }
  const industry = cleanText(req.query.industry, 120);
  const institutionName = cleanText(req.query.institution, 160);
  const q = cleanText(req.query.q, 80).replace(/[%,()]/g, " ").trim();
  let query = supabase.from("alumni_directory").select(ALUMNI_PUBLIC_FIELDS, { count: "exact" });
  if (institutionId) query = query.eq("institution_id", institutionId);
  if (institutionName) query = query.ilike("institution_name", "%" + institutionName + "%");
  if (graduationYear) query = query.eq("graduation_year", graduationYear);
  if (industry) query = query.ilike("industry", "%" + industry + "%");
  if (req.query.open_to_mentoring === "true") query = query.eq("open_to_mentoring", true);
  if (req.query.open_to_referrals === "true") query = query.eq("open_to_referrals", true);
  if (q) query = query.or("name.ilike.%" + q + "%,institution_name.ilike.%" + q + "%,job_title.ilike.%" + q + "%,current_organisation.ilike.%" + q + "%,industry.ilike.%" + q + "%,bio.ilike.%" + q + "%");
  const { data, error, count } = await query
    .order("verified_at", { ascending: false })
    .order("graduation_year", { ascending: false })
    .range(offset, offset + limit - 1);
  if (error) {
    if (missingRelation(error)) return res.json({ alumni: [], total: 0, limit, offset, setupRequired: true });
    return res.status(500).json({ error: error.message });
  }
  res.setHeader("Cache-Control", PUBLIC_CACHE);
  res.json({ alumni: data || [], total: count || 0, limit, offset, setupRequired: false });
});

app.get("/api/opportunities", async (req, res) => {
  if (!supabase) return res.status(500).json({ error: "Supabase not configured" });
  const limit = parsePositiveInt(req.query.limit, 50, 100);
  let offset = Number(req.query.offset);
  if (!Number.isInteger(offset) || offset < 0) offset = 0;
  if (offset > 5000) offset = 5000;
  const institutionId = req.query.institution_id === undefined ? null : parsePositiveInt(req.query.institution_id, 0);
  if (req.query.institution_id !== undefined && !institutionId) return bad(res, "institution_id must be a positive integer");
  const roleType = String(req.query.role_type || "");
  if (roleType && !OPPORTUNITY_TYPES.includes(roleType)) return bad(res, "role_type is invalid");
  const workMode = String(req.query.work_mode || "");
  if (workMode && !OPPORTUNITY_MODES.includes(workMode)) return bad(res, "work_mode is invalid");
  const q = cleanText(req.query.q, 80).replace(/[%,()]/g, " ").trim();
  let query = supabase.from("recruitment_opportunity_directory").select(OPPORTUNITY_PUBLIC_FIELDS, { count: "exact" });
  if (institutionId) query = query.eq("institution_id", institutionId);
  if (roleType) query = query.eq("role_type", roleType);
  if (workMode) query = query.eq("work_mode", workMode);
  if (q) query = query.or("title.ilike.%" + q + "%,organisation.ilike.%" + q + "%,institution_name.ilike.%" + q + "%,description.ilike.%" + q + "%");
  const { data, error, count } = await query
    .order("published_at", { ascending: false })
    .range(offset, offset + limit - 1);
  if (error) {
    if (missingRelation(error)) return res.json({ opportunities: [], total: 0, limit, offset, setupRequired: true });
    return res.status(500).json({ error: error.message });
  }
  res.setHeader("Cache-Control", PUBLIC_CACHE);
  res.json({ opportunities: data || [], total: count || 0, limit, offset, setupRequired: false });
});

// ---- Phase 4A signed-in alumni application ----
app.get("/api/alumni/me", async (req, res) => {
  const auth = await authedUser(req).catch(() => null);
  if (!auth) return res.status(401).json({ error: "Missing or invalid Authorization Bearer token" });
  const { data, error } = await auth.me.from("alumni_profiles").select(ALUMNI_OWN_FIELDS)
    .eq("user_id", auth.user.id).maybeSingle();
  if (error) {
    if (missingRelation(error)) return res.json({ alumni: null, setupRequired: true });
    return phase4DbError(res, error, "Alumni");
  }
  res.json({ alumni: data || null, setupRequired: false });
});

app.post("/api/alumni/apply", rateLimit("alumniapply", 20, 60 * 1000), async (req, res) => {
  const auth = await authedUser(req).catch(() => null);
  if (!auth) return res.status(401).json({ error: "Missing or invalid Authorization Bearer token" });
  const body = { ...(req.body || {}) };
  if (body.institution_id !== undefined && body.institution_id !== null && body.institution_id !== "") {
    if (!parsePositiveInt(body.institution_id, 0)) return bad(res, "institution_id must be a positive integer");
  }
  if (!body.school && body.institution_id) {
    const institution = await resolveListingInstitution({ institution_id: parsePositiveInt(body.institution_id, 0) });
    if (!institution) return bad(res, "Choose an institution from the Fidonect directory.");
    body.school = institution.name;
  }
  const parsed = p4AlumniInput(body, false);
  if (parsed.error) return bad(res, parsed.error);
  const institution = await resolveListingInstitution(parsed.data);
  if (!institution) return bad(res, "Choose an institution from the Fidonect directory.");
  const row = {
    user_id: auth.user.id,
    institution_id: institution.id,
    institution_name: institution.name,
    graduation_year: parsed.data.graduation_year,
    faculty: parsed.data.faculty || null,
    department: parsed.data.department || null,
    programme: parsed.data.programme || null,
    job_title: parsed.data.job_title || null,
    current_organisation: parsed.data.current_organisation || null,
    industry: parsed.data.industry || null,
    location: parsed.data.location || null,
    bio: parsed.data.bio,
    help_areas: parsed.data.help_areas || [],
    open_to_mentoring: parsed.data.open_to_mentoring === true,
    open_to_referrals: parsed.data.open_to_referrals === true,
    verification_method: parsed.data.verification_method,
    verification_detail: parsed.data.verification_detail || null,
    listed: parsed.data.listed === true,
    status: "pending",
    verified_at: null,
    verified_by: null,
    admin_note: null
  };
  const { data, error } = await auth.me.from("alumni_profiles")
    .upsert(row, { onConflict: "user_id" }).select(ALUMNI_OWN_FIELDS).single();
  if (error) return phase4DbError(res, error, "Alumni");
  res.json({ alumni: data, setupRequired: false });
});

// ---- Phase 4A partner tools (own institution only) ----
const PARTNER_OWN_ANNOUNCEMENT_FIELDS = "id,institution_id,author_id,title,body,category,link_url,expires_at,status,published_at,reviewed_at,created_at,updated_at";
const PARTNER_OWN_OPPORTUNITY_FIELDS = "id,institution_id,posted_by,title,organisation,description,location,work_mode,role_type,eligibility,deadline,application_url,source_url,status,published_at,reviewed_at,created_at,updated_at";

app.get("/api/partner/me", async (req, res) => {
  const auth = await authedUser(req).catch(() => null);
  if (!auth) return res.status(401).json({ error: "Missing or invalid Authorization Bearer token" });
  const context = await p4PartnerContext(auth);
  if (context.dbError) {
    if (missingRelation(context.dbError)) return res.json({ memberships: [], setupRequired: true });
    return phase4DbError(res, context.dbError, "Partner tools");
  }
  const ids = context.memberships.map(m => m.institution_id);
  let institutions = {};
  if (ids.length) {
    const ir = await supabase.from("institutions").select("id,name,location,ownership,kind").in("id", ids);
    (ir.data || []).forEach(i => { institutions[i.id] = i; });
  }
  const partners = {};
  context.partners.forEach(p => {
    const safe = { ...p };
    delete safe.admin_note;
    delete safe.verification_detail;
    partners[p.institution_id] = safe;
  });
  res.json({
    memberships: context.memberships.map(m => ({
      ...m,
      partner: partners[m.institution_id] || null,
      institution: institutions[m.institution_id] || null
    })),
    setupRequired: false
  });
});

app.get("/api/partner/announcements", async (req, res) => {
  const auth = await authedUser(req).catch(() => null);
  if (!auth) return res.status(401).json({ error: "Missing or invalid Authorization Bearer token" });
  const context = await p4PartnerContext(auth);
  if (context.dbError) {
    if (missingRelation(context.dbError)) return res.json({ announcements: [], setupRequired: true });
    return phase4DbError(res, context.dbError, "Partner announcements");
  }
  const ids = context.memberships.map(m => m.institution_id);
  if (!ids.length) return res.json({ announcements: [], setupRequired: false });
  const { data, error } = await auth.me.from("partner_announcements")
    .select(PARTNER_OWN_ANNOUNCEMENT_FIELDS).in("institution_id", ids)
    .order("updated_at", { ascending: false }).limit(100);
  if (error) return phase4DbError(res, error, "Partner announcements");
  res.json({ announcements: data || [], setupRequired: false });
});

app.post("/api/partner/announcements", rateLimit("partnerannouncement", 20, 60 * 1000), async (req, res) => {
  const auth = await authedUser(req).catch(() => null);
  if (!auth) return res.status(401).json({ error: "Missing or invalid Authorization Bearer token" });
  const institutionId = parsePositiveInt(req.body && req.body.institution_id, 0);
  if (!institutionId) return bad(res, "institution_id must be a positive integer");
  const access = await p4PartnerAccess(auth, institutionId);
  if (access.dbError) return phase4DbError(res, access.dbError, "Partner announcements");
  if (access.error) return res.status(access.status || 403).json({ error: access.error });
  const parsed = p4AnnouncementInput(req.body, false);
  if (parsed.error) return bad(res, parsed.error);
  const row = {
    institution_id: institutionId,
    author_id: auth.user.id,
    title: parsed.data.title,
    body: parsed.data.body,
    category: parsed.data.category || "general",
    link_url: parsed.data.link_url || null,
    expires_at: parsed.data.expires_at || null,
    status: "pending",
    admin_note: null,
    published_at: null,
    reviewed_at: null,
    reviewed_by: null
  };
  const { data, error } = await auth.me.from("partner_announcements")
    .insert(row).select(PARTNER_OWN_ANNOUNCEMENT_FIELDS).single();
  if (error) return phase4DbError(res, error, "Partner announcements");
  res.status(201).json({ announcement: data, setupRequired: false });
});

app.patch("/api/partner/announcements/:id", rateLimit("partnerannouncementupdate", 30, 60 * 1000), async (req, res) => {
  const auth = await authedUser(req).catch(() => null);
  if (!auth) return res.status(401).json({ error: "Missing or invalid Authorization Bearer token" });
  const id = parsePositiveInt(req.params.id, 0);
  if (!id) return bad(res, "id must be a positive integer");
  const { data: existing, error: findError } = await auth.me.from("partner_announcements")
    .select("*").eq("id", id).maybeSingle();
  if (findError) return phase4DbError(res, findError, "Partner announcements");
  if (!existing) return res.status(404).json({ error: "Announcement not found" });
  if (existing.author_id !== auth.user.id) return res.status(403).json({ error: "You can only edit your own announcements" });
  if (existing.status !== "pending") return res.status(409).json({ error: "Only pending announcements can be edited" });
  const access = await p4PartnerAccess(auth, existing.institution_id);
  if (access.dbError) return phase4DbError(res, access.dbError, "Partner announcements");
  if (access.error) return res.status(access.status || 403).json({ error: access.error });
  const parsed = p4AnnouncementInput(req.body, true);
  if (parsed.error) return bad(res, parsed.error);
  if (!Object.keys(parsed.data).length) return bad(res, "nothing to update");
  const patch = {
    ...parsed.data,
    status: "pending",
    admin_note: null,
    published_at: null,
    reviewed_at: null,
    reviewed_by: null
  };
  const { data, error } = await auth.me.from("partner_announcements").update(patch)
    .eq("id", id).eq("author_id", auth.user.id).eq("status", "pending")
    .select(PARTNER_OWN_ANNOUNCEMENT_FIELDS).single();
  if (error) {
    if (error.code === "PGRST116") return res.status(409).json({ error: "This announcement is no longer pending" });
    return phase4DbError(res, error, "Partner announcements");
  }
  res.json({ announcement: data, setupRequired: false });
});

app.get("/api/partner/opportunities", async (req, res) => {
  const auth = await authedUser(req).catch(() => null);
  if (!auth) return res.status(401).json({ error: "Missing or invalid Authorization Bearer token" });
  const context = await p4PartnerContext(auth);
  if (context.dbError) {
    if (missingRelation(context.dbError)) return res.json({ opportunities: [], setupRequired: true });
    return phase4DbError(res, context.dbError, "Partner opportunities");
  }
  const ids = context.memberships.map(m => m.institution_id);
  if (!ids.length) return res.json({ opportunities: [], setupRequired: false });
  const { data, error } = await auth.me.from("recruitment_opportunities")
    .select(PARTNER_OWN_OPPORTUNITY_FIELDS).in("institution_id", ids)
    .order("updated_at", { ascending: false }).limit(100);
  if (error) return phase4DbError(res, error, "Partner opportunities");
  res.json({ opportunities: data || [], setupRequired: false });
});

app.post("/api/partner/opportunities", rateLimit("partneropportunity", 20, 60 * 1000), async (req, res) => {
  const auth = await authedUser(req).catch(() => null);
  if (!auth) return res.status(401).json({ error: "Missing or invalid Authorization Bearer token" });
  const institutionId = parsePositiveInt(req.body && req.body.institution_id, 0);
  if (!institutionId) return bad(res, "institution_id must be a positive integer");
  const access = await p4PartnerAccess(auth, institutionId);
  if (access.dbError) return phase4DbError(res, access.dbError, "Partner opportunities");
  if (access.error) return res.status(access.status || 403).json({ error: access.error });
  const parsed = p4OpportunityInput(req.body, false);
  if (parsed.error) return bad(res, parsed.error);
  const row = {
    institution_id: institutionId,
    posted_by: auth.user.id,
    title: parsed.data.title,
    organisation: parsed.data.organisation,
    description: parsed.data.description,
    location: parsed.data.location || null,
    work_mode: parsed.data.work_mode,
    role_type: parsed.data.role_type,
    eligibility: parsed.data.eligibility || null,
    deadline: parsed.data.deadline || null,
    application_url: parsed.data.application_url,
    source_url: parsed.data.source_url || null,
    status: "pending",
    admin_note: null,
    published_at: null,
    reviewed_at: null,
    reviewed_by: null
  };
  const { data, error } = await auth.me.from("recruitment_opportunities")
    .insert(row).select(PARTNER_OWN_OPPORTUNITY_FIELDS).single();
  if (error) return phase4DbError(res, error, "Partner opportunities");
  res.status(201).json({ opportunity: data, setupRequired: false });
});

app.patch("/api/partner/opportunities/:id", rateLimit("partneropportunityupdate", 30, 60 * 1000), async (req, res) => {
  const auth = await authedUser(req).catch(() => null);
  if (!auth) return res.status(401).json({ error: "Missing or invalid Authorization Bearer token" });
  const id = parsePositiveInt(req.params.id, 0);
  if (!id) return bad(res, "id must be a positive integer");
  const { data: existing, error: findError } = await auth.me.from("recruitment_opportunities")
    .select("*").eq("id", id).maybeSingle();
  if (findError) return phase4DbError(res, findError, "Partner opportunities");
  if (!existing) return res.status(404).json({ error: "Opportunity not found" });
  if (existing.posted_by !== auth.user.id) return res.status(403).json({ error: "You can only edit your own opportunities" });
  if (existing.status !== "pending") return res.status(409).json({ error: "Only pending opportunities can be edited" });
  const access = await p4PartnerAccess(auth, existing.institution_id);
  if (access.dbError) return phase4DbError(res, access.dbError, "Partner opportunities");
  if (access.error) return res.status(access.status || 403).json({ error: access.error });
  const parsed = p4OpportunityInput(req.body, true);
  if (parsed.error) return bad(res, parsed.error);
  if (!Object.keys(parsed.data).length) return bad(res, "nothing to update");
  const patch = {
    ...parsed.data,
    status: "pending",
    admin_note: null,
    published_at: null,
    reviewed_at: null,
    reviewed_by: null
  };
  const { data, error } = await auth.me.from("recruitment_opportunities").update(patch)
    .eq("id", id).eq("posted_by", auth.user.id).eq("status", "pending")
    .select(PARTNER_OWN_OPPORTUNITY_FIELDS).single();
  if (error) {
    if (error.code === "PGRST116") return res.status(409).json({ error: "This opportunity is no longer pending" });
    return phase4DbError(res, error, "Partner opportunities");
  }
  res.json({ opportunity: data, setupRequired: false });
});

// ---- Phase 4A admin: partner accounts and members (super admin) ----
app.get("/api/admin/partners", async (req, res) => {
  const auth = await requireAdmin(req, res);
  if (!auth) return;
  const db = adminDb() || auth.me;
  const status = String(req.query.status || "");
  if (status && !PARTNER_STATUSES.includes(status)) return bad(res, "status is invalid");
  const q = cleanText(req.query.q, 80).replace(/[%,()]/g, " ").trim();
  let partnerIds = null;
  if (q) {
    const ir = await supabase.from("institutions").select("id").ilike("name", "%" + q + "%").limit(100);
    if (ir.error) return phase4DbError(res, ir.error, "Institutions");
    partnerIds = (ir.data || []).map(i => i.id);
    if (!partnerIds.length) return res.json({ partners: [], total: 0, setupRequired: false });
  }
  let query = db.from("institution_partners").select("*", { count: "exact" });
  if (status) query = query.eq("status", status);
  if (partnerIds) query = query.in("institution_id", partnerIds);
  const { data, error, count } = await query.order("updated_at", { ascending: false }).limit(100);
  if (error) return phase4DbError(res, error, "Partners");
  const ids = [...new Set((data || []).map(p => p.institution_id))];
  let institutions = {};
  if (ids.length) {
    const ir = await supabase.from("institutions").select("id,name,location,ownership,kind").in("id", ids);
    (ir.data || []).forEach(i => { institutions[i.id] = i; });
  }
  res.json({
    partners: (data || []).map(p => ({ ...p, institution: institutions[p.institution_id] || null })),
    total: count || 0,
    setupRequired: false
  });
});

app.post("/api/admin/partners", async (req, res) => {
  const auth = await requireSuperAdmin(req, res);
  if (!auth) return;
  const institutionId = parsePositiveInt(req.body && req.body.institution_id, 0);
  if (!institutionId) return bad(res, "institution_id must be a positive integer");
  const parsed = p4PartnerAdminInput(req.body);
  if (parsed.error) return bad(res, parsed.error);
  const db = adminDb() || auth.me;
  const { data: institution, error: iErr } = await supabase.from("institutions")
    .select("id,name,location,ownership,kind").eq("id", institutionId).maybeSingle();
  if (iErr) return phase4DbError(res, iErr, "Institutions");
  if (!institution) return res.status(404).json({ error: "Institution not found" });
  const { data: existing, error: findError } = await db.from("institution_partners")
    .select("institution_id").eq("institution_id", institutionId).maybeSingle();
  if (findError) return phase4DbError(res, findError, "Partners");
  if (existing) return res.status(409).json({ error: "This institution already has a partner record" });
  const status = parsed.data.status || "pending";
  if (parsed.data.listed === true && status !== "verified") return bad(res, "Verify the partner before listing it publicly");
  const now = new Date().toISOString();
  const row = {
    institution_id: institutionId,
    status,
    public_summary: parsed.data.public_summary || null,
    official_url: parsed.data.official_url || null,
    verification_method: parsed.data.verification_method || "official_website",
    verification_detail: parsed.data.verification_detail || null,
    admin_note: parsed.data.admin_note || null,
    listed: parsed.data.listed === true,
    verified_at: status === "verified" ? now : null,
    verified_by: status === "verified" ? auth.user.id : null
  };
  const { data, error } = await db.from("institution_partners").insert(row).select("*").single();
  if (error) {
    if (error.code === "23505") return res.status(409).json({ error: "This institution already has a partner record" });
    return phase4DbError(res, error, "Partners");
  }
  await auditAdmin(auth, "partner.create", String(institutionId), { status, listed: row.listed });
  res.status(201).json({ partner: { ...data, institution }, setupRequired: false });
});

app.patch("/api/admin/partners/:institutionId", async (req, res) => {
  const auth = await requireSuperAdmin(req, res);
  if (!auth) return;
  const institutionId = parsePositiveInt(req.params.institutionId, 0);
  if (!institutionId) return bad(res, "institutionId must be a positive integer");
  const parsed = p4PartnerAdminInput(req.body);
  if (parsed.error) return bad(res, parsed.error);
  if (!Object.keys(parsed.data).length) return bad(res, "nothing to update");
  const db = adminDb() || auth.me;
  const { data: existing, error: findError } = await db.from("institution_partners")
    .select("*").eq("institution_id", institutionId).maybeSingle();
  if (findError) return phase4DbError(res, findError, "Partners");
  if (!existing) return res.status(404).json({ error: "Partner not found" });
  const nextStatus = parsed.data.status || existing.status;
  if (parsed.data.listed === true && nextStatus !== "verified") return bad(res, "Verify the partner before listing it publicly");
  const patch = { ...parsed.data };
  if (nextStatus === "verified") {
    patch.verified_at = existing.verified_at || new Date().toISOString();
    patch.verified_by = existing.verified_by || auth.user.id;
  } else {
    patch.verified_at = null;
    patch.verified_by = null;
  }
  const { data, error } = await db.from("institution_partners").update(patch)
    .eq("institution_id", institutionId).select("*").single();
  if (error) return phase4DbError(res, error, "Partners");
  const { data: institution } = await supabase.from("institutions")
    .select("id,name,location,ownership,kind").eq("id", institutionId).maybeSingle();
  await auditAdmin(auth, "partner." + nextStatus, String(institutionId), {
    status: nextStatus, listed: data.listed, changed: Object.keys(parsed.data)
  });
  res.json({ partner: { ...data, institution: institution || null }, setupRequired: false });
});

app.get("/api/admin/partner-members", async (req, res) => {
  const auth = await requireAdmin(req, res);
  if (!auth) return;
  const db = adminDb() || auth.me;
  const institutionId = req.query.institution_id === undefined ? null : parsePositiveInt(req.query.institution_id, 0);
  if (req.query.institution_id !== undefined && !institutionId) return bad(res, "institution_id must be a positive integer");
  let query = db.from("institution_partner_members").select("*", { count: "exact" });
  if (institutionId) query = query.eq("institution_id", institutionId);
  const { data, error, count } = await query.order("created_at", { ascending: false }).limit(200);
  if (error) return phase4DbError(res, error, "Partner members");
  const userIds = [...new Set((data || []).map(m => m.user_id))];
  const institutionIds = [...new Set((data || []).map(m => m.institution_id))];
  let profiles = {};
  let institutions = {};
  if (userIds.length) {
    const pr = await db.from("profiles").select("id,name,email,school,photo_url,visibility").in("id", userIds);
    (pr.data || []).forEach(p => { profiles[p.id] = p; });
  }
  if (institutionIds.length) {
    const ir = await supabase.from("institutions").select("id,name,location").in("id", institutionIds);
    (ir.data || []).forEach(i => { institutions[i.id] = i; });
  }
  res.json({
    members: (data || []).map(m => ({
      ...m,
      profile: profiles[m.user_id] || null,
      institution: institutions[m.institution_id] || null
    })),
    total: count || 0,
    setupRequired: false
  });
});

app.post("/api/admin/partner-members", async (req, res) => {
  const auth = await requireSuperAdmin(req, res);
  if (!auth) return;
  const institutionId = parsePositiveInt(req.body && req.body.institution_id, 0);
  if (!institutionId) return bad(res, "institution_id must be a positive integer");
  const email = String((req.body && req.body.email) || "").trim().toLowerCase();
  if (!isEmail(email)) return bad(res, "email is invalid");
  const memberRole = (req.body && req.body.member_role) || "owner";
  if (!["owner", "editor"].includes(memberRole)) return bad(res, "member_role must be owner or editor");
  const db = adminDb() || auth.me;
  const { data: partner, error: pErr } = await db.from("institution_partners")
    .select("institution_id").eq("institution_id", institutionId).maybeSingle();
  if (pErr) return phase4DbError(res, pErr, "Partners");
  if (!partner) return res.status(404).json({ error: "Partner not found" });
  const { data: profile, error: uErr } = await db.from("profiles")
    .select("id,name,email,school").ilike("email", email).maybeSingle();
  if (uErr) return phase4DbError(res, uErr, "Profiles");
  if (!profile) return res.status(404).json({ error: "No Fidonect account uses that email" });
  const row = {
    institution_id: institutionId,
    user_id: profile.id,
    member_role: memberRole,
    status: "active"
  };
  const { data, error } = await db.from("institution_partner_members")
    .upsert(row, { onConflict: "institution_id,user_id" }).select("*").single();
  if (error) return phase4DbError(res, error, "Partner members");
  await auditAdmin(auth, "partner.member.add", String(institutionId), {
    user_id: profile.id, member_role: memberRole
  });
  res.status(201).json({ member: { ...data, profile }, setupRequired: false });
});

app.patch("/api/admin/partner-members/:institutionId/:userId", async (req, res) => {
  const auth = await requireSuperAdmin(req, res);
  if (!auth) return;
  const institutionId = parsePositiveInt(req.params.institutionId, 0);
  if (!institutionId) return bad(res, "institutionId must be a positive integer");
  const userId = String(req.params.userId || "");
  if (!isUuid(userId)) return bad(res, "userId must be a valid UUID");
  const body = req.body || {};
  const patch = {};
  if (body.member_role !== undefined) {
    if (!["owner", "editor"].includes(body.member_role)) return bad(res, "member_role must be owner or editor");
    patch.member_role = body.member_role;
  }
  if (body.status !== undefined) {
    if (!["active", "revoked"].includes(body.status)) return bad(res, "status must be active or revoked");
    patch.status = body.status;
  }
  if (!Object.keys(patch).length) return bad(res, "nothing to update");
  const db = adminDb() || auth.me;
  const { data, error } = await db.from("institution_partner_members").update(patch)
    .eq("institution_id", institutionId).eq("user_id", userId)
    .select("*").single();
  if (error) {
    if (error.code === "PGRST116") return res.status(404).json({ error: "Partner member not found" });
    return phase4DbError(res, error, "Partner members");
  }
  await auditAdmin(auth, "partner.member.update", String(institutionId), { user_id: userId, ...patch });
  res.json({ member: data, setupRequired: false });
});

// ---- Phase 4A admin: review queues ----
app.get("/api/admin/partner-announcements", async (req, res) => {
  const auth = await requireAdmin(req, res);
  if (!auth) return;
  const db = adminDb() || auth.me;
  const status = String(req.query.status || "");
  if (status && !ANNOUNCEMENT_STATUSES.includes(status)) return bad(res, "status is invalid");
  const institutionId = req.query.institution_id === undefined ? null : parsePositiveInt(req.query.institution_id, 0);
  if (req.query.institution_id !== undefined && !institutionId) return bad(res, "institution_id must be a positive integer");
  let query = db.from("partner_announcements").select("*", { count: "exact" });
  if (status) query = query.eq("status", status);
  if (institutionId) query = query.eq("institution_id", institutionId);
  const { data, error, count } = await query.order("updated_at", { ascending: false }).limit(100);
  if (error) return phase4DbError(res, error, "Partner announcements");
  const ids = [...new Set((data || []).map(a => a.institution_id))];
  const authorIds = [...new Set((data || []).map(a => a.author_id).filter(Boolean))];
  let institutions = {};
  let profiles = {};
  if (ids.length) {
    const ir = await supabase.from("institutions").select("id,name,location,ownership,kind").in("id", ids);
    (ir.data || []).forEach(i => { institutions[i.id] = i; });
  }
  if (authorIds.length) {
    const pr = await db.from("profiles").select("id,name,email,school").in("id", authorIds);
    (pr.data || []).forEach(p => { profiles[p.id] = p; });
  }
  res.json({
    announcements: (data || []).map(a => ({
      ...a,
      institution: institutions[a.institution_id] || null,
      author: profiles[a.author_id] || null
    })),
    total: count || 0,
    setupRequired: false
  });
});

app.patch("/api/admin/partner-announcements/:id", async (req, res) => {
  const auth = await requireContentAdmin(req, res);
  if (!auth) return;
  const id = parsePositiveInt(req.params.id, 0);
  if (!id) return bad(res, "id must be a positive integer");
  const parsed = p4AnnouncementAdminPatch(req.body || {});
  if (parsed.error) return bad(res, parsed.error);
  if (!Object.keys(parsed.data).length) return bad(res, "nothing to update");
  const db = adminDb() || auth.me;
  const { data: existing, error: findError } = await db.from("partner_announcements")
    .select("*").eq("id", id).maybeSingle();
  if (findError) return phase4DbError(res, findError, "Partner announcements");
  if (!existing) return res.status(404).json({ error: "Announcement not found" });
  const nextStatus = parsed.data.status || existing.status;
  const patch = { ...parsed.data };
  const now = new Date().toISOString();
  if (patch.status === "pending") {
    patch.published_at = null;
    patch.reviewed_at = null;
    patch.reviewed_by = null;
  } else if (patch.status !== undefined && patch.status !== existing.status) {
    patch.reviewed_at = now;
    patch.reviewed_by = auth.user.id;
    if (patch.status === "approved") patch.published_at = existing.published_at || now;
  }
  if (nextStatus === "approved" && !patch.published_at && !existing.published_at) patch.published_at = now;
  const { data, error } = await db.from("partner_announcements").update(patch)
    .eq("id", id).select("*").single();
  if (error) return phase4DbError(res, error, "Partner announcements");
  await auditAdmin(auth, "partner_announcement." + nextStatus, String(id), {
    status: nextStatus, institution_id: data.institution_id, title: data.title
  });
  res.json({ announcement: data, setupRequired: false });
});

app.get("/api/admin/alumni", async (req, res) => {
  const auth = await requireAdmin(req, res);
  if (!auth) return;
  const db = adminDb() || auth.me;
  const status = String(req.query.status || "");
  if (status && !ALUMNI_STATUSES.includes(status)) return bad(res, "status is invalid");
  const q = cleanText(req.query.q, 80).replace(/[%,()]/g, " ").trim();
  let userIds = null;
  if (q) {
    const pr = await db.from("profiles").select("id")
      .or("name.ilike.%" + q + "%,email.ilike.%" + q + "%,school.ilike.%" + q + "%").limit(100);
    if (pr.error) return phase4DbError(res, pr.error, "Profiles");
    userIds = (pr.data || []).map(p => p.id);
    if (!userIds.length) return res.json({ alumni: [], total: 0, setupRequired: false });
  }
  let query = db.from("alumni_profiles").select("*", { count: "exact" });
  if (status) query = query.eq("status", status);
  if (userIds) query = query.in("user_id", userIds);
  const { data, error, count } = await query.order("updated_at", { ascending: false }).limit(100);
  if (error) return phase4DbError(res, error, "Alumni");
  const ids = [...new Set((data || []).map(a => a.user_id))];
  const institutionIds = [...new Set((data || []).map(a => a.institution_id).filter(Boolean))];
  let profiles = {};
  let institutions = {};
  if (ids.length) {
    const pr = await db.from("profiles").select("id,name,email,school,photo_url,visibility,user_type").in("id", ids);
    (pr.data || []).forEach(p => { profiles[p.id] = p; });
  }
  if (institutionIds.length) {
    const ir = await supabase.from("institutions").select("id,name,location,ownership,kind").in("id", institutionIds);
    (ir.data || []).forEach(i => { institutions[i.id] = i; });
  }
  res.json({
    alumni: (data || []).map(a => ({
      ...a,
      profile: profiles[a.user_id] || null,
      institution: institutions[a.institution_id] || null
    })),
    total: count || 0,
    setupRequired: false
  });
});

app.patch("/api/admin/alumni/:userId", async (req, res) => {
  const auth = await requireContentAdmin(req, res);
  if (!auth) return;
  const userId = String(req.params.userId || "");
  if (!isUuid(userId)) return bad(res, "userId must be a valid UUID");
  const parsed = p4AlumniAdminPatch(req.body || {});
  if (parsed.error) return bad(res, parsed.error);
  if (!Object.keys(parsed.data).length) return bad(res, "nothing to update");
  const db = adminDb() || auth.me;
  const { data: existing, error: findError } = await db.from("alumni_profiles")
    .select("*").eq("user_id", userId).maybeSingle();
  if (findError) return phase4DbError(res, findError, "Alumni");
  if (!existing) return res.status(404).json({ error: "Alumni application not found" });
  const patch = { ...parsed.data };
  const school = patch.school;
  delete patch.school;
  if (school !== undefined) {
    const institution = await resolveListingInstitution({
      school,
      institution_id: patch.institution_id === undefined ? undefined : patch.institution_id
    });
    if (!institution) return bad(res, "Choose an institution from the Fidonect directory.");
    patch.institution_id = institution.id;
    patch.institution_name = institution.name;
  } else if (patch.institution_id !== undefined) {
    if (patch.institution_id === null) {
      patch.institution_id = null;
    } else {
      const institution = await resolveListingInstitution({ institution_id: patch.institution_id });
      if (!institution) return bad(res, "Choose an institution from the Fidonect directory.");
      patch.institution_id = institution.id;
      patch.institution_name = institution.name;
    }
  }
  const nextStatus = patch.status || existing.status;
  if (patch.listed === true && nextStatus !== "verified") return bad(res, "Verify the alumni profile before listing it publicly");
  if (nextStatus === "verified") {
    patch.verified_at = existing.verified_at || new Date().toISOString();
    patch.verified_by = existing.verified_by || auth.user.id;
  } else {
    patch.verified_at = null;
    patch.verified_by = null;
  }
  const { data, error } = await db.from("alumni_profiles").update(patch)
    .eq("user_id", userId).select("*").single();
  if (error) return phase4DbError(res, error, "Alumni");
  await auditAdmin(auth, "alumni." + nextStatus, userId, {
    status: nextStatus, listed: data.listed, institution_id: data.institution_id
  });
  res.json({ alumni: data, setupRequired: false });
});

app.get("/api/admin/opportunities", async (req, res) => {
  const auth = await requireAdmin(req, res);
  if (!auth) return;
  const db = adminDb() || auth.me;
  const status = String(req.query.status || "");
  if (status && !OPPORTUNITY_STATUSES.includes(status)) return bad(res, "status is invalid");
  const institutionId = req.query.institution_id === undefined ? null : parsePositiveInt(req.query.institution_id, 0);
  if (req.query.institution_id !== undefined && !institutionId) return bad(res, "institution_id must be a positive integer");
  let query = db.from("recruitment_opportunities").select("*", { count: "exact" });
  if (status) query = query.eq("status", status);
  if (institutionId) query = query.eq("institution_id", institutionId);
  const { data, error, count } = await query.order("updated_at", { ascending: false }).limit(100);
  if (error) return phase4DbError(res, error, "Opportunities");
  const ids = [...new Set((data || []).map(o => o.institution_id))];
  const posterIds = [...new Set((data || []).map(o => o.posted_by).filter(Boolean))];
  let institutions = {};
  let profiles = {};
  if (ids.length) {
    const ir = await supabase.from("institutions").select("id,name,location,ownership,kind").in("id", ids);
    (ir.data || []).forEach(i => { institutions[i.id] = i; });
  }
  if (posterIds.length) {
    const pr = await db.from("profiles").select("id,name,email,school").in("id", posterIds);
    (pr.data || []).forEach(p => { profiles[p.id] = p; });
  }
  res.json({
    opportunities: (data || []).map(o => ({
      ...o,
      institution: institutions[o.institution_id] || null,
      poster: profiles[o.posted_by] || null
    })),
    total: count || 0,
    setupRequired: false
  });
});

app.patch("/api/admin/opportunities/:id", async (req, res) => {
  const auth = await requireContentAdmin(req, res);
  if (!auth) return;
  const id = parsePositiveInt(req.params.id, 0);
  if (!id) return bad(res, "id must be a positive integer");
  const parsed = p4OpportunityAdminPatch(req.body || {});
  if (parsed.error) return bad(res, parsed.error);
  if (!Object.keys(parsed.data).length) return bad(res, "nothing to update");
  const db = adminDb() || auth.me;
  const { data: existing, error: findError } = await db.from("recruitment_opportunities")
    .select("*").eq("id", id).maybeSingle();
  if (findError) return phase4DbError(res, findError, "Opportunities");
  if (!existing) return res.status(404).json({ error: "Opportunity not found" });
  const nextStatus = parsed.data.status || existing.status;
  const patch = { ...parsed.data };
  const now = new Date().toISOString();
  if (patch.status === "pending") {
    patch.published_at = null;
    patch.reviewed_at = null;
    patch.reviewed_by = null;
  } else if (patch.status !== undefined && patch.status !== existing.status) {
    patch.reviewed_at = now;
    patch.reviewed_by = auth.user.id;
    if (patch.status === "approved") patch.published_at = existing.published_at || now;
  }
  if (nextStatus === "approved" && !patch.published_at && !existing.published_at) patch.published_at = now;
  const { data, error } = await db.from("recruitment_opportunities").update(patch)
    .eq("id", id).select("*").single();
  if (error) return phase4DbError(res, error, "Opportunities");
  await auditAdmin(auth, "opportunity." + nextStatus, String(id), {
    status: nextStatus, institution_id: data.institution_id, title: data.title
  });
  res.json({ opportunity: data, setupRequired: false });
});

// JSON 404 for unknown API routes, then a final error handler so async
// rejections never leak stack traces to clients.
app.use("/api", (req, res) => res.status(404).json({ error: "Not found" }));
app.use((err, req, res, next) => {
  if (err && err.code === "LIMIT_FILE_SIZE") return res.status(400).json({ error: "photo must be under 4MB" });
  if (res.headersSent) return next(err);
  const status = err && (err.status || err.statusCode) || 500;
  if (status >= 500) console.error("Unhandled API error:", (err && err.message) || err);
  res.status(status).json({ error: status >= 500 ? "Something went wrong. Please try again." : ((err && err.message) || "Request failed") });
});

const PORT = process.env.PORT || 3000;
// Render/local run a long-lived process; Vercel imports this module as a
// serverless handler and must not call listen().
if (require.main === module) {
  app.listen(PORT, () => console.log(`Fidonect API listening on :${PORT}`));
}
module.exports = app;
