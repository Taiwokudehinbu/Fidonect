# Phase 4 Plan — Institution Partnerships, Alumni, Recruitment

Status: **Approved by the owner. Phase 4A runtime code, migration, tests, admin surfaces, and rollout documentation are implemented. The migration still needs to be applied to Supabase production and verified end-to-end.**

Phase 3A is live and verified. Phase 3B (marketplace, bookings, payments) remains deferred per PRD §69.

## 1. Recommendation

Build **Phase 4A** as one additive release with three limited pillars:

1. **Institution partners** — admin-verified partner accounts, public partner pages, and admin-approved partner announcements.
2. **Alumni** — opt-in, admin-reviewed alumni profiles with a public directory and existing connection-based contact.
3. **Recruitment** — an admin-approved opportunity board for verified institution partners, with external official application links only.

Phase 4A deliberately excludes billing, partner analytics, CV uploads, in-app applications, automated screening, and general employer self-service. Those belong to Phase 4B or later.

## 2. Non-negotiable guardrails

- Additive and idempotent migrations only. No table, column, user, institution, connection, message, or existing content is dropped.
- No resets, reseeding, or invented partner/alumni/opportunity content. Every new table starts empty.
- Public reads go through filtered views. Public views never expose email, phone, private verification evidence, admin notes, private source URLs, CVs, or raw student data.
- A badge is shown only after a real admin action:
  - `Official partner` only when an admin verifies the partner record.
  - `Admin-reviewed alumni` only when an admin verifies the alumni profile.
  - `Verified partner opportunity` only when the partner is verified and the opportunity is admin-approved.
- Self-edits reset review state and clear admin-only fields through database triggers, even if a client bypasses the API.
- No direct partner self-verification, no self-invites, and no partner editing of approved content.
- Existing admin roles stay unchanged: `super_admin`, `content_admin`, `moderator`. Partner access is scoped separately by institution.
- Service-role credentials stay server-side. New tables use least-privilege grants: anon reads only public views; authenticated users cannot delete or truncate.
- Fido must not invent partner, alumni, or recruitment facts. It may only cite admin-approved stored rows if Phase 4 content is added to Fido later.
- No payments, subscriptions, invoices, ads, bookings, or transactions in Phase 4A.

## 3. Phase 4A scope

### 3.1 Institution partners

**Purpose:** Give verified institution partners a clearly labelled public presence and a controlled way to publish time-sensitive updates.

**Included**
- Admin-created partner record for one institution.
- Admin-managed partner membership. A partner member is a normal Fidonect user scoped to one institution.
- Public partner directory and partner detail page.
- Partner members can submit announcements for admin approval.
- Admin can approve, reject, pause, or edit partner content.
- Admin verification is written to `admin_audit_log`.

**Partner onboarding**
- Phase 4A onboarding is **admin-initiated**: Fidonect confirms the institution relationship, then creates the partner record and attaches a member account.
- No self-serve partnership application in Phase 4A. That avoids fake institution requests and keeps the first release small.
- A partner cannot add or remove members. Only an admin can do that.

**Public labels**
- `Official partner` only for verified, listed partners.
- `Official partner announcement` only for approved announcements from a verified partner.
- Partner announcements do **not** replace the existing admin-managed institution hub pages. They are separate, time-bound updates.

**Excluded**
- Partner billing, subscriptions, analytics dashboards, lead generation, or student-data access.
- Partner editing of `hub_pages`, institution location, or other institution directory fields.
- Partner direct messaging to students.

### 3.2 Alumni

**Purpose:** Let alumni opt in to a trusted directory and help students without exposing private contact details.

**Included**
- Alumni profile application with institution, graduation year, programme details, optional current role/organisation/industry/location, bio, help areas, and opt-in flags.
- Admin review of alumni evidence. Evidence is private.
- Public directory of verified, listed alumni.
- Filtering by institution, graduation year, industry, and whether the alumnus is open to mentoring or referrals.
- Contact through the existing connection request flow. Accepted connections already unlock messaging.

**Privacy rules**
- Public alumni view exposes no email, phone, verification detail, admin note, or exact private address.
- `listed` defaults to false; the alumnus must explicitly opt in.
- A private profile is never listed.
- Self-edits reset the profile to `pending`, clear verification fields, and require admin review again.

**Excluded**
- Degree verification claims beyond the evidence reviewed by an admin.
- Public contact details, donation flows, alumni marketplace, or paid alumni services.
- A new messaging gate. Alumni contact uses the existing connection system only.

### 3.3 Recruitment

**Purpose:** Surface a small number of real, admin-approved opportunities without turning Fidonect into a job marketplace.

