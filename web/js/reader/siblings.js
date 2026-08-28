// Pure sibling lookup behind the end-of-comic "Up next" offer. The reader
// hands this one /api/tree listing of the comic's own folder and it answers
// "which comic follows this one". The listing's order is the server's natural
// sort — the canonical one — so it is never re-sorted here; and the lookup is
// within-folder only, deliberately: crossing into sibling folders has no
// well-defined order and the tree API never recurses. Node-tested; no DOM.

export function parentDir(path) {
  const i = path.lastIndexOf("/");
  return i < 0 ? "" : path.slice(0, i);
}

export function baseName(path) {
  const i = path.lastIndexOf("/");
  return i < 0 ? path : path.slice(i + 1);
}

// entries: one folder's /api/tree entries, server order.
// Returns { known, next }: next is the following comic's filename or null
// (null with known=true means "last comic in this folder"). known=false means
// the current file isn't in the listing at all (renamed or hidden since it
// was opened) — the caller shows nothing rather than a wrong "last in folder".
export function nextComic(entries, currentName) {
  const comics = entries.filter((e) => e.type === "comic").map((e) => e.name);
  const i = comics.indexOf(currentName);
  if (i < 0) return { known: false, next: null };
  return { known: true, next: i + 1 < comics.length ? comics[i + 1] : null };
}
