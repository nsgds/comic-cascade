// Pure merge/freshness logic of the read-resume store (no DOM, no storage).
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  freshest,
  mergeRecent,
  recordKey,
  RECENT_MAX,
  reportAction,
  storageKeyFor,
} from "../../web/js/progress.js";

const rec = (library, path, page, updated_at, total = 100) => ({
  library,
  path,
  page,
  total,
  updated_at,
});

test("recordKey separates library and path unambiguously", () => {
  assert.notEqual(recordKey("lib a", "x"), recordKey("lib", "a x"));
  assert.equal(recordKey("lib", "a/b.cbz"), recordKey("lib", "a/b.cbz"));
});

test("freshest is null-safe and prefers the newer record", () => {
  const older = rec("l", "p", 1, 100);
  const newer = rec("l", "p", 5, 200);
  assert.equal(freshest(null, null), null);
  assert.equal(freshest(older, null), older);
  assert.equal(freshest(null, newer), newer);
  assert.equal(freshest(older, newer), newer);
  assert.equal(freshest(newer, older), newer);
  assert.equal(freshest(older, older), older); // tie -> first argument (stable)
});

test("mergeRecent dedupes on (library,path) with freshest wins", () => {
  const local = [rec("l", "a.cbz", 3, 100)];
  const server = [rec("l", "a.cbz", 7, 200)];
  const merged = mergeRecent(local, server);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].page, 7); // the server copy was newer
});

test("mergeRecent hides page-0 records and tolerates junk", () => {
  const merged = mergeRecent(
    [rec("l", "unstarted.cbz", 0, 300), null, undefined],
    [rec("l", "reading.cbz", 2, 100)],
  );
  assert.deepEqual(merged.map((m) => m.path), ["reading.cbz"]);
});

test("a fresh tombstone shadows another device's stale position (cross-device forget)", () => {
  // Device A read to p.19 (local copy). Device B forgot the comic (server
  // tombstone, newer). Device A's merge must NOT resurrect the chip.
  const staleLocal = rec("l", "crusades01.cbr", 19, 100);
  const tombstone = rec("l", "crusades01.cbr", 0, 200);
  assert.deepEqual(mergeRecent([staleLocal], [tombstone]), []);
  assert.deepEqual(mergeRecent([tombstone], [staleLocal]), []); // either tier
});

test("a position written AFTER a tombstone resurfaces (re-reading works)", () => {
  const tombstone = rec("l", "a.cbz", 0, 100);
  const reread = rec("l", "a.cbz", 5, 200);
  const merged = mergeRecent([reread], [tombstone]);
  assert.deepEqual(merged.map((m) => [m.path, m.page]), [["a.cbz", 5]]);
});

test("mergeRecent sorts newest first and caps the list", () => {
  const many = Array.from({ length: 15 }, (_, i) => rec("l", `c${i}.cbz`, 1, i));
  const merged = mergeRecent(many, []);
  assert.equal(merged.length, RECENT_MAX);
  assert.equal(merged[0].path, "c14.cbz"); // newest updated_at first
  assert.equal(merged.at(-1).path, `c${15 - RECENT_MAX}.cbz`);
});

test("mergeRecent keeps distinct comics from both tiers", () => {
  const merged = mergeRecent(
    [rec("l", "local-only.cbz", 1, 100)],
    [rec("l", "server-only.cbz", 2, 200)],
  );
  assert.deepEqual(merged.map((m) => m.path), ["server-only.cbz", "local-only.cbz"]);
});

test("storageKeyFor partitions per user and keeps the anonymous bucket stable", () => {
  assert.equal(storageKeyFor(null), "cc.progress"); // anonymous = today's key
  assert.equal(storageKeyFor("abc123"), "cc.progress:abc123");
  assert.notEqual(storageKeyFor("userA"), storageKeyFor("userB"));
});

// ---- reportAction: the reader's write policy ----

const act = (over) =>
  reportAction({ armed: true, page: 5, pageCount: 100, firstTickAfterExplicitOpen: false, ...over });

test("reportAction never writes while the resume pill is unanswered", () => {
  assert.equal(act({ armed: false }), "skip");
  assert.equal(act({ armed: false, page: 99 }), "skip"); // not even the last page
});

test("reportAction records mid-comic pages, skips page 0", () => {
  assert.equal(act({}), "record");
  assert.equal(act({ page: 1 }), "record");
  // page 0 = nothing to resume; also means glancing at a comic writes nothing
  // and can never clobber a saved position with 0 (the tombstone encoding).
  assert.equal(act({ page: 0 }), "skip");
});

test("reportAction records the LAST page too — finishing keeps the chip at n/n", () => {
  // Your place in a series is "at the end of this issue" (where the end card
  // offers the next one); the record hands off later, it is not deleted here.
  assert.equal(act({ page: 99 }), "record");
  // A single-page comic's only page is page 0 — never recorded (page-0 rule).
  assert.equal(act({ page: 0, pageCount: 1 }), "skip");
});

test("reportAction skips the first tick of an explicit open onto the last page", () => {
  // A chip/deep link clamped past a shrunken re-scan lands on the last page
  // without the user reading anything — it must not overwrite the position.
  assert.equal(act({ page: 99, firstTickAfterExplicitOpen: true }), "skip");
  // …but a normal explicit open mid-comic still records immediately.
  assert.equal(act({ page: 42, firstTickAfterExplicitOpen: true }), "record");
});