**Included**
- Verified institution partners can submit opportunities for admin approval.
- Opportunity types: internship, graduate role, job, volunteer.
- Fields: title, organisation, description, location, work mode, eligibility, deadline, official application URL.
- Public opportunity board with search and filters.
- External application link only. Fidonect does not process applications.

**Trust and safety rules**
- Only verified, active partner members can submit opportunities.
- Every opportunity needs admin approval before publication.
- Public view excludes admin notes, private source URLs, and poster email.
- Expired or closed opportunities disappear from public view.
- The UI warns users to verify the employer and never pay for a job.

**Excluded**
- CV uploads, in-app applications, applicant tracking, candidate scoring, automated screening, or AI hiring decisions.
- General employer self-service. Phase 4A recruitment is limited to verified institution partners.
- Payments, paid promotion, sponsored placement, or recruitment fees.

## 4. Roles and permissions

| Actor | Phase 4A permissions |
|---|---|
| Visitor | Read public partner pages, announcements, alumni directory, and opportunity board through filtered views. |
| Signed-in user | Apply for an alumni profile; request connections with alumni; read own alumni application. |
| Partner member | Read own partner record and own institution's submissions; create and edit own **pending** announcements/opportunities. Cannot verify, approve, delete, add members, or edit approved content. |
| Moderator | Read reports/moderation surfaces. Does not verify partners or alumni. |
| Content admin | Review partner announcements, alumni profiles, and opportunities. Can approve/reject/pause content. |
| Super admin | Verify/pause partners, manage partner members, review all Phase 4 content, manage alumni verification. |
| Server admin | Uses the admin JWT only; no service-role key in the browser. |

Partner membership is scoped by `institution_id`. A partner member for one institution cannot act for another.

## 5. Data model

All tables are new. No existing table is altered except optional additive indexes if needed.

### 5.1 `institution_partners`

One row per institution partner account.

- `institution_id` — primary key, references `institutions`.
- `status` — `pending`, `verified`, `rejected`, `paused`.
- `public_summary` — admin-reviewed public summary, optional.
- `official_url` — public official website, optional.
- `verification_method` — `official_email`, `official_letter`, `official_website`, `other`.
- `verification_detail` — private admin evidence.
- `admin_note` — private.
- `listed` — public visibility opt-in, default false.
- `verified_at`, `verified_by`.
- `created_at`, `updated_at`.

### 5.2 `institution_partner_members`

Maps user accounts to one partner institution.

- `institution_id` — references `institution_partners`.
- `user_id` — references `profiles`.
- `member_role` — `owner` or `editor`.
- `status` — `active` or `revoked`.
- `created_at`, `updated_at`.
- Primary key: `(institution_id, user_id)`.

Only admins create or revoke memberships.

### 5.3 `partner_announcements`

- `id`
- `institution_id` — references `institution_partners`.
- `author_id` — references `profiles`.
- `title`, `body`, `category`, `link_url`.
- `expires_at` — optional.
- `status` — `pending`, `approved`, `rejected`, `paused`.
- `admin_note` — private.
- `reviewed_at`, `reviewed_by`.
- `created_at`, `updated_at`.

Partner members may insert pending rows and edit their own pending rows. Approved rows are immutable to partners.

### 5.4 `alumni_profiles`

One row per alumni applicant.

- `user_id` — primary key, references `profiles`.
- `institution_id`, `institution_name`.
- `graduation_year`.
- `faculty`, `department`, `programme` — optional.
- `current_role`, `current_organisation`, `industry`, `location` — optional.
- `bio`.
- `help_areas` — up to 8 short items.
- `open_to_mentoring`, `open_to_referrals` — booleans.
- `verification_method` — `institutional_email`, `alumni_id`, `other`.
- `verification_detail` — private.
- `listed` — default false.
- `status` — `pending`, `verified`, `rejected`, `paused`.
- `verified_at`, `verified_by`.
- `admin_note` — private.
- `created_at`, `updated_at`.

### 5.5 `recruitment_opportunities`

- `id`
- `institution_id` — references `institution_partners`.
- `posted_by` — references `profiles`.
- `title`, `organisation`, `description`, `location`, `work_mode`.
- `role_type` — `internship`, `graduate`, `job`, `volunteer`.
- `eligibility` — optional.
- `deadline` — optional.
- `application_url` — public official application link.
- `source_url` — private admin evidence.
- `status` — `pending`, `approved`, `rejected`, `closed`.
- `admin_note` — private.
- `reviewed_at`, `reviewed_by`.
- `created_at`, `updated_at`.

No `applications` table. No CV column. No payment column.

### 5.6 Public views

- `institution_partner_directory`
  - verified and listed partners only
  - institution name/location/ownership/kind, public summary, official URL, verified date
  - no verification detail, admin note, or member email
