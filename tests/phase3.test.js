const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const server = fs.readFileSync(path.join(root, "backend", "server.js"), "utf8");
const phase3Sql = fs.readFileSync(path.join(root, "backend", "migrations", "20261118_phase3_accommodation_services.sql"), "utf8");
const indexHtml = fs.readFileSync(path.join(root, "index.html"), "utf8");
const adminHtml = fs.readFileSync(path.join(root, "backend", "public", "admin.html"), "utf8");

test("Phase 3 migration is additive and never removes existing data", () => {
  assert.match(phase3Sql, /create table if not exists public\.campus_listings/);
  assert.match(phase3Sql, /create table if not exists public\.listing_requests/);
  assert.doesNotMatch(phase3Sql, /drop table/i);
  assert.doesNotMatch(phase3Sql, /delete from/i);
  assert.doesNotMatch(phase3Sql, /truncate/i);
});

test("public listing directory only exposes approved listings and no private evidence", () => {
  assert.match(phase3Sql, /create or replace view public\.campus_listing_directory/);
  assert.match(phase3Sql, /where l\.status = 'approved'/);
  assert.match(phase3Sql, /and coalesce\(p\.visibility, 'public'\) <> 'private'/);
  const view = phase3Sql.slice(
    phase3Sql.indexOf("create or replace view public.campus_listing_directory"),
    phase3Sql.indexOf("revoke all on public.campus_listing_directory")
  );
  assert.doesNotMatch(view, /email/i);
  assert.doesNotMatch(view, /source_url/i);
  assert.doesNotMatch(view, /admin_note/i);
  assert.doesNotMatch(view, /phone/i);
});

test("listing owners cannot self-approve or self-verify", () => {
  assert.match(phase3Sql, /grant select, insert, update on public\.campus_listings to authenticated/);
  assert.match(phase3Sql, /"create own campus listing"/);
  assert.match(phase3Sql, /"update own campus listing"/);
  assert.match(phase3Sql, /and status = 'pending'\s+and verified = false/);
  assert.match(phase3Sql, /and source = 'Community'/);
  assert.match(phase3Sql, /create or replace function public\.guard_campus_listing_update/);
  assert.match(phase3Sql, /campus_listings_guard_update/);
  assert.match(phase3Sql, /public\.has_role\('super_admin'\) or public\.has_role\('content_admin'\)/);
});

test("listing requests are participant-scoped and cannot be repointed", () => {
  assert.match(phase3Sql, /create policy "read own listing requests"/);
  assert.match(phase3Sql, /requester_id = auth\.uid\(\) or owner_id = auth\.uid\(\)/);
  assert.match(phase3Sql, /create unique index if not exists listing_requests_one_pending_idx/);
  assert.match(phase3Sql, /create or replace function public\.public_listing_owner/);
  assert.match(phase3Sql, /owner_id = public\.public_listing_owner\(listing_id\)/);
  assert.match(phase3Sql, /create or replace function public\.lock_listing_request_participants/);
  assert.match(phase3Sql, /listing_requests_lock_participants/);
});

test("accepted listing requests unlock messaging in both SQL and the API", () => {
  assert.match(phase3Sql, /from listing_requests r/);
  assert.match(phase3Sql, /r\.status = 'accepted'/);
  assert.match(phase3Sql, /r\.owner_id = other/);
  assert.match(server, /acceptedListingRequest/);
  assert.match(server, /!ok && !mentorOk && !listingOk/);
});

test("Phase 3 API routes and moderation surfaces are wired", () => {
  for (const route of [
    "/api/listings", "/api/listings/me", "/api/listings/:id/requests",
    "/api/listing-requests/mine", "/api/listing-requests/:id/respond",
    "/api/admin/listings", "/api/admin/listing-requests"
  ]) {
    assert.ok(server.includes(route), route + " must exist");
  }
  assert.match(server, /"\/housing", "\/accommodation"/);
  assert.match(server, /campus_listing_directory/);
  assert.match(server, /phase3DbError/);
  assert.match(indexHtml, /id="housing" data-page="housing"/);
  assert.match(indexHtml, /href="\/housing"/);
  assert.match(indexHtml, /Accommodation &amp; services/);
  assert.match(adminHtml, /data-tab="listings"/);
  assert.match(adminHtml, /aListingList/);
  assert.match(adminHtml, /data-listing-action/);
});
