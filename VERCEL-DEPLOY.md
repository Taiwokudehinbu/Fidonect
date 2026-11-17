# Fidonect → Vercel deployment guide

**Production:** https://fidonect.vercel.app/

Render remains deployed at https://fidonect-api.onrender.com/ as a fallback until
final verification is complete. For rollback, point DNS/links back to Render and
delete the Vercel project; Supabase data is untouched.

---

## 1. Current architecture

| Item | Reality |
|---|---|
| Frontend | Single `index.html` (vanilla JS, no build step), served by Express |
| Backend | Express 4 in `backend/server.js`, one serverless function on Vercel |
| Database | **Supabase PostgREST via `@supabase/supabase-js`** (not Prisma) |
| Auth | Supabase Auth (email/password, JWT bearer tokens) |
| Uploads | Supabase Storage (`avatars` bucket), not local disk |
| Prisma | `backend/prisma/schema.prisma` is a legacy SQLite scaffold; `server.js` never imports it |
| Background jobs | None. The in-memory rate limiter resets between serverless instances |
| Required env vars | `SUPABASE_URL`, `SUPABASE_ANON_KEY` |
| Optional env vars | `ADMIN_EMAILS`, `APP_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `CORS_ORIGINS` |

The Phase 0.1 security, Phase 1 scholarship, and Phase 2 mentorship/hub/Fido
schemas are **additive SQL migrations**. Existing auth, profiles, connections,
messages, institutions, and photo upload continue to work before and after they
are applied. Phase 2 content stays empty or unverified until an admin reviews it.

---

## 2. Files that matter for deployment

| File | Purpose |
|---|---|
| `api/index.js` | Serverless entry: `module.exports = require("../backend/server.js")` |
| `backend/server.js` | Express API, static app shell, scholarship/mentor/hub/admin routes |
| `backend/lib/validation.js` | Query/body validation shared with tests |
| `backend/public/admin.html` | Protected admin dashboard (overview, scholarships, mentors, institution info) |
| `backend/public/sw.js` | Service worker (`fidonect-v13`) |
| `index.html` | Web app shell, navigation, profile, scholarships, mentors, Fido UI |
| `package.json` (root) | Vercel dependency manifest |
| `vercel.json` | One function, all routes, includes app shell/public files |
| `.vercelignore` | Keeps Android/APK/backups/prisma/seed out of the upload |
| `.github/workflows/ci.yml` | `npm ci`, syntax checks, and tests on Node 22 |

Root and `backend/package.json` both list runtime dependencies. If you add one,
add it to both. `backend/package.json` is still used by Render.

---

## 3. Environment variables (Vercel)

Project → Settings → Environment Variables. Add for **Production, Preview, and
Development**.

| Name | Value | Required |
|---|---|---|
| `SUPABASE_URL` | `https://jwtpjgpucblrhlrdgzqi.supabase.co` | Yes |
| `SUPABASE_ANON_KEY` | existing anon / publishable key | Yes |
| `ADMIN_EMAILS` | comma-separated admin emails | Optional if a `user_roles` row is seeded |
| `APP_URL` | `https://fidonect.vercel.app` | Recommended (password-reset links) |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase service-role key | Optional; server-side only |
| `CORS_ORIGINS` | comma-separated extra origins | Optional; production Vercel and localhost are built in |

Do **not** put the anon or service-role key in `index.html`. Both stay
server-side. Never commit a key or print one in a terminal transcript.

Admin access accepts either an email in `ADMIN_EMAILS` or a seeded `user_roles`
row (`super_admin`, `content_admin`, `moderator`). Public scholarship reads use
the anon client; admin writes use `SUPABASE_SERVICE_ROLE_KEY` when configured,
otherwise the verified admin JWT plus database RLS.

CORS is an explicit allowlist. Arbitrary `*.vercel.app` origins are not trusted;
add preview origins through `CORS_ORIGINS` if needed.

