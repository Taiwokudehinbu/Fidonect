# Fidonect — Connect. Know. Prepare. Belong.

AI-powered student & campus connection platform for Nigerian universities & polytechnics.
MVP: registration, institution/department selection, student discovery, connections,
messaging, communities, Fido AI (with Official / Community / AI labels), mentors,
info hub, search, notifications, report/block, admin dashboard.

## Run (no install needed)
Open `index.html` in a browser. Data persists in `localStorage`.

- `index.html` — app shell
- `styles.css` — mobile-first styles
- `app.js` — MVP logic + seed data (FUTA, UNILAG, UI, OAU, YabaTech)

## Backend scaffold (optional, needs Node)
```
cd backend
npm install
npm start  # http://localhost:3000/health
```
See `backend/server.js`. This is a minimal Express API stub for
auth/profile/discovery/community/fido/mentors/messages/hub/admin
to be expanded in Phase 2.

## Roadmap
- Phase 1 (MVP): this repo — connection + communities + basic Fido AI
- Phase 2: mentorship verification + verified institutional info + improved AI (RAG)
- Phase 3: accommodation + marketplace + services
- Phase 4: institution partnerships + alumni + recruitment

## Trust & Safety
Phone/email verification, reporting, blocking, moderation, privacy controls
(phone hidden by default), mentor verification (student ID / institutional email).
