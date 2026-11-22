const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const server = fs.readFileSync(path.join(root, "backend", "server.js"), "utf8");
const phase4Sql = fs.readFileSync(path.join(root, "backend", "migrations", "20261120_phase4_partnerships_alumni_recruitment.sql"), "utf8");
const indexHtml = fs.readFileSync(path.join(root, "index.html"), "utf8");
const adminHtml = fs.readFileSync(path.join(root, "backend", "public", "admin.html"), "utf8");

function viewSql(name, nextMarker) {
  const start = phase4Sql.indexOf("create or replace view public." + name);
  assert.ok(start >= 0, name + " view must exist");
  const end = nextMarker ? phase4Sql.indexOf(nextMarker, start) : phase4Sql.length;
  assert.ok(end > start, "could not isolate " + name);
  return phase4Sql.slice(start, end);
}

test("Phase 4 migration is additive and does not remove or rewrite existing data", () => {
  for (const table of [
    "institution_partners", "institution_partner_members", "partner_announcements",
    "alumni_profiles", "recruitment_opportunities"
  ]) {
    assert.match(phase4Sql, new RegExp("create table if not exists public\\." + table));
  }
  assert.doesNotMatch(phase4Sql, /drop table/i);
  assert.doesNotMatch(phase4Sql, /delete from/i);
  assert.doesNotMatch(phase4Sql, /truncate/i);
  assert.doesNotMatch(phase4Sql, /insert into public\.(institutions|profiles|connections|messages)/i);
});

test("every Phase 4 base table has RLS and least-privilege grants", () => {
  for (const table of [
    "institution_partners", "institution_partner_members", "partner_announcements",
    "alumni_profiles", "recruitment_opportunities"
  ]) {
    assert.match(phase4Sql, new RegExp("alter table public\\." + table + " enable row level security"));
    assert.match(phase4Sql, new RegExp("revoke all on public\\." + table + " from anon, authenticated"));
    assert.match(phase4Sql, new RegExp("grant select, insert, update on public\\." + table + " to authenticated"));
    assert.doesNotMatch(phase4Sql, new RegExp("grant[^;]*delete[^;]*" + table, "i"));
    assert.doesNotMatch(phase4Sql, new RegExp("grant[^;]*truncate[^;]*" + table, "i"));
  }
});

test("public partner views expose only verified, listed, admin-approved rows", () => {
  const partnerView = viewSql("institution_partner_directory", "revoke all on public.institution_partner_directory");
  assert.match(partnerView, /where p\.status = 'verified'/);
  assert.match(partnerView, /and p\.listed = true/);
  assert.doesNotMatch(partnerView, /email/i);
  assert.doesNotMatch(partnerView, /phone/i);
  assert.doesNotMatch(partnerView, /verification_detail/i);
  assert.doesNotMatch(partnerView, /admin_note/i);

  const announcementView = viewSql("partner_announcement_directory", "revoke all on public.partner_announcement_directory");
  assert.match(announcementView, /where a\.status = 'approved'/);
  assert.match(announcementView, /a\.published_at is not null/);
  assert.match(announcementView, /and p\.status = 'verified'/);
  assert.match(announcementView, /and p\.listed = true/);
  assert.doesNotMatch(announcementView, /email/i);
  assert.doesNotMatch(announcementView, /admin_note/i);
});

test("alumni public view requires opt-in, admin verification, and non-private profile visibility", () => {
  const view = viewSql("alumni_directory", "revoke all on public.alumni_directory");
  assert.match(view, /where a\.status = 'verified'/);
  assert.match(view, /and a\.listed = true/);
  assert.match(view, /coalesce\(p\.visibility, 'public'\) <> 'private'/);
  assert.doesNotMatch(view, /\bp\.email\b/i);
  assert.doesNotMatch(view, /phone/i);
  assert.doesNotMatch(view, /verification_detail/i);
  assert.doesNotMatch(view, /admin_note/i);
});

test("recruitment public view is approved, open, and excludes private evidence", () => {
  const view = viewSql("recruitment_opportunity_directory", "revoke all on public.recruitment_opportunity_directory");
  assert.match(view, /where o\.status = 'approved'/);
  assert.match(view, /o\.published_at is not null/);
  assert.match(view, /o\.deadline is null or o\.deadline >= current_date/);
  assert.match(view, /and p\.status = 'verified'/);
  assert.match(view, /and p\.listed = true/);
  assert.doesNotMatch(view, /source_url/i);
  assert.doesNotMatch(view, /admin_note/i);
  assert.doesNotMatch(view, /\bcv\b/i);
  assert.doesNotMatch(view, /\bemail\b/i);
});

