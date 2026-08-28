// The pure next-comic-in-folder lookup behind the end-of-comic "Up next" pill.
import assert from "node:assert/strict";
import { test } from "node:test";

import { baseName, nextComic, parentDir } from "../../web/js/reader/siblings.js";

const dir = (name) => ({ name, type: "dir" });
const comic = (name) => ({ name, type: "comic" });
const other = (name) => ({ name, type: "other" });

test("parentDir / baseName split on the last slash", () => {
  assert.equal(parentDir("a/b/c.cbz"), "a/b");
  assert.equal(parentDir("c.cbz"), "");
  assert.equal(baseName("a/b/c.cbz"), "c.cbz");
  assert.equal(baseName("c.cbz"), "c.cbz");
});

test("next comic follows the LISTING order, untouched", () => {
  // The server's natural sort is canonical — a client-side lexicographic
  // re-sort would put "10" before "2". The helper must not re-sort.
  const entries = [comic("ch 2.cbz"), comic("ch 10.cbz"), comic("ch 11.cbz")];
  assert.deepEqual(nextComic(entries, "ch 2.cbz"), { known: true, next: "ch 10.cbz" });
  assert.deepEqual(nextComic(entries, "ch 10.cbz"), { known: true, next: "ch 11.cbz" });
});

test("dirs and non-comic files are skipped", () => {
  const entries = [dir("Extras"), comic("a.cbz"), other("notes.txt"), comic("b.cbz")];
  assert.deepEqual(nextComic(entries, "a.cbz"), { known: true, next: "b.cbz" });
});

test("the last comic in the folder has no next but IS known", () => {
  const entries = [comic("a.cbz"), comic("b.cbz")];
  assert.deepEqual(nextComic(entries, "b.cbz"), { known: true, next: null });
});

test("a file missing from the listing is unknown, not 'last'", () => {
  assert.deepEqual(nextComic([comic("a.cbz")], "gone.cbz"), { known: false, next: null });
  assert.deepEqual(nextComic([], "a.cbz"), { known: false, next: null });
  // present in the folder but not as a comic (misclassified/hidden) — same
  assert.deepEqual(nextComic([other("a.cbz")], "a.cbz"), { known: false, next: null });
});