### Phase 1 / Phase 2 database migrations (required once)

Scholarships, mentors, verified institution info, Fido feedback, and the security
hardening need SQL applied in Supabase. Follow `backend/migrations/README.md`:

1. Take a verified backup first (`node scripts/backup-supabase.mjs` after
   setting `SUPABASE_SERVICE_ROLE_KEY` locally, or use a dashboard backup).
2. Run `backend/migrations/20261114_phase0_security.sql`.
3. Run `backend/migrations/20261114_phase1_scholarships.sql`.
4. Run `backend/migrations/20261116_phase2_mentorship_hubs_fido.sql`.
5. Seed the first admin with `20261114_seed_admin_role.example.sql`.
6. Verify login, photo upload, connections, messages, admin access, mentor
   apply/verify/request, hub verified/community labels, Fido feedback, and all
   **588 institutions**.
7. Redeploy only if you changed environment variables.

Until these migrations are applied, `/scholarships` and `/mentors` show honest
empty setup states, admin writes return a setup message, and Fido falls back to
AI-labelled guidance. Existing features keep working because the API falls back
to the old profile and hub columns where needed.

---

## 4. Deploy

1. Push the prepared files to GitHub.
2. Vercel imports `Taiwokudehinbu/Fidonect` with **Root Directory `.`**,
   Framework Preset **Other**, no build command, and the default install command.
3. Add the environment variables above, then deploy.
4. In **Supabase → Authentication → URL Configuration**:
   - Site URL: `https://fidonect.vercel.app`
   - Redirect URLs: add `https://fidonect.vercel.app/**`
   - Keep the old Render URL during the transition.
5. Do **not** delete or suspend Render until final verification passes.

### CLI alternative

```powershell
npx vercel login
npx vercel            # preview
npx vercel --prod     # production
```

---

## 5. Post-deploy verification

```powershell
$base = "https://fidonect.vercel.app"
Invoke-RestMethod "$base/health"
Invoke-RestMethod "$base/api/status"                 # institutions must equal 588
$i = Invoke-RestMethod "$base/api/institutions"; $i.Count
Invoke-WebRequest "$base/" -UseBasicParsing | Select-Object StatusCode
Invoke-WebRequest "$base/messages" -UseBasicParsing | Select-Object StatusCode
Invoke-WebRequest "$base/scholarships" -UseBasicParsing | Select-Object StatusCode
Invoke-WebRequest "$base/mentors" -UseBasicParsing | Select-Object StatusCode
Invoke-WebRequest "$base/profile" -UseBasicParsing | Select-Object StatusCode
Invoke-WebRequest "$base/admin" -UseBasicParsing | Select-Object StatusCode
Invoke-RestMethod "$base/api/mentors"
npm run smoke
```

Then in the app: register → login → connections → Message → send/reply →
unread badge → profile photo upload → scholarships setup state (before
migrations) or filters/bookmarks (after migrations) → mentor application →
admin verify → mentor request → accept → Message → admin hub verification
and Fido feedback → admin login → institution search/pagination.

Expected: **588 institutions**, unchanged existing data, honest empty Phase 2
states until admins add content, and no console errors.

---

## 6. Limits and residual hardening

- Vercel Hobby is free for personal, non-commercial projects. Commercial use
  requires a paid plan.
- Functions are stateless; messages, conversations, and reads are in Supabase.
- Supabase access is over HTTPS/PostgREST, so cold starts do not exhaust a
  Postgres pool.
- The app still uses inline scripts/styles, so a strict CSP is deferred. The API
  already sends anti-sniffing, frame, referrer, and permissions headers and uses
  the CORS allowlist.
- Android source points at Vercel and supports photo upload, JS dialogs, and
  external links. Installed users only receive those fixes after installing a
  rebuilt APK; a web deploy cannot update an old APK.
- CI runs syntax checks and the Node test suite; `npm run smoke` is read-only.