- `partner_announcement_directory`
  - approved, non-expired announcements from verified partners
  - title, body, category, link, institution name, published/expiry dates
  - no admin note, author email, or private source
- `alumni_directory`
  - verified, listed, non-private profiles
  - name, photo, institution, graduation year, programme, current role/organisation/industry/location, bio, help areas, opt-in flags, verified date
  - no email, verification detail, admin note, or private profile data
- `recruitment_opportunity_directory`
  - approved, open, non-expired opportunities from verified partners
  - title, organisation, description, location, work mode, role type, eligibility, deadline, application URL, institution name
  - no admin note, private source URL, or poster email

## 6. API boundaries

### Public

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/partners` | List verified, listed partners. |
| GET | `/api/partners/:institutionId` | Read one public partner page. |
| GET | `/api/partner-announcements` | List approved, non-expired announcements. |
| GET | `/api/alumni` | List verified, listed alumni with filters. |
| GET | `/api/opportunities` | List approved, open opportunities with filters. |

Public endpoints return `setupRequired: true` with empty arrays before the Phase 4 migration is applied. They must never return private fields.

### Signed-in user

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/alumni/me` | Read own alumni application. |
| POST | `/api/alumni/apply` | Create or update own alumni application; always resets to pending. |
| POST | `/api/connections/request` | Existing route used to contact an alumnus. |

### Partner member

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/partner/me` | Read own partner membership and partner status. |
| GET | `/api/partner/announcements` | Read own institution's submissions. |
| POST | `/api/partner/announcements` | Submit a pending announcement. |
| PATCH | `/api/partner/announcements/:id` | Edit own pending announcement. |
| GET | `/api/partner/opportunities` | Read own institution's submissions. |
| POST | `/api/partner/opportunities` | Submit a pending opportunity. |
| PATCH | `/api/partner/opportunities/:id` | Edit own pending opportunity. |

### Admin

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/admin/partners` | List partner accounts and statuses. |
| POST | `/api/admin/partners` | Create a partner record for an institution. |
| PATCH | `/api/admin/partners/:institutionId` | Verify, reject, pause, or update a partner. |
| GET | `/api/admin/partner-members` | List memberships. |
| POST | `/api/admin/partner-members` | Attach a user to a partner by account email. |
| PATCH | `/api/admin/partner-members/:institutionId/:userId` | Change role or revoke membership. |
| GET | `/api/admin/partner-announcements` | Review partner announcements. |
| PATCH | `/api/admin/partner-announcements/:id` | Approve, reject, pause, or edit. |
| GET | `/api/admin/alumni` | Review alumni applications. |
| PATCH | `/api/admin/alumni/:userId` | Verify, reject, pause, or edit. |
| GET | `/api/admin/opportunities` | Review opportunities. |
| PATCH | `/api/admin/opportunities/:id` | Approve, reject, close, or edit. |
| GET | `/api/admin/stats` | Add Phase 4 counts. |

All admin routes use the existing `requireAdmin` middleware and write to `admin_audit_log` on state changes.

## 7. UI boundaries

### Public web app

- `/partners` — verified partner directory, partner detail via `?institution_id=`, and approved announcements.
- `/alumni` — verified alumni directory, filters, and the alumni application form.
- `/opportunities` — approved opportunity board and partner submission form when signed in as a partner.
- Empty states must be honest:
  - “No verified partners yet.”
  - “No verified alumni yet.”
  - “No approved opportunities yet.”
- Add links from the home page and footer. Add top-nav links only if the layout remains usable on mobile.
- Every public badge must come from a database flag set by an admin action.

### Partner tools

- A signed-in partner sees a “Partner tools” card on `/partners` or `/opportunities`.
- Partner can submit announcements/opportunities and see pending/rejected/approved status.
- No partner member management UI in Phase 4A.

### Admin dashboard

Add four tabs to `backend/public/admin.html`:

- **Partners** — create/verify/pause partner accounts, attach/revoke members.
- **Partner announcements** — review and publish/reject/pause.
- **Alumni** — review evidence, verify/reject/pause, edit public summary, clear admin fields on self-edit.
- **Opportunities** — review, approve/reject/close.

Reuse existing admin card, badge, and audit patterns.

## 8. Migration plan

New file: `backend/migrations/20261120_phase4_partnerships_alumni_recruitment.sql`

Order: after `20261118_phase3_accommodation_services.sql`.

The migration must:

