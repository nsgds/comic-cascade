// Read-resume progress: where you are in each comic.
//
// Two tiers, one interface. localStorage is always written (per-device resume for
// everyone, no server state). When the server advertises identity-backed progress
// (`progress: true` from /api/libraries — i.e. the reverse proxy asserts who you
// are), writes are mirrored to the server so your position follows you across
// devices. Reads merge both, freshest updated_at wins.
//
// Records are keyed (library, path); page is the 0-based page index. Forgetting
// a comic (dismissed its chip / handed off to the next issue) writes a page-0
// TOMBSTONE rather than deleting: a deleted row is invisible to the
// freshest-wins merge, so another device's stale local copy would resurrect
// the chip — a tombstone instead
// competes in the merge (shadowing stale copies everywhere) and page-0 records
// are already hidden from every surface. Tombstones are plain POSTs: idempotent,
// sendBeacon-able on unload, and ordered by the same mutation chain as position
// writes (no POST/DELETE reordering race). A pagehide/visibilitychange flush
// catches the tab closing mid-debounce.
//
// Pure helpers (recordKey/freshest/mergeRecent/reportAction) have no DOM/storage
// dependency so Node can test them; all IO lives in the store functions below.

import { api } from "./api.js";

const KEY = "cc.progress";
const LOCAL_MAX = 50; // newest local records kept (quota hygiene)
const DEBOUNCE_MS = 1500;
export const RECENT_MAX = 10;

let serverEnabled = false;
export function setServerEnabled(on) {
  serverEnabled = !!on;
}

// Opaque per-user token from /api/libraries (progress_scope). When present,
// local records live under a per-user storage key, so two accounts sharing one
// browser profile don't see each other's chips. Null (no identity) keeps the
// shared per-device bucket — anonymous deployments behave exactly as before.
let scope = null;
export function setScope(s) {
  scope = s || null;
}

// Pure so Node can pin the partitioning rule.
export function storageKeyFor(scope_) {
  return scope_ ? `${KEY}:${scope_}` : KEY;
}

// ---- pure helpers (Node-testable) -----------------------------------------

export function recordKey(library, path) {
  return `${library}\u0000${path}`;
}

// Null-safe "newer of the two records".
export function freshest(a, b) {
  if (!a) return b || null;
  if (!b) return a;
  return (b.updated_at || 0) > (a.updated_at || 0) ? b : a;
}

// Merge local + server entries for the continue-reading row: dedupe on
// (library, path) with freshest-wins, newest first, capped. Entries at page 0
// are dropped — there is nothing to continue from.
export function mergeRecent(localEntries, serverItems, max = RECENT_MAX) {
  const byKey = new Map();
  for (const e of [...localEntries, ...serverItems]) {
    if (!e || typeof e !== "object") continue;
    const k = recordKey(e.library, e.path);
    // Page-0 tombstones DO compete here — a fresh tombstone from another device
    // must shadow this device's stale position copy…
    byKey.set(k, freshest(byKey.get(k), e));
  }
  return [...byKey.values()]
    .filter((e) => e.page > 0) // …and only the survivors that are real positions show
    .sort((x, y) => (y.updated_at || 0) - (x.updated_at || 0))
    .slice(0, max);
}

// What one reader page-tick should do to the record. Pure, so the reader's core
// write policy is testable:
//  - not armed (the resume pill is still unanswered) -> never write;
//  - page 0 -> nothing to resume, write nothing (merely glancing at a comic can
//    never create a junk record or clobber a saved position — and page 0 is
//    also the tombstone encoding). A single-page comic therefore never records;
//  - last page -> "record" like any other page: finishing KEEPS the chip at
//    n/n — your place in a series is "at the end of this issue", where the end
//    card offers the next one. The record is forgotten only when the comic you
//    advance to writes its own first position (the handoff in reader.js) or the
//    chip is ✕'d. EXCEPT on the very first tick of an explicit-page open: a
//    deep link clamped past a shrunken re-scan lands on the last page without
//    the user reading anything, and must not overwrite the saved position;
//  - otherwise -> "record".
export function reportAction({ armed, page, pageCount, firstTickAfterExplicitOpen }) {
  if (!armed || page <= 0) return "skip";
  if (page >= pageCount - 1 && firstTickAfterExplicitOpen) return "skip";
  return "record";
}

// ---- localStorage tier ------------------------------------------------------

function readAll() {
  try {
    const map = JSON.parse(localStorage.getItem(storageKeyFor(scope)) || "{}");
    if (!map || typeof map !== "object") return {};
    // Drop corrupt per-entry junk (null values etc.) on read, so no later code
    // path — including the LOCAL_MAX trim — can trip over it.
    for (const k of Object.keys(map)) {
      if (!map[k] || typeof map[k] !== "object") delete map[k];
    }
    return map;
  } catch {
    return {};
  }
}

