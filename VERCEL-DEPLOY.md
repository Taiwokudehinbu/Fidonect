# Fidonect → Vercel migration guide

Status: **code prepared locally and tested; deployment not yet run** (needs your Vercel account).
Render stays untouched until you verify Vercel.

---

## 1. What the audit found

| Item | Reality |
|---|---|
| Frontend | Single `index.html` (vanilla JS, no build step) + `styles.css`, served by Express |
| Backend | Express 4 in `backend/server.js`, 824 lines, ~40 routes |
| Database | **Supabase PostgREST via `@supabase/supabase-js`** (not Prisma) |
| Auth | Supabase Auth (email/password, JWT bearer tokens) |
| Prisma | `backend/prisma/schema.prisma` is a **legacy SQLite scaffold**; `server.js` never imports it, and `backend/fidonect.db` is unused. Nothing to migrate. |
| Uploads | Photos go to **Supabase Storage** (`avatars` bucket), not local disk |
| Background jobs | None. The only in-memory state is a best-effort message rate limiter, which resets on restart (already true on Render). |
| Env vars actually used | `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `ADMIN_EMAILS`, optional `APP_URL` |
| Not used | `DATABASE_URL`, service-role key, JWT secret, Prisma migrations |

**No database migration or schema change is required for hosting.** Vercel only changes where Express runs.

---

## 2. Files added/changed for Vercel

| File | Purpose |
|---|---|
| `api/index.js` | Serverless entry: `module.exports = require("../backend/server.js")` |
| `backend/server.js` | Added `if (require.main === module) app.listen(...)` + `module.exports = app`. Render and local behavior unchanged. |
| `package.json` (root) | Vercel dependency manifest (same runtime deps as `backend/package.json`) |
| `vercel.json` | One function, all routes rewritten to it, includes `index.html` + `backend/public/**` |
| `.vercelignore` | Keeps Android/APK/backups/prisma/seed out of the upload |
| `.gitignore` | Ignores `backups/` and `.vercel/` |

`backend/package.json` and `render.yaml` are **unchanged**, so Render keeps deploying exactly as before.

> Dependency note: root `package.json` mirrors the runtime dependencies in `backend/package.json`.
> If you add a runtime dependency later, add it to **both**, or Vercel will fail to resolve it.

---

## 3. Environment variables to add in Vercel

Project → Settings → Environment Variables. Add for **Production, Preview, Development**.

| Name | Value | Required |
|---|---|---|
| `SUPABASE_URL` | `https://jwtpjgpucblrhlrdgzqi.supabase.co` | Yes |
| `SUPABASE_ANON_KEY` | your existing anon / publishable key (same one Render uses) | Yes |
| `ADMIN_EMAILS` | comma-separated admin emails (same as Render) | Yes (for admin) |
| `APP_URL` | `https://<your-vercel-domain>` once known | Recommended (password-reset links) |

Do **not** add `DATABASE_URL`, a service-role key, or a JWT secret — the app does not use them.
Never put the anon key in `index.html`; it stays server-side, as today.

---

## 4. Deploy (dashboard, recommended)

1. Push the prepared files to GitHub **only when you approve** (I have not pushed).
2. Go to <https://vercel.com/new> → sign in with GitHub → **Import** `Taiwokudehinbu/Fidonect`.
3. Settings:
   - Framework Preset: **Other**
   - Root Directory: **`.`** (repo root)
   - Build Command: leave empty
   - Output Directory: leave empty
   - Install Command: leave default (`npm install`)
4. Add the four environment variables above.
5. **Deploy**.
6. Copy the production URL (e.g. `https://fidonect.vercel.app`), then set `APP_URL` to it and redeploy.
7. In **Supabase → Authentication → URL Configuration**:
   - Site URL: `https://<your-vercel-domain>`
   - Redirect URLs: add `https://<your-vercel-domain>/**`
   - Keep the old Render URL in the list during the transition (so nothing breaks).
8. Do **not** delete or suspend Render yet.

### CLI alternative (no Git push needed)

```powershell
npx vercel login          # authorizes this machine (browser/email)
npx vercel                 # preview deploy
npx vercel --prod          # production deploy
```

The CLI uploads the local working tree, so you can test Vercel before pushing to GitHub.

---

## 5. Post-deploy verification (run these)

```powershell
$base = "https://<your-vercel-domain>"
Invoke-RestMethod "$base/health"
Invoke-RestMethod "$base/api/status"                 # institutions must equal 588
$i = Invoke-RestMethod "$base/api/institutions"; $i.Count   # must be 588
Invoke-WebRequest "$base/" -UseBasicParsing | Select-Object StatusCode
Invoke-WebRequest "$base/messages" -UseBasicParsing | Select-Object StatusCode
Invoke-WebRequest "$base/admin" -UseBasicParsing | Select-Object StatusCode
```

Then in the app: register → login → connections → Message → send/reply → unread badge →
admin login → institution search/pagination.

Expected: **588 institutions**, same as Render today.

---

## 6. Rollback

Nothing on Render changed. If Vercel misbehaves, keep using
`https://fidonect-api.onrender.com` and delete the Vercel project. No data rollback is
needed because Vercel never touches Supabase.

---

## 7. Notes / limits

- Vercel Hobby is free for personal, non-commercial projects. If Fidonect becomes commercial,
  Vercel's terms require a paid plan.
- Functions are stateless: the in-memory message throttle resets between instances. Messages,
  conversations, and reads are all in Supabase, so no data is lost.
- Supabase access is over HTTPS/PostgREST, so serverless cold starts do not exhaust database
  connections (no direct Postgres pool to manage).
- Android APK still points at the Render URL. Update `MainActivity.java` only after Vercel is
  verified; old APKs keep working against Render in the meantime.
