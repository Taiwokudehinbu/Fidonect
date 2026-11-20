// Full data export using a service-role key. Run before production migrations.
//   node scripts/backup-supabase.mjs
// Writes backups/supabase-<timestamp>/{tables/*.json,storage/...}
// The service-role key is read from backend/.env and is never printed.
import dotenv from "dotenv";
import fs from "node:fs/promises";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";

dotenv.config({ path: path.join(process.cwd(), "backend", ".env") });

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error("Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in backend/.env first.");
  process.exit(1);
}

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const outDir = path.join(process.cwd(), "backups", "supabase-" + stamp);
const tableDir = path.join(outDir, "tables");
const storageDir = path.join(outDir, "storage", "avatars");
await fs.mkdir(tableDir, { recursive: true });

const db = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
const tables = [
  "institutions", "faculties", "departments", "programmes", "hub_pages",
  "profiles", "connections", "conversations", "participants", "messages",
  "posts", "reports", "user_roles", "admin_audit_log",
  "scholarships", "scholarship_bookmarks",
  "mentor_profiles", "mentor_requests", "fido_feedback",
  "campus_listings", "listing_requests"
];
const manifest = { createdAt: new Date().toISOString(), tables: {}, storage: {} };

async function dumpTable(table) {
  const rows = [];
  const page = 1000;
  for (let from = 0; ; from += page) {
    const { data, error } = await db.from(table).select("*").range(from, from + page - 1);
    if (error) {
      manifest.tables[table] = { ok: false, error: String(error.message || error) };
      return;
    }
    rows.push(...(data || []));
    if (!data || data.length < page) break;
  }
  await fs.writeFile(path.join(tableDir, table + ".json"), JSON.stringify(rows, null, 2));
  manifest.tables[table] = { ok: true, rows: rows.length };
}

async function listStorage(prefix) {
  const page = 100;
  const out = [];
  for (let offset = 0; ; offset += page) {
    const { data, error } = await db.storage.from("avatars").list(prefix, { limit: page, offset });
    if (error) throw error;
    out.push(...(data || []));
    if (!data || data.length < page) break;
  }
  return out;
}

async function dumpStorage(prefix) {
  const entries = await listStorage(prefix);
  for (const entry of entries) {
    const child = prefix ? prefix + "/" + entry.name : entry.name;
    if (entry.id === null) {
      await dumpStorage(child);
      continue;
    }
    const { data, error } = await db.storage.from("avatars").download(child);
    if (error) {
      manifest.storage[child] = { ok: false, error: String(error.message || error) };
      continue;
    }
    const buf = Buffer.from(await data.arrayBuffer());
    const target = path.join(storageDir, ...child.split("/"));
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, buf);
    manifest.storage[child] = { ok: true, bytes: buf.length };
  }
}

for (const table of tables) await dumpTable(table);
try { await dumpStorage(""); } catch (e) { manifest.storage.error = String(e.message || e); }

await fs.writeFile(path.join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2));
const okTables = Object.values(manifest.tables).filter((t) => t.ok).length;
console.log("Backup written to " + outDir);
console.log("Tables exported: " + okTables + "/" + tables.length + "; avatar files: " + Object.keys(manifest.storage).filter((k) => manifest.storage[k].ok).length);
console.log("Keep this folder off the repository and verify it before running migrations.");
