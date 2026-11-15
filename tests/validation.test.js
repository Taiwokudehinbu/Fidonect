const test = require("node:test");
const assert = require("node:assert/strict");
const { isText, isEmail, isHttpUrl, isIsoDate, parsePositiveInt, cleanText, slugify, uniqueSlug } = require("../backend/lib/validation");

test("isText accepts trimmed text and rejects empty/oversized values", () => {
  assert.equal(isText("Ada", 10), true);
  assert.equal(isText("   ", 10), false);
  assert.equal(isText("x".repeat(11), 10), false);
  assert.equal(isText(null, 10), false);
});

test("isEmail rejects malformed addresses", () => {
  assert.equal(isEmail("student@example.com"), true);
  assert.equal(isEmail("student@"), false);
  assert.equal(isEmail("not an email"), false);
});

test("isHttpUrl only allows http(s) links", () => {
  assert.equal(isHttpUrl("https://example.com/scholarship"), true);
  assert.equal(isHttpUrl("http://example.com"), true);
  assert.equal(isHttpUrl("javascript:alert(1)"), false);
  assert.equal(isHttpUrl("not a url"), false);
});

test("isIsoDate accepts real calendar dates only", () => {
  assert.equal(isIsoDate("2026-11-14"), true);
  assert.equal(isIsoDate("2026-02-30"), false);
  assert.equal(isIsoDate("14/11/2026"), false);
});

test("parsePositiveInt clamps and falls back", () => {
  assert.equal(parsePositiveInt("12", 20, 50), 12);
  assert.equal(parsePositiveInt("500", 20, 50), 50);
  assert.equal(parsePositiveInt("-1", 20, 50), 20);
  assert.equal(parsePositiveInt("abc", 20, 50), 20);
});

test("cleanText trims and truncates", () => {
  assert.equal(cleanText("  hello  ", 10), "hello");
  assert.equal(cleanText("abcdef", 3), "abc");
  assert.equal(cleanText(null, 3), "");
});

test("slugify produces stable URL-safe slugs", () => {
  assert.equal(slugify("MTN Foundation Scholarship 2026"), "mtn-foundation-scholarship-2026");
  assert.equal(slugify("  "), "scholarship");
  assert.match(uniqueSlug("Test Award"), /^test-award-[a-z0-9]+$/);
});
