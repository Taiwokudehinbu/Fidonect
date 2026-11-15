# Fidonect — Connect. Know. Prepare. Belong.

**Production:** https://fidonect.vercel.app/ (web app + API, Supabase data)

Fidonect helps Nigerian students connect before resumption. It combines a
searchable directory of **588 institutions**, student profiles and connections,
private messaging, community posts, honest AI-labelled campus guidance, and a
public **Scholarships** directory that only links to official sources.

## What is live

- Email/password auth (Supabase Auth), email confirmation and password reset
- Profiles, visibility controls, and profile photo upload
- Institution directory, faculty/department/programme pages, hub info
- Student discovery, connection requests, accepted-connection messaging
- Community posts, reports, admin dashboard
- Scholarships (Phase 1): filters, pagination, verification labels, bookmarks
- Mobile bottom navigation plus a More menu; `/profile` account page

Scholarships and the security hardening need the SQL migrations in
`backend/migrations/` applied once. Until then `/scholarships` deliberately
shows an honest setup/empty state instead of placeholder content.

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
4. Seed the first admin with `20261114_seed_admin_role.example.sql`.

The migrations are additive and idempotent: no tables are dropped, no users or
institutions are deleted, and no content is invented. After applying them,
verify login, photo upload, connections, messages, admin access, and the
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
- No copyrighted book/research hosting without permission; link to legitimate sources.
- No betting, gambling, or cash prizes in future Games modules.
- Reports and moderation use Supabase RLS; secrets never ship to the browser.

## Roadmap

- Phase 1 (done): core connection + communities + AI-honesty labels + scholarships shell
- Phase 2: mentorship verification, richer verified institution info, improved Fido (RAG)
- Phase 3: accommodation, marketplace, services
- Phase 4: institution partnerships, alumni, recruitment

Privacy, safety, and responsible-AI requirements: `PRD.md` §§22–28.
