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
  3. Prisma makes migration trivial — same models, change provider to `postgresql`, run migrate + seed UNILAG/UI/OAU/YabaTech.
  4. Defers cost/ops (hosting, backups, pgvector) until Phase 2 when verified hub + RAG + concurrent messaging need it.
- Trade-off accepted: no row-level concurrent write scale, no native vector/full-text search. Mitigated by keeping `hub_pages` small and Fido rule-based in Phase 1.
- When to revisit: >1k concurrent users, need hosted auth/jobs, or Fido RAG over large verified corpus — switch provider to PostgreSQL, move `backend/uploads/` to S3/MinIO.

### ADR-002: Curved primary button with darker navy for contrast (`design.html`)
- Decision: pill button `border-radius:999px`, bg/border `#0a1f33` (darker than `#0f2a43`), white 700-weight text, hover `#071627`, focus ring `3px #2dd4bf`. Ghost variant uses white bg with `#0a1f33` text/border.
- Reason: pill shape matches friendly student brand; darker navy raises white-text contrast vs prior `#0f2a43` for WCAG AA; visible focus ring improves keyboard accessibility. Demo lives in `design.html`, to be ported to `styles.css` button rules.
