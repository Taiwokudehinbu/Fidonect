// Fidonect backend stub — run with `npm install && npm start` (requires Node 18+).
// Phase-1 stub: in-memory stores. Replace with DB + auth + RAG in Phase 2.
const express = require("express");
const cors = require("cors");
const app = express();
app.use(cors()); app.use(express.json());

const db = { users: [], connections: [], posts: [], reports: [], mentors: [] };

app.get("/health", (req, res) => res.json({ ok: true, service: "fidonect-api", phase: "mvp-stub" }));
app.post("/api/users", (req, res) => { const u = { id: Date.now(), ...req.body }; db.users.push(u); res.json(u); });
app.get("/api/discover", (req, res) => res.json(db.users));
app.post("/api/connections", (req, res) => { db.connections.push(req.body); res.json({ ok: true }); });
app.get("/api/communities/:school/posts", (req, res) => res.json(db.posts.filter(p => p.school === req.params.school)));
app.post("/api/communities/:school/posts", (req, res) => { const p = { school: req.params.school, ...req.body }; db.posts.push(p); res.json(p); });
app.post("/api/fido/ask", (req, res) => res.json({ source: "AI guidance", answer: "Stub: wire LLM + institutional knowledge base with source attribution (Official/Community/AI)." }));
app.get("/api/mentors", (req, res) => res.json(db.mentors));
app.post("/api/reports", (req, res) => { db.reports.push(req.body); res.json({ ok: true }); });

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Fidonect API stub on :${PORT}`));