function writeAll(map) {
  let entries = Object.entries(map);
  if (entries.length > LOCAL_MAX) {
    entries.sort((a, b) => ((b[1] && b[1].updated_at) || 0) - ((a[1] && a[1].updated_at) || 0));
    entries = entries.slice(0, LOCAL_MAX);
  }
  try {
    localStorage.setItem(storageKeyFor(scope), JSON.stringify(Object.fromEntries(entries)));
  } catch {
    /* quota exceeded / storage disabled — per-device resume just degrades */
  }
}

function localGet(library, path) {
  return readAll()[recordKey(library, path)] || null;
}

function localEntries() {
  // Stored records carry library/path so they can round-trip into mergeRecent.
  return Object.values(readAll());
}

// ---- the store --------------------------------------------------------------

let pending = null; // latest unsent {library, path, page, total} (position OR tombstone)
let debounceTimer = null;
// All server mutations go through one chain so writes for the same comic reach
// the server in the order the user produced them.
let mutations = Promise.resolve();
function enqueue(fn) {
  mutations = mutations.then(fn, fn);
}

/** Saved position for one comic, or null. Merges both tiers, freshest wins. */
export async function get(library, path) {
  const local = localGet(library, path);
  if (!serverEnabled) return local;
  const server = await api
    .progressGet(library, path)
    .then((r) => r.position)
    .catch(() => null); // server hiccup => the local tier still answers
  return freshest(local, server);
}

/** Record a position: localStorage immediately, server (if on) debounced. */
export function report(library, path, page, total) {
  const map = readAll();
  map[recordKey(library, path)] = {
    library,
    path,
    page,
    total,
    // Seconds, same scale as the server's stamps. Merges are best-effort
    // last-write-wins and assume roughly NTP-synced clocks; a badly skewed
    // device clock can mis-rank tiers until the next write. Accepted.
    updated_at: Date.now() / 1000,
  };
  writeAll(map);

  if (!serverEnabled) return;
  pending = { library, path, page, total };
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    const body = pending;
    pending = null;
    if (body) enqueue(() => api.progressSet(body).catch(() => {}));
  }, DEBOUNCE_MS);
}

/** Forget a comic (dismissed its chip, or its series place moved on to the
 * next issue): write a page-0
 * tombstone to both tiers so the forget PROPAGATES — other devices' stale
 * local copies are shadowed by it in the merge instead of resurrecting. */
export function forget(library, path, total = 1) {
  const map = readAll();
  const prev = map[recordKey(library, path)];
  const tombstone = {
    library,
    path,
    page: 0,
    total: (prev && prev.total) || total || 1,
    updated_at: Date.now() / 1000,
  };
  map[recordKey(library, path)] = tombstone;
  writeAll(map);

  if (!serverEnabled) return;
  clearTimeout(debounceTimer);
  const prior = pending;
  pending = null;
  if (prior && !(prior.library === library && prior.path === path)) {
    enqueue(() => api.progressSet(prior).catch(() => {})); // don't drop another comic's write
  }
  // Send now AND keep it visible to flush(): if the tab dies mid-flight the
  // beacon re-sends it — tombstone POSTs are idempotent, duplicates are free.
  const body = { library, path, page: 0, total: tombstone.total };
  pending = body;
  enqueue(() =>
    api
      .progressSet(body)
      .then(() => {
        if (pending === body) pending = null;
      })
      .catch(() => {}),
  );
}

/** Push any unsent server mutation out NOW (tab closing / navigating away).
 * Positions and tombstones are both POST bodies, so one beacon path covers all. */
export function flush() {
  clearTimeout(debounceTimer);
  const body = pending;
  pending = null;
  if (!serverEnabled || !body) return;
  const blob = new Blob([JSON.stringify(body)], { type: "application/json" });
  if (!(navigator.sendBeacon && navigator.sendBeacon("/api/progress", blob))) {
    api.progressSet(body).catch(() => {}); // beacon refused — best-effort fetch
  }
}

/** In-progress comics for the continue-reading row, newest first. */
export async function getRecent() {
  const server = serverEnabled
    ? await api
        .progressRecent()
        .then((r) => r.items)
        .catch(() => [])
    : [];
  return mergeRecent(localEntries(), server);
}

// A tab being closed or backgrounded mid-debounce must not lose the write.
if (typeof window !== "undefined") {
  window.addEventListener("pagehide", flush);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flush();
  });
}
