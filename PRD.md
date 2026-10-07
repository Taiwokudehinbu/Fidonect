# FIDONECT — Product Requirements Document
AI-Powered Student & Campus Connection Platform
Connect. Know. Prepare. Belong.

Source: `FIDONECT.docx` transcribed to markdown. Decisions in §21 are authoritative for implementation.

## 1. Product Overview
Fidonect connects prospective students with other prospective students, existing students, mentors and alumni within Nigerian universities and polytechnics. It helps students begin their school journey before arrival via connections, institutional information, mentorship and AI-powered guidance. Long-term vision: trusted digital ecosystem for Nigerian tertiary students.

## 2. Problem Statement
Prospective students struggle to:
- Find other students entering the same institution
- Connect with future classmates / course mates
- Get reliable information about institution and department
- Understand admission, clearance and registration processes
- Find experienced students for practical questions
- Prepare for accommodation and campus life
- Navigate admission → resumption transition

Today they depend on WhatsApp groups, Facebook, informal contacts and scattered info. Fidonect brings this together in one platform.

## 3. Target Users
Primary: prospective students (UTME/DE, newly admitted, awaiting admission, preparing to resume); existing students (100–500 level, mentors).
Secondary: alumni, student orgs, education/accommodation providers, eventually institutions.

## 4. Core MVP Features
### A. Registration & Profile
Email, phone, Google/Apple where available. Profile: name, photo, user type, institution, faculty, department, programme, level/session, state/location, interests. User controls public visibility.
### B. Institution Selection
Institution → Faculty → Department → Programme → Academic Session. Example: University of Lagos / Faculty of Science / B.Sc. Biology / 2026/2027.
### C. Student Connect
Discover by same institution / department / programme / session / level / interests. Connection requests + messaging after connect.
### D. School Communities
Per-institution community with faculty/department sub-communities, admission/resumption, accommodation, Q&A. Must scale to hundreds of institutions.

## 5. Fido AI Assistant
Questions like: resumption prep, clearance docs, first-semester prep, studying Biology. Must label answers:
- Official — verified institutional sources
- Community — student-provided
- AI guidance — general AI output

## 6. Mentorship
Existing students apply as mentors (institution, faculty, dept, level, help areas). Prospective students request relevant mentors. Verify via institutional email, student ID, other approved methods.

## 7. Campus Information Hub
Per institution: overview, faculties/departments, admission, registration, dates, fees, accommodation, transport, facilities, FAQ, official links. Show source + last-updated date.

## 8. Notifications
Connection requests, messages, mentor responses, community activity, institutional updates, AI reminders. User-controllable preferences.

## 9. Messaging
1-to-1, mentor conversations, community discussions. Safety: block, report, delete, moderation.

## 10. Search
Students, institutions, faculties, departments, programmes, communities, mentors, info.

## 11. Admin Dashboard
Manage users, institutions/faculties/departments/programmes, communities, mentors, reports, verification, AI knowledge sources, announcements, moderation. Suspend/remove violators.

## 12. Trust & Safety
Phone/email verification, reporting, blocking, moderation, guidelines, mentor verification, anti-spam, privacy. No public phone/exact address by default.

## 13. MVP User Journey
Download → create account → select institution/faculty/dept/programme/session → complete profile → see students → join community → ask Fido → connect → find mentor → prepare for resumption.

## 14. MVP Scope
Hypothesis: will prospective students actively use Fidonect to connect + get guidance before resumption?
In: registration, profiles, institution selection, discovery, connections, messaging, communities, basic Fido, mentor profiles, search, notifications, report/block, admin.
Out: marketplace, accommodation booking, payments, advanced tutor, institution subscriptions, ads, alumni marketplace.

## 15. Business Model
Free core connection. Later: premium Fido, verified accommodation, marketplace commission, education ads, institution partnerships, premium mentorship, recruitment, sponsored content. Avoid undermining trust.

## 16. Success Metrics
Growth (registered/active/weekly), engagement (connections/messages/community/AI/mentor), retention (7-day/30-day/post-resumption), network (institutions/departments/verified mentors), quality (reports/AI feedback/satisfaction).

## 17. Technology Direction (from PRD)
Mobile-first. Android first, iOS next, web/admin. Scalable API, secure DB, auth, realtime messaging, notifications. LLM Fido + RAG + source attribution. Cloud hosting, backups, analytics, monitoring.

## 18. Phases
- Phase 1 MVP: connection + communities + basic Fido
- Phase 2: mentorship + verified info + improved AI
- Phase 3: accommodation + marketplace + services
- Phase 4: institution partnerships + alumni + recruitment

## 19. Long-Term Vision
Prospective → Admission → Connection → Mentorship → Resumption → Academic Life → Graduation → Alumni → Career.

## 20. Vision Statement
Make every Nigerian student feel connected before arrival, supported while there, and connected to opportunities after graduation.

## 21. Architecture Decisions (authoritative)