test("partner onboarding and alumni self-verification are blocked by RLS and guard triggers", () => {
  assert.match(phase4Sql, /create policy "admins insert partners"/);
  assert.match(phase4Sql, /with check \(public\.has_role\('super_admin'\)\)/);
  assert.match(phase4Sql, /create policy "admins insert partner members"/);
  assert.match(phase4Sql, /create policy "partners create announcements"/);
  assert.match(phase4Sql, /and status = 'pending'/);
  assert.match(phase4Sql, /and public\.is_verified_partner\(institution_id\)/);
  assert.match(phase4Sql, /create policy "partners create opportunities"/);
  assert.match(phase4Sql, /create policy "apply own alumni profile"/);
  assert.match(phase4Sql, /and verified_at is null/);
  assert.match(phase4Sql, /and verified_by is null/);
  assert.match(phase4Sql, /create or replace function public\.guard_alumni_profile_update/);
  assert.match(phase4Sql, /new\.status := 'pending'/);
  assert.match(phase4Sql, /create or replace function public\.guard_partner_announcement_update/);
  assert.match(phase4Sql, /create or replace function public\.guard_recruitment_opportunity_update/);
});

test("no payment, application, CV, or automated screening tables are created", () => {
  const tables = [...phase4Sql.matchAll(/create table if not exists public\.([a-z_]+)/gi)].map(m => m[1]);
  assert.deepEqual(tables.sort(), [
    "alumni_profiles", "institution_partner_members", "institution_partners",
    "partner_announcements", "recruitment_opportunities"
  ]);
  assert.doesNotMatch(phase4Sql, /create table if not exists public\.(applications|application|cvs|resumes|payments|invoices|billing)/i);
});

test("Phase 4 public, partner, and admin API routes are wired", () => {
  for (const route of [
    "/api/partners", "/api/partners/:institutionId", "/api/partner-announcements",
    "/api/alumni", "/api/alumni/me", "/api/alumni/apply", "/api/opportunities",
    "/api/partner/me", "/api/partner/announcements", "/api/partner/announcements/:id",
    "/api/partner/opportunities", "/api/partner/opportunities/:id",
    "/api/admin/partners", "/api/admin/partners/:institutionId",
    "/api/admin/partner-members", "/api/admin/partner-members/:institutionId/:userId",
    "/api/admin/partner-announcements", "/api/admin/partner-announcements/:id",
    "/api/admin/alumni", "/api/admin/alumni/:userId", "/api/admin/opportunities",
    "/api/admin/opportunities/:id"
  ]) {
    assert.ok(server.includes(route), route + " must exist");
  }
  assert.match(server, /requireSuperAdmin/);
  assert.match(server, /requireContentAdmin/);
  for (const route of ["partner-announcements/:id", "alumni/:userId", "opportunities/:id"]) {
    const guard = new RegExp("app\\.patch\\(\"/api/admin/" + route + "\"[\\s\\S]{0,140}requireContentAdmin");
    assert.match(server, guard, route + " must require a content admin");
  }
  assert.match(server, /role !== "super_admin" && role !== "content_admin"/);
  assert.match(server, /phase4DbError/);
  assert.match(server, /institution_partner_directory/);
  assert.match(server, /partner_announcement_directory/);
  assert.match(server, /alumni_directory/);
  assert.match(server, /recruitment_opportunity_directory/);
});

test("Phase 4 rollback flow test is transaction-scoped and exercises the guarded paths", () => {
  const sql = fs.readFileSync(path.join(root, "backend", "migrations", "tests", "phase4_rollback_test.sql"), "utf8");
  assert.match(sql, /^\s*begin;/im);
  assert.match(sql, /\brollback;/i);
  assert.doesNotMatch(sql, /^\s*commit;/im);
  for (const marker of [
    "institution_partner_directory", "partner_announcement_directory",
    "alumni_directory", "recruitment_opportunity_directory",
    "self-verify", "self-approval", "RLS is not enabled"
  ]) {
    assert.ok(sql.includes(marker), marker + " must be covered");
  }
});

test("public UI and admin review surfaces include honest Phase 4 states", () => {
  assert.match(server, /"\/partners", "\/alumni", "\/opportunities"/);
  assert.match(indexHtml, /id="partners" data-page="partners"/);
  assert.match(indexHtml, /id="alumni" data-page="alumni"/);
  assert.match(indexHtml, /id="opportunities" data-page="opportunities"/);
  assert.match(indexHtml, /No verified partners yet/);
  assert.match(indexHtml, /No verified alumni yet/);
  assert.match(indexHtml, /No approved opportunities yet/);
  assert.match(indexHtml, /Admin-reviewed alumni/);
  assert.match(indexHtml, /Verified partner opportunity/);
  assert.match(indexHtml, /never pay a fee/i);
  assert.match(adminHtml, /data-tab="partners"/);
  assert.match(adminHtml, /data-tab="partnerannouncements"/);
  assert.match(adminHtml, /data-tab="alumni"/);
  assert.match(adminHtml, /data-tab="opportunities"/);
  assert.match(adminHtml, /aPartnerList/);
  assert.match(adminHtml, /aPartnerMemberList/);
  assert.match(adminHtml, /data-pann-action/);
  assert.match(adminHtml, /data-alumni-action/);
  assert.match(adminHtml, /data-opp-action/);
});
