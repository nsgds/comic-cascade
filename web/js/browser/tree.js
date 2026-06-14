// Lazy, expandable file-explorer tree. Each directory loads its children only
// when first expanded (one /api/tree call per level — never a full recursive walk).

import { api } from "../api.js";

const ICON = { dir: "📁", comic: "📖", other: "📄" };

function joinPath(parent, name) {
  return parent ? `${parent}/${name}` : name;
}

// ctx: { library, showAll, onOpenComic(path) }
export function renderTree(container, ctx) {
  container.innerHTML = "";
  const root = document.createElement("ul");
  root.className = "tree";
  container.appendChild(root);
  loadInto(root, "", ctx, 0);
}

async function loadInto(ulEl, path, ctx, depth) {
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
      ulEl.appendChild(makeNode(entry, path, ctx, depth));
    }
  } catch (e) {
    loading.className = "tree-error";
    loading.textContent = "failed to load";
  }
}

function makeNode(entry, parentPath, ctx, depth) {
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

  if (entry.type === "dir") {
    const childUl = document.createElement("ul");
    li.append(childUl);
    let loaded = false;
    row.addEventListener("click", () => {
      const open = li.classList.toggle("open");
      if (open && !loaded) {
        loaded = true;
        loadInto(childUl, fullPath, ctx, depth + 1);
      }
    });
  } else if (entry.type === "comic") {
    row.addEventListener("click", () => ctx.onOpenComic(fullPath));
  }
  return li;
}