### ADR-001: Use SQLite (local file) instead of PostgreSQL for Phase 0–1
- Decision: `backend/fidonect.db` (SQLite) via Prisma ORM. Schema mirrors future Postgres tables. No Docker/service required. Migrate to hosted Postgres (Supabase/Neon) in Phase 2.
- Reason:
  1. Runs locally on Windows + Git Bash with only Node 20 — zero-config, file-based, fits current `backend/server.js` stub and single-dev setup where Postgres is not installed.
  2. Sufficient for MVP hypothesis in §14 (registration, discovery, connections, posts, basic Fido) — low concurrent writes, <10k users.
  3. Prisma makes migration trivial — same models, change provider to `postgresql`, run migrate + seed (canonical NUC names, see backend/seed/institutions-all.csv).
  4. Defers cost/ops (hosting, backups, pgvector) until Phase 2 when verified hub + RAG + concurrent messaging need it.
- Trade-off accepted: no row-level concurrent write scale, no native vector/full-text search. Mitigated by keeping `hub_pages` small and Fido rule-based in Phase 1.
- When to revisit: >1k concurrent users, need hosted auth/jobs, or Fido RAG over large verified corpus — switch provider to PostgreSQL, move `backend/uploads/` to S3/MinIO.

### ADR-002: Curved primary button with darker navy for contrast (`design.html`)
- Decision: pill button `border-radius:999px`, bg/border `#0a1f33` (darker than `#0f2a43`), white 700-weight text, hover `#071627`, focus ring `3px #2dd4bf`. Ghost variant uses white bg with `#0a1f33` text/border.
- Reason: pill shape matches friendly student brand; darker navy raises white-text contrast vs prior `#0f2a43` for WCAG AA; visible focus ring improves keyboard accessibility. Demo lives in `design.html`, to be ported to `styles.css` button rules.

### ADR-003 (PROPOSED — needs owner sign-off): Supabase Postgres is the primary database; Prisma/SQLite is local-dev only
- Proposal: all production reads/writes go to Supabase Postgres (live: `institutions` table + `public read` anon policy). `backend/prisma/schema.prisma` + `backend/fidonect.db` stay as a local-dev reference only; no new SQLite-backed features. `backend/server.js` stub routes move to Supabase table-by-table as MVP features land.
- Reason: two sources of truth (full Prisma schema vs single Supabase table) will diverge; Supabase already hosts auth/RLS/backups in one place.
- Status: proposed. See §H decision 1 in the review summary before treating as final.

## 22. Monetization Strategy (extends §15; §15 remains the summary)
### 22.1 Monetization principle
"Fidonect will prioritize user trust, safety and usefulness over aggressive monetization. Paid services and commercial partnerships should provide clear value without compromising student privacy or access to essential community features."
### 22.2 Free core (MVP — never paywalled)
Registration, profile, institution/course exploration, community discovery, student-to-student connection and appropriate community participation stay free in the MVP. Essential connection features must not move behind a paywall.
### 22.3 Future revenue (documented only — NOT built in MVP)
Premium student features (matching, recommendations, resources, discovery tools); institution partnerships (verified communities, announcements, promotion, engagement, info pages, aggregated insights); sponsored listings/ads (accommodation, education, tech, data, transport); premium guides/webinars/career resources.
Binding rules: sponsored content clearly labeled; NEVER sell student personal information; NEVER show a "verified" badge for institutions, mentors, or listings without a real, documented verification process (see §6, §24).

### 22.3a Premium tiers (specification only — no billing code in MVP)
- **Free (current MVP):** registration, profile, discovery, connections, communities, basic Fido, safety tools. Free forever for these essentials.
- **Student Premium (future):** advanced institution/course matching, AI-powered recommendations, enhanced networking and discovery, premium guides/resources, extra personalization. Price: TBD NGN/month (decision required).
- **Institution Partner (future):** verified community badge (only via real verification), approved announcements, programme/event promotion, engagement tools, privacy-conscious aggregated insights (never raw student data). Price: TBD NGN/term (decision required).
- Billing provider: TBD — Paystack vs Flutterwave evaluation recorded as pending (Nigeria-first). No provider SDK, keys, webhooks, or billing tables until chosen.
- Reserved future tables (do NOT create in MVP): `subscriptions`, `invoices`, `partner_plans`, `ad_campaigns`.
### 22.4 Monetization roadmap
MVP: no payment processing, no subscriptions, no ads platform, no institution billing. Architecture must simply avoid blocking them.
Future: subscriptions, payments (provider TBD — Paystack/Flutterwave to be evaluated for Nigeria), institution plans, sponsored listings, ad controls, premium resources, business dashboards.
### 22.5 Schema/architecture decisions to make NOW (no features built)
- Single source of truth per ADR-003 (proposed) so billing tables land in one database later.
- When profiles are built: `visibility` field (public/connections/private) + consent timestamp columns — cheap now, expensive to retrofit.
- Institutions: add nullable `verified_at`/`verified_by` later; UI renders "verified" ONLY from a non-null flag (enforces §22.3 rule in code).
- Keep `subscriptions`, `invoices`, `ad_campaigns` OUT of the MVP schema; add when a payment provider is chosen.

