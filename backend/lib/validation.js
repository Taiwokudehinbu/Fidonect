// Shared, dependency-free validation helpers used by the API and tests.
// Keep this file pure: no database, no network, no environment access.

function isText(v, max = 200) {
  return typeof v === "string" && v.trim().length > 0 && v.length <= max;
}

function isEmail(v) {
  return typeof v === "string" && v.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
}

function isHttpUrl(v) {
  if (typeof v !== "string" || v.length > 2048) return false;
  try {
    const u = new URL(v);
    return (u.protocol === "http:" || u.protocol === "https:") && !!u.hostname;
  } catch (e) {
    return false;
  }
}

function isIsoDate(v) {
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const d = new Date(v + "T00:00:00Z");
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}

function parsePositiveInt(v, fallback, max) {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) return fallback;
  return max ? Math.min(n, max) : n;
}

function cleanText(v, max) {
  if (typeof v !== "string") return "";
  return v.trim().slice(0, max);
}

function slugify(v) {
  return String(v || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "scholarship";
}

function uniqueSlug(title) {
  return slugify(title) + "-" + Date.now().toString(36);
}

module.exports = { isText, isEmail, isHttpUrl, isIsoDate, parsePositiveInt, cleanText, slugify, uniqueSlug };