1. Create the five new tables with `if not exists`.
2. Add indexes for public filters and review queues.
3. Enable RLS on every new table.
4. Revoke all from `anon` and `authenticated`, then grant only what each role needs.
5. Create partner-membership and partner-verification helper functions as `security definer` with fixed `search_path`.
6. Create insert/update policies that force `pending` state and prevent self-verification.
7. Create guard triggers that reset review state on self-edit and lock ownership fields.
8. Create the four public views with `security_invoker = false`.
9. Grant public view reads to `anon` and `authenticated`; grant no base-table reads to `anon`.
10. Add verification queries in comments.

No existing table is modified. No data is inserted.

## 9. Verification and test plan

### Static tests (`tests/phase4.test.js`)

- Migration is additive: no `drop table`, no `delete from`, no destructive SQL.
- RLS enabled on all new tables.
- Anon cannot read base tables; anon can read public views.
- Authenticated cannot delete or truncate new tables.
- Public view definitions exclude email, phone, verification detail, admin note, private source URL, and CV fields.
- Partner/alumni self-verification is blocked.
- Approved content cannot be edited by partners.
- Partner memberships are admin-managed only.
- API routes and admin guards are wired.
- No payments, applications, CV, or billing tables are created.

### SQL transaction test

Run in a rolled-back production transaction:

1. Admin creates a partner and attaches a member.
2. Partner member submits an announcement and an opportunity.
3. Partner attempts self-approval and fails or resets to pending.
4. Admin approves both.
5. Public views show the approved rows and hide private fields.
6. Alumni user applies; self-edit resets to pending; self-verification fails.
7. Admin verifies alumni; public directory shows the profile without private evidence.
8. Rollback leaves all counts unchanged.

### Production smoke

Add read-only checks:

- `/api/partners` returns an empty array with `setupRequired: false` after migration.
- `/api/partner-announcements` returns an empty array.
- `/api/alumni` returns an empty array.
- `/api/opportunities` returns an empty array.
- Admin routes return 401/403 without an admin token.
- Existing Phase 1–3 smoke checks still pass.

### Browser checks

- `/partners`, `/alumni`, and `/opportunities` show honest empty states.
- No “verified” badge appears without an admin action.
- Mobile layout remains usable.

## 10. Rollout

1. Take a verified backup or record current counts.
2. Apply the Phase 4A migration in Supabase.
3. Verify preserved counts: 588 institutions, 9 profiles, 8 connections, 2 conversations, 4 participants, 12 messages, 1 user_role, 1 super_admin.
4. Verify all five new tables start at 0.
5. Verify RLS, grants, views, and helper functions.
6. Run the rolled-back SQL flow test
   `backend/migrations/tests/phase4_rollback_test.sql` (it ends in `ROLLBACK`).
7. Deploy runtime code.
8. Run tests and production smoke.
9. Create the first partner only after a real admin verification. No sample partner, alumnus, or opportunity is seeded.

**Rollback:** redeploy the previous code. Leave additive tables and empty data in place. Do not drop tables or delete rows. The old code ignores the new tables.

## 11. Explicitly deferred to Phase 4B or later

- Partner billing, subscriptions, invoices, and paid plans.
- Partner analytics or any raw student-data access.
- General employer/recruiter self-service and recruiter verification.
- CV uploads, in-app applications, applicant tracking, and automated screening.
- Paid promotion, sponsored opportunities, or recruitment fees.
- Partner self-invite or self-serve partner applications.
- Partner editing of institution hub pages.
- Alumni donations, marketplace, or paid services.
- New messaging gates or direct messaging without an accepted connection.
- Push notifications and email digests.
- Public phone numbers or exact private addresses.

## 12. Decisions needed before implementation

Recommended defaults are shown first.

1. **Scope:** Build all three pillars in Phase 4A (partners, alumni, recruitment) as limited above. Alternative: partners + alumni first, recruitment later.
2. **Alumni visibility:** Verified-only public directory. Alternative: allow self-declared “Community alumni” with no badge.
3. **Recruitment model:** Verified institution partners only, external application links only. Alternative: open employer self-service.
4. **Alumni contact:** Existing connection request only. Alternative: a new alumni request/messaging gate.
5. **Partner onboarding:** Admin-initiated only. Alternative: self-serve partnership applications.
6. **Billing/analytics:** Excluded from Phase 4A. Alternative: add paid partner plans or analytics now.

## 13. Acceptance criteria

Phase 4A is complete when:

- All existing data and Phase 1–3 features remain intact.
- New tables are empty after migration.
- Public views expose no private fields.
- Admin verification is required for every partner, alumni, announcement, and opportunity badge.
- Partners cannot self-verify, self-invite, edit approved content, or act for another institution.
- Alumni self-edits reset review state.
- Recruitment has no CV upload, in-app application, payment, or automated decision.
- Static tests, SQL transaction tests, and production smoke pass.
- The public empty states are honest and the admin review flow is usable.