## 23. Privacy & Data Protection (extends §12; NDPA-aware, NOT a compliance claim)
### 23.1 Data minimization + inventory (maintain as features land)
| Data | Why | Retention | Who receives it |
|---|---|---|---|
| Name, email/phone, school path, interests | Matching + connection (§4) | Account lifetime + deletion on request | Other users per visibility setting; Supabase (processor) |
| Posts, messages, reports | Core features (§§9,11) | Per retention policy below | Recipients/mods as applicable |
| Verification docs (future) | Mentor/institution trust | Minimum necessary, then delete/anonymize | Reviewers only |
Collect nothing sensitive beyond this without a new PRD entry.
### 23.2 Consent
Clear, specific consent at registration (not broad/vague); record consent timestamp; allow withdrawal (account deletion path).
### 23.3 Profile privacy
Visibility controls (public/connections/private) where practical; phone/exact address never public by default (already §12 — restated as binding).
### 23.4 User rights (plan now, automate later)
Access, correction, deletion-on-request, consent withdrawal, visibility control, concern reporting. MVP: manual fulfillment path (contact + admin action); automated dashboard is future.
### 23.5 Retention
No indefinite retention without purpose. Future: deletion/anonymization workflows (e.g., dormant accounts, withdrawn consent).
### 23.6 Security baseline
Supabase Auth when auth lands (password hashing via provider, never hand-rolled); RLS on EVERY new table (anon minimal, authenticated scoped); anon key backend-only, service_role never in repo/frontend (already enforced — `backend/.env` gitignored, `backend/supabaseClient.js:1-2`); HTTPS via Render; 100kb payload caps (done, `backend/server.js:9`); logs must never store passwords, tokens, or ID numbers.
### 23.7 Nigerian context (NDPA/NDPC)
Requirements here are designed with the Nigeria Data Protection Act and NDPC guidance in mind. This is NOT a claim of compliance. Qualified Nigerian privacy professional review is a pre-production gate (§28).

## 24. Student Safety & Younger Users (extends §§9, 12)
Safety tooling (block/report user/content, harassment/scam reporting, moderation process, safety guidance) ships WITH messaging — messaging must not launch publicly without it. Never claim identity verification without a real process. Discourage sharing passwords, financial info, ID documents, exact home addresses.
Under-18: assume mixed ages; minimize minor data; no complex MVP age-gate; review unrestricted messaging pre-launch; flag for privacy/legal review (§28).

## 25. Responsible AI (extends §5; applies when Fido is wired to a real model — current `/api/fido/ask` is a stub, `backend/server.js:46`)
Principles: transparency (users know it's AI), human control (users decide), accuracy (verify against official sources), fairness (no unfair discrimination), privacy + data minimization (no unnecessary personal data to AI providers), explainability (simple why), human review/escalation for sensitive outputs.
Hard limits — AI must NEVER decide: admissions, scholarships, academic ability, employment, financial eligibility; never present recommendations as official institutional decisions.
AI-generated info (fees, deadlines, policies, guidance): label via existing Official/Community/AI scheme (§5), encourage official-source verification, link official sources where practical, provide correction mechanism.
Personal data: no training external models on student data without legal basis + disclosure + consent; record provider + data sent per call (see §26).

## 26. Third-Party Register (maintain as vendors change)
| Service | Data shared | Why | Essential | Privacy note | Consent |
|---|---|---|---|---|---|
| Supabase (DB) | All app data | Primary backend | Yes | Processor; RLS enforced | Via ToS/consent |
| Render (hosting) | Traffic/logs | Serve app+API | Yes | Logs, no PII by design | No |
| GitHub (code) | Code only | Source control | Yes | No user data | No |
| Prisma/SQLite | Local dev mirror | Dev only | No | Local file | No |
| AI provider | TBD — none integrated | Future Fido | No | Record before wiring | Yes, when live |
| Payments/analytics/email | None | Future | No | Evaluate before adding | Yes, when live |

## 27. MVP vs Future (requirements delta — §14 scope unchanged)
MVP (include or plan for): Privacy Policy + Terms structures; registration consent; profile visibility where practical; Supabase Auth + RLS; responsible-AI principles + labels + limits; report/block wherever interaction exists; verify-important-info guidance; privacy-conscious architecture (§§22.5, 23.6).
Future (deferred): advanced moderation, abuse detection, privacy dashboard, data export, retention automation, consent management, AI explainability tooling, institution privacy controls, subscriptions/payments/ads dashboards, formal PIAs.

## 28. Pre-production Gates (all require sign-off before public launch)
1. Nigerian privacy professional review (NDPA) — §23.7.
2. Messaging safety review (moderation + blocking live) — §24.
3. AI review once Fido uses a real model (§25 limits + labels verified).
4. "Verified" claims audit (no badge without process) — §§6, 22.3.
5. Secrets + RLS audit (no service_role outside dashboards; RLS on all tables).
