// Read-only production smoke test. Usage:
//   node scripts/smoke.mjs
//   FIDONECT_BASE=http://localhost:3000 node scripts/smoke.mjs
const base = (process.env.FIDONECT_BASE || "https://fidonect.vercel.app").replace(/\/$/, "");
const checks = [];

async function check(name, path, validate) {
  try {
    const r = await fetch(base + path, { headers: { Accept: "application/json,text/html" } });
    const text = await r.text();
    let body = null;
    try { body = JSON.parse(text); } catch (e) { body = text; }
    const ok = r.ok && (!validate || validate(body, r));
    checks.push({ name, ok, status: r.status, detail: ok ? "" : String(text).slice(0, 180) });
  } catch (e) {
    checks.push({ name, ok: false, status: 0, detail: e.message });
  }
}

await check("health", "/health", (b) => b && b.ok === true);
await check("status", "/api/status", (b) => b && b.ok === true);
await check("institutions", "/api/institutions", (b) => Array.isArray(b) && b.length > 0);
await check("scholarships API", "/api/scholarships", (b) => b && (Array.isArray(b.scholarships) || b.setupRequired === true));
await check("scholarships page", "/scholarships", (b) => typeof b === "string" && b.includes("Scholarships"));
await check("mentors API", "/api/mentors", (b) => b && (Array.isArray(b.mentors) || b.setupRequired === true));
await check("mentors page", "/mentors", (b) => typeof b === "string" && b.includes("Mentors"));
await check("profile page", "/profile", (b) => typeof b === "string" && b.includes("My profile") || typeof b === "string" && b.includes("Join Fidonect"));

for (const c of checks) {
  console.log((c.ok ? "PASS" : "FAIL") + "  " + c.name + (c.status ? "  HTTP " + c.status : "") + (c.detail ? "\n      " + c.detail : ""));
}
const failures = checks.filter((c) => !c.ok).length;
console.log("\n" + (checks.length - failures) + "/" + checks.length + " checks passed against " + base);
process.exit(failures ? 1 : 0);
