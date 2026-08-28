// Lazy, expandable file-explorer tree. Each directory loads its children only
// when first expanded (one /api/tree call per level — never a full recursive walk).
// A reveal target (#/?sel=…, e.g. the reader's Back button) rides the same lazy
// loads: each level expands the matching directory and the final segment's row
// is highlighted and scrolled into view.

import { api } from "../api.js";

const ICON = { dir: "📁", comic: "📖", other: "📄" };

function joinPath(parent, name) {
  return parent ? `${parent}/${name}` : name;
}

// What the reveal path asks of one node, given the segments still to walk:
// "open" (descend through this dir), "open+select" (the target IS this dir),
// "select" (the target file), or null. Pure so Node can pin the contract —
// notably that a non-dir mid-path or a missing segment does nothing: a stale
// or hidden target degrades to a plain tree, never an error.
export function revealAction(entry, segments) {
  if (!segments || segments.length === 0 || segments[0] !== entry.name) return null;
  const last = segments.length === 1;
  if (entry.type === "dir") return last ? "open+select" : "open";
  return last ? "select" : null;
}

// ctx: { library, showAll, onOpenComic(path) }; reveal: a relative path to
// auto-expand to and highlight, or null.
export function renderTree(container, ctx, reveal = null) {
  container.innerHTML = "";
  const root = document.createElement("ul");
  root.className = "tree";
  container.appendChild(root);
  loadInto(root, "", ctx, 0, reveal ? reveal.split("/").filter(Boolean) : null);
}

async function loadInto(ulEl, path, ctx, depth, reveal) {
  const loading = document.createElement("li");
  loading.className = "tree-loading";
  loading.textContent = "…";
  ulEl.appendChild(loading);
  try {
    const data = await api.tree(ctx.library, path, ctx.showAll);
    loading.remove();
    if (data.entries.length === 0) {
      const empty = document.createElement("li");
      empty.className = "tree-empty";
      empty.textContent = "(empty)";
      ulEl.appendChild(empty);
      return;
    }
    for (const entry of data.entries) {
      ulEl.appendChild(makeNode(entry, path, ctx, depth, reveal));
    }
  } catch (e) {
    loading.className = "tree-error";
    loading.textContent = "failed to load";
  }
}

function selectRow(row) {
  row.classList.add("selected");
  // Deferred: the node isn't in the document yet (appended after makeNode
  // returns). The target is in the deepest — last-loaded — level, so nothing
  // renders below it afterwards to shift the scroll position.
  requestAnimationFrame(() => row.scrollIntoView({ block: "center" }));
}

function makeNode(entry, parentPath, ctx, depth, reveal) {
  const li = document.createElement("li");
  li.className = `node ${entry.type}`;
  const fullPath = joinPath(parentPath, entry.name);

  const row = document.createElement("div");
  row.className = "node-row";
  row.style.paddingLeft = `${0.9 + depth * 1.1}rem`;

  const caret = document.createElement("span");
  caret.className = "caret";
  caret.textContent = entry.type === "dir" ? "▶" : "";
  row.append(caret);

  const icon = document.createElement("span");
  icon.className = "icon";
  icon.textContent = ICON[entry.type] || ICON.other;
  row.append(icon);

  const label = document.createElement("span");
  label.className = "label";
  label.textContent = entry.name;
  row.append(label);

  li.append(row);

  const action = revealAction(entry, reveal);
  if (entry.type === "dir") {
    const childUl = document.createElement("ul");
    li.append(childUl);
    let loaded = false;
    const load = (childReveal) => {
      if (loaded) return;
      loaded = true;
      loadInto(childUl, fullPath, ctx, depth + 1, childReveal);
    };
    row.addEventListener("click", () => {
      if (li.classList.toggle("open")) load(null);
    });
    if (action) {
      li.classList.add("open");
      load(reveal.slice(1)); // [] when this dir is the target — just opens it
      if (action === "open+select") selectRow(row);
    }
  } else {
    if (entry.type === "comic") {
      row.addEventListener("click", () => ctx.onOpenComic(fullPath));
    }
    if (action === "select") selectRow(row);
  }
  return li;
}
