# Fidonect — Connect. Know. Prepare. Belong.

**Production:** https://fidonect.vercel.app/ (web app + API, Supabase data)

Fidonect helps Nigerian students connect before resumption. It combines a
searchable directory of **588 institutions**, student profiles and connections,
private messaging, community posts, honest AI-labelled campus guidance, a
public **Scholarships** directory that only links to official sources, and an
admin-reviewed **Mentors** directory for student-to-student guidance.

## What is live

- Email/password auth (Supabase Auth), email confirmation and password reset
- Profiles, visibility controls, and profile photo upload
- Institution directory, faculty/department/programme pages, richer hub info
- Student discovery, connection requests, accepted-connection messaging
- Community posts, reports, admin dashboard
- Scholarships (Phase 1): filters, pagination, verification labels, bookmarks
- Mentors (Phase 2): applications, admin verification, verified directory,
  mentorship requests, and accepted-request messaging
- Verified institution info (Phase 2): official/community source labels,
  clearance/admission/registration/date/transport/facility blocks, FAQs, and
  official links; only admin-verified pages carry a verified label
- Improved Fido (Phase 2): verified-hub retrieval, source citations, FAQ hits,
  honest Official/Community/AI labels, and helpful/correction feedback
- Accommodation & services (Phase 3A): admin-approved community listings,
  optional source verification, in-app contact requests, and accepted-request
  messaging — no bookings, reservations, payments, or marketplace transactions
- Mobile bottom navigation plus a More menu; `/profile` account page

Phase 1, Phase 2, and Phase 3A need the additive SQL migrations in
`backend/migrations/` applied once. Until then `/scholarships`, `/mentors`, and
`/housing` deliberately show honest setup/empty states instead of placeholder
content.

## Run locally

Requirements: Node 22+, a Supabase project, and `backend/.env` containing
`SUPABASE_URL` and `SUPABASE_ANON_KEY`. Never commit that file.

```sh
npm install
npm start
# open http://localhost:3000/health
```

`npm start` runs `backend/server.js`; it loads `backend/.env` explicitly, so it
works from the repository root. Optional server-side variables:

- `ADMIN_EMAILS` — comma-separated admin account emails
- `APP_URL` — public URL used in password-reset links
- `SUPABASE_SERVICE_ROLE_KEY` — optional service-role key for admin writes and backups
- `CORS_ORIGINS` — extra allowed origins (official Vercel/localhost are built in)

The service-role key is server-side only. Admin routes fall back to the verified
admin JWT plus database `user_roles` policies when it is absent.

## Tests and checks

```sh
npm test                 # validation + static security regression tests
node --check backend/server.js
npm run smoke            # read-only checks against production
FIDONECT_BASE=http://localhost:3000 npm run smoke
```

CI runs the syntax checks and tests on Node 22 (`.github/workflows/ci.yml`).

## Database migrations

Read `backend/migrations/README.md` first. The order is:

1. Take a verified backup (`node scripts/backup-supabase.mjs` or dashboard backup).
2. `backend/migrations/20261114_phase0_security.sql`
3. `backend/migrations/20261114_phase1_scholarships.sql`
4. `backend/migrations/20261116_phase2_mentorship_hubs_fido.sql`
5. `backend/migrations/20261118_phase3_accommodation_services.sql`
6. Seed the first admin with `20261114_seed_admin_role.example.sql`.

The migrations are additive and idempotent: no tables are dropped, no users or
institutions are deleted, and no content is invented. After applying them,
verify login, photo upload, connections, messages, admin access, mentor
application/verification, hub verification labels, Fido feedback, listing
approval/source verification, accepted listing-request messaging, and the
588-institution directory.

## Deploy

- **Vercel** (production): `api/index.js` imports `backend/server.js`; see
  `VERCEL-DEPLOY.md` for env vars and verification.
- **Render** (`render.yaml`) remains a supported fallback until final Vercel
  verification.
- **Android** source in `android/` points at the Vercel URL and supports photo
  upload, JS dialogs, and external links. Installed users only receive these
  fixes after a rebuilt APK is installed.

## Trust, safety, and content rules

- No invented scholarships, requirements, deadlines, or unverified news.
- Scholarship listings must link to the official source; admins mark them verified.
- A mentor badge requires a real admin review; public listings never expose email
  or private verification evidence.
- Institution info is labelled `Official` only when an admin checked its source
  and marked the hub verified; otherwise it is labelled `Community`.
- Accommodation and service listings are admin-approved before publication.
  A “source checked” badge requires a real admin review. Public listings never
  expose owner email, exact private addresses, phone numbers, or source URLs;
  contact happens through in-app requests.
- Fidonect does not take bookings, reservations, or payments for housing or
  services. Students must inspect before paying and never send money to a
  personal account without verifying the property or provider.
- No copyrighted book/research hosting without permission; link to legitimate sources.
- No betting, gambling, or cash prizes in future Games modules.
- Reports and moderation use Supabase RLS; secrets never ship to the browser.

## Roadmap

- Phase 1 (done): core connection + communities + AI-honesty labels + scholarships
- Phase 2 (done): verified mentors, verified institution info, improved Fido with citations/feedback
- Phase 3A (implemented; apply its migration before use): admin-approved
  accommodation + campus-service discovery, source verification, and in-app
  contact requests; no bookings or payments
- Phase 3B (deferred): marketplace and any transaction/payment flow (out of the
  initial scope per PRD §69)
- Phase 4: institution partnerships, alumni, recruitment

Privacy, safety, and responsible-AI requirements: `PRD.md` §§22–28.
