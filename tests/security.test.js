const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const server = fs.readFileSync(path.join(root, "backend", "server.js"), "utf8");
const securitySql = fs.readFileSync(path.join(root, "backend", "migrations", "20261114_phase0_security.sql"), "utf8");
const scholarshipSql = fs.readFileSync(path.join(root, "backend", "migrations", "20261114_phase1_scholarships.sql"), "utf8");

test("API uses the privacy-safe profile view with a pre-migration fallback", () => {
  assert.match(server, /visible_profiles/);
  assert.match(server, /async function profilesFrom/);
  assert.match(server, /client\.from\("profiles"\)/);
});

test("admin identity check is verified with Supabase Auth", () => {
  const route = server.slice(server.indexOf('app.get("/api/admin/me"'), server.indexOf('app.get("/api/admin/stats"'));
  assert.match(route, /verifiedUser\(req\)/);
  assert.doesNotMatch(route, /authedUser\(req\)/);
});

test("the broad profile read policy is removed by the security migration", () => {
  assert.match(securitySql, /drop policy if exists "read profiles" on public\.profiles/);
  assert.match(securitySql, /create policy "read own profile" on public\.profiles/);
  assert.match(securitySql, /visible_profiles/);
  assert.match(securitySql, /revoke insert on public\.participants from authenticated/);
  assert.match(securitySql, /storage\.foldername\(name\)/);
  assert.match(securitySql, /upload own avatars %/);
  assert.match(securitySql, /drop policy if exists %I on storage\.objects/);
  assert.match(securitySql, /revoke execute on function public\.open_conversation\(uuid\) from anon/);
  assert.match(securitySql, /revoke execute on function public\.is_participant\(bigint\) from anon/);
});

test("scholarship migration is additive and public reads are limited to published rows", () => {
  assert.match(scholarshipSql, /create table if not exists public\.scholarships/);
  assert.match(scholarshipSql, /create table if not exists public\.scholarship_bookmarks/);
  assert.match(scholarshipSql, /status = 'published'/);
  assert.match(scholarshipSql, /enable row level security/);
  assert.match(scholarshipSql, /revoke insert, update, delete on public\.scholarships from anon/);
  assert.doesNotMatch(scholarshipSql, /drop table/i);
  assert.doesNotMatch(scholarshipSql, /delete from/i);
});

test("server does not use a wildcard CORS policy", () => {
  assert.doesNotMatch(server, /app\.use\(cors\(\)\)/);
  assert.match(server, /originAllowed/);
  assert.match(server, /OFFICIAL_ORIGINS/);
});

test("package manifests are valid JSON without a byte-order mark", () => {
  for (const file of ["package.json", "backend/package.json"]) {
    const bytes = fs.readFileSync(path.join(root, file));
    assert.notDeepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf], file + " must not start with a BOM");
    assert.doesNotThrow(() => JSON.parse(bytes.toString("utf8")), file + " must be valid JSON");
  }
});
