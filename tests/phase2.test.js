const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const server = fs.readFileSync(path.join(root, "backend", "server.js"), "utf8");
const phase2Sql = fs.readFileSync(path.join(root, "backend", "migrations", "20261116_phase2_mentorship_hubs_fido.sql"), "utf8");
const indexHtml = fs.readFileSync(path.join(root, "index.html"), "utf8");
const adminHtml = fs.readFileSync(path.join(root, "backend", "public", "admin.html"), "utf8");

test("Phase 2 migration is additive and never removes existing data", () => {
  assert.match(phase2Sql, /create table if not exists public\.mentor_profiles/);
  assert.match(phase2Sql, /create table if not exists public\.mentor_requests/);
  assert.match(phase2Sql, /create table if not exists public\.fido_feedback/);
  assert.match(phase2Sql, /alter table public\.hub_pages add column if not exists/);
  assert.doesNotMatch(phase2Sql, /drop table/i);
  assert.doesNotMatch(phase2Sql, /delete from/i);
  assert.doesNotMatch(phase2Sql, /truncate/i);
});

test("mentor directory only exposes admin-verified, listed mentors and no private evidence", () => {
  assert.match(phase2Sql, /create or replace view public\.mentor_directory/);
  assert.match(phase2Sql, /where m\.status = 'verified'/);
  assert.match(phase2Sql, /and m\.listed = true/);
  assert.match(phase2Sql, /and coalesce\(p\.visibility, 'public'\) <> 'private'/);
  const view = phase2Sql.slice(phase2Sql.indexOf("create or replace view public.mentor_directory"), phase2Sql.indexOf("revoke all on public.mentor_directory"));
  assert.doesNotMatch(view, /email/i);
  assert.doesNotMatch(view, /verification_detail/i);
  assert.doesNotMatch(view, /admin_note/i);
});

test("mentor applications cannot self-verify and admin writes are role-gated", () => {
  assert.match(phase2Sql, /grant select, insert, update on public\.mentor_profiles to authenticated/);
  assert.match(phase2Sql, /with check \(\s*user_id = auth\.uid\(\)\s*and status = 'pending'/);
  assert.match(phase2Sql, /"admins update mentor profiles"/);
  assert.match(phase2Sql, /public\.has_role\('super_admin'\) or public\.has_role\('content_admin'\)/);
  assert.match(phase2Sql, /create or replace function public\.guard_mentor_profile_update/);
  assert.match(phase2Sql, /mentor_profiles_guard_update/);
});

test("mentor requests are participant-scoped and accepted requests unlock messaging", () => {
  assert.match(phase2Sql, /create policy "read own mentor requests"/);
  assert.match(phase2Sql, /requester_id = auth\.uid\(\) or mentor_id = auth\.uid\(\)/);
  assert.match(phase2Sql, /create unique index if not exists mentor_requests_one_pending_idx/);
  assert.match(phase2Sql, /create or replace function public\.is_verified_mentor/);
  assert.match(phase2Sql, /public\.is_verified_mentor\(mentor_id\)/);
  assert.match(phase2Sql, /create or replace function public\.lock_mentor_request_participants/);
  assert.match(phase2Sql, /mentor_requests_lock_participants/);
  assert.match(phase2Sql, /from mentor_requests r/);
  assert.match(phase2Sql, /r\.status = 'accepted'/);
  assert.match(server, /acceptedMentorRequest/);
  assert.match(server, /!ok && !mentorOk && !listingOk/);
});

test("hub information is verified-only when labelled Official", () => {
  assert.match(phase2Sql, /add column if not exists verified boolean not null default false/);
  assert.match(phase2Sql, /"admins update hub pages"/);
  assert.match(server, /function hubVerified/);
  assert.match(server, /source: verified \? "Official" : "Community"/);
  assert.match(server, /not yet verified by Fidonect/);
  assert.match(server, /"\/api\/admin\/hubs"/);
});

test("Fido feedback allows anonymous and signed-in inserts but only admins can read", () => {
  assert.match(phase2Sql, /create policy "anonymous fido feedback"/);
  assert.match(phase2Sql, /user_id is null/);
  assert.match(phase2Sql, /create policy "signed-in fido feedback"/);
  assert.match(phase2Sql, /user_id = auth\.uid\(\)/);
  assert.match(phase2Sql, /create policy "admins read fido feedback"/);
  assert.match(server, /app\.post\("\/api\/fido\/feedback"/);
});

test("Phase 2 API routes and app pages are wired", () => {
  for (const route of ["/api/mentors", "/api/mentors/me", "/api/mentors/apply", "/api/mentor-requests", "/api/mentor-requests/mine", "/api/admin/mentors", "/api/admin/hubs"]) {
    assert.ok(server.includes(route), route + " must exist");
  }
  assert.match(server, /"\/mentors"/);
  assert.match(indexHtml, /id="mentors" data-page="mentors"/);
  assert.match(indexHtml, /href="\/mentors"/);
  assert.match(adminHtml, /data-tab="mentors"/);
  assert.match(adminHtml, /data-tab="hubs"/);
});
