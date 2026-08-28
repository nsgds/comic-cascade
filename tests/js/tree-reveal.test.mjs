// The pure per-node contract of the browse deep-link reveal (#/?sel=…): which
// entries a reveal path opens or selects as each lazy tree level loads.
import assert from "node:assert/strict";
import { test } from "node:test";

import { revealAction } from "../../web/js/browser/tree.js";

const dir = (name) => ({ name, type: "dir" });
const comic = (name) => ({ name, type: "comic" });
const other = (name) => ({ name, type: "other" });

test("descends through a matching directory mid-path", () => {
  assert.equal(revealAction(dir("A"), ["A", "B", "x.cbz"]), "open");
  assert.equal(revealAction(dir("A"), ["A", "x.cbz"]), "open");
});

test("selects the final segment", () => {
  assert.equal(revealAction(comic("x.cbz"), ["x.cbz"]), "select");
  assert.equal(revealAction(other("notes.txt"), ["notes.txt"]), "select");
  // a directory as the target itself is opened AND highlighted
  assert.equal(revealAction(dir("A"), ["A"]), "open+select");
});

test("a non-matching entry is untouched", () => {
  assert.equal(revealAction(dir("A"), ["B", "x.cbz"]), null);
  assert.equal(revealAction(comic("y.cbz"), ["x.cbz"]), null);
});

test("a non-dir mid-path degrades to nothing (stale link, not an error)", () => {
  assert.equal(revealAction(comic("A"), ["A", "x.cbz"]), null);
  assert.equal(revealAction(other("A"), ["A", "x.cbz"]), null);
});

test("no reveal in flight means no action", () => {
  assert.equal(revealAction(dir("A"), null), null);
  assert.equal(revealAction(dir("A"), []), null);
});

test("matching is exact, not prefix or case-folded", () => {
  assert.equal(revealAction(dir("A"), ["a"]), null);
  assert.equal(revealAction(dir("Ab"), ["A"]), null);
});
