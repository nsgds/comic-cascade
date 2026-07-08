// The "Continue reading" row: one horizontal strip of text chips above the tree,
// one per in-progress comic (merged local + server tiers, newest first, ≤10).
// Absent entirely when there is nothing to continue. Deliberately text-only —
// rendering covers could re-extract evicted archives just to draw the browse
// screen. Chips deep-link WITH the page (?page=N): tapping "continue" is an
// explicit answer, so the reader jumps straight there instead of asking again.

import { forget, getRecent } from "../progress.js";

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

function title(path) {
  const name = path.split("/").pop();
  return name.replace(/\.[^.]+$/, ""); // filename sans extension
}

// ctx: { onOpen(item) } — item = {library, path, page, total}
export function renderResumeRow(container, ctx) {
  container.innerHTML = "";
  getRecent().then((items) => {
    if (!items.length || !container.isConnected) return;

    const row = el("div", "resume-row");
    row.append(el("div", "resume-row-label", "Continue reading"));
    const strip = el("div", "resume-strip");
    row.append(strip);

    for (const item of items) {
      // Two sibling buttons (open + remove) — interactive elements must not
      // nest, and this keeps the ✕ keyboard-reachable.
      const chip = el("div", "resume-chip");

      const open = el("button", "resume-chip-open");
      open.title = item.path;
      open.append(
        el("span", "resume-chip-name", title(item.path)),
        el("span", "resume-chip-pos", `p. ${item.page + 1} / ${item.total}`),
      );
      open.addEventListener("click", () => ctx.onOpen(item));

      const x = el("button", "resume-chip-x", "✕");
      x.title = "Remove from continue reading";
      // A per-comic accessible name — otherwise up to 10 destructive buttons all
      // announce as just "✕" with no way to tell which comic each one forgets.
      x.setAttribute("aria-label", `Remove ${title(item.path)} from continue reading`);
      x.addEventListener("click", () => {
        forget(item.library, item.path, item.total);
        chip.remove();
        if (!strip.childElementCount) row.remove(); // last chip gone -> no row
      });

      chip.append(open, x);
      strip.append(chip);
    }
    container.append(row);
  });
}
