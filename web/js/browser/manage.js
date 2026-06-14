// "Manage libraries" modal: list + remove existing libraries, and add a new one
// by navigating a directory picker confined to the server's browse root.

import { api } from "../api.js";

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

export function openManageModal({ onChange }) {
  const overlay = el("div", "modal-overlay");
  const modal = el("div", "modal");
  overlay.appendChild(modal);

  const head = el("div", "modal-head");
  head.appendChild(el("span", null, "Libraries"));
  const closeBtn = el("button", "icon-btn", "✕");
  head.appendChild(closeBtn);
  modal.appendChild(head);

  const body = el("div", "modal-body");
  const libList = el("ul", "lib-list");
  body.appendChild(libList);

  const addBox = el("div", "add-lib");
  addBox.appendChild(el("div", "add-head", "Add a library"));
  const crumb = el("div", "picker-crumb");
  const pickList = el("ul", "picker-list");
  const addRow = el("div", "add-row");
  const nameInput = el("input", "lib-name");
  nameInput.placeholder = "Library name";
  const addBtn = el("button", "primary-btn", "Add this folder");
  addRow.append(nameInput, addBtn);
  const addError = el("div", "add-error");
  addBox.append(crumb, pickList, addRow, addError);
  body.appendChild(addBox);
  modal.appendChild(body);

  document.body.appendChild(overlay);

  const close = () => overlay.remove();
  closeBtn.onclick = close;
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) close();
  });
  document.addEventListener("keydown", function esc(e) {
    if (e.key === "Escape") {
      close();
      document.removeEventListener("keydown", esc);
    }
  });

  let current = ""; // path relative to the browse root
  let dragging = false; // a row drag is in progress (blocks concurrent mutations)

  // Persist a given id order, then resync the list + picker from the server.
  async function commitOrder(ids) {
    try {
      await api.reorderLibraries(ids);
    } finally {
      await refreshLibs();
      onChange();
    }
  }

  // Accessible reorder: move one library up/down (keyboard alternative to dragging).
  async function moveById(id, dir) {
    if (dragging) return; // a reorder (drag or a prior keypress) is already in flight
    const ids = [...libList.querySelectorAll("li[data-id]")].map((r) => r.dataset.id);
    const i = ids.indexOf(id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j], ids[i]];
    dragging = true; // serialize rapid key-repeat: ignore further moves until this lands
    try {
      await commitOrder(ids);
    } finally {
      dragging = false;
    }
    const handle = libList.querySelector(`li[data-id="${CSS.escape(id)}"] .drag-handle`);
    if (handle) handle.focus(); // keep focus on the row the user just moved
  }

  // The library row whose midpoint sits below `y` (the drop should land before it),
  // or null to drop at the end. Excludes the row being dragged.
  function rowAfter(y, dragged) {
    const rows = [...libList.querySelectorAll("li[data-id]")].filter((r) => r !== dragged);
    for (const r of rows) {
      const box = r.getBoundingClientRect();
      if (y < box.top + box.height / 2) return r;
    }
    return null;
  }

  // Pointer-driven drag-to-reorder: the row lifts and follows the finger/cursor
  // while a placeholder marks where it will land. Works for touch, mouse, and pen.
  function startDrag(li, e) {
    if (!e.isPrimary) return; // ignore secondary touch points (no double-drag)
    if (e.pointerType === "mouse" && e.button !== 0) return; // left mouse only
    e.preventDefault();
    e.currentTarget?.focus?.({ preventScroll: true }); // preventDefault suppresses
    // the click-focus, so focus the handle explicitly → click-then-↑/↓ works.

    dragging = true;
    const modalBody = libList.closest(".modal-body");
    modalBody?.classList.add("dragging-lock"); // freeze modal scroll during the drag

    const initial = [...libList.querySelectorAll("li[data-id]")].map((r) => r.dataset.id);
    const rect = li.getBoundingClientRect();
    const startY = e.clientY;

    const placeholder = el("li", "lib-placeholder");
    placeholder.style.height = `${rect.height}px`;
    li.before(placeholder);

    li.classList.add("dragging");
    Object.assign(li.style, {
      position: "fixed",
      boxSizing: "border-box",
      left: `${rect.left}px`,
      top: `${rect.top}px`,
      width: `${rect.width}px`,
      margin: "0",
    });
    libList.classList.add("dragging-active");
    li.setPointerCapture(e.pointerId);

    const onMove = (ev) => {
      li.style.transform = `translateY(${ev.clientY - startY}px)`;
      const after = rowAfter(ev.clientY, li);
      if (after == null) libList.appendChild(placeholder);
      else if (after !== placeholder) libList.insertBefore(placeholder, after);
    };
    const cleanup = (ev) => {
      li.removeEventListener("pointermove", onMove);
      li.removeEventListener("pointerup", onUp);
      li.removeEventListener("pointercancel", onCancel);
      try {
        li.releasePointerCapture(ev.pointerId);
      } catch {
        /* pointer already gone */
      }
      li.classList.remove("dragging");
      li.removeAttribute("style");
      libList.classList.remove("dragging-active");
      modalBody?.classList.remove("dragging-lock");
      dragging = false;
    };
    const onUp = async (ev) => {
      cleanup(ev);
      // If the list was rebuilt mid-drag, the placeholder is detached — resync
      // from the server rather than dropping the row into nothing.
      if (!placeholder.isConnected) return refreshLibs();
      placeholder.replaceWith(li); // drop the row into the placeholder's slot
      const order = [...libList.querySelectorAll("li[data-id]")].map((r) => r.dataset.id);
      if (order.join("\n") !== initial.join("\n")) await commitOrder(order);
    };
    const onCancel = async (ev) => {
      // System-interrupted gesture: abort without persisting, restoring the order.
      cleanup(ev);
      placeholder.remove();
      await refreshLibs();
    };
    li.addEventListener("pointermove", onMove);
    li.addEventListener("pointerup", onUp);
    li.addEventListener("pointercancel", onCancel);
  }

  async function refreshLibs() {
    const { libraries } = await api.libraries();
    libList.innerHTML = "";
    if (libraries.length === 0) {
      libList.appendChild(el("li", "muted", "No libraries yet — add one below."));
      return;
    }

    const draggable = libraries.length > 1;
    for (const lib of libraries) {
      const li = el("li");
      li.dataset.id = lib.id;

      const left = el("span", "lib-left");
      if (draggable) {
        // A real <button> so it's keyboard-focusable; drag with a pointer, or
        // focus it and press ↑/↓ to reorder without a mouse.
        const handle = el("button", "drag-handle", "⠿");
        handle.type = "button";
        handle.title = "Drag, or press ↑ / ↓, to reorder";
        handle.setAttribute("aria-label", `Reorder ${lib.name}: drag, or press Arrow Up / Arrow Down`);
        handle.addEventListener("pointerdown", (ev) => startDrag(li, ev));
        handle.addEventListener("keydown", (ev) => {
          if (ev.key === "ArrowUp") {
            ev.preventDefault();
            moveById(lib.id, -1);
          } else if (ev.key === "ArrowDown") {
            ev.preventDefault();
            moveById(lib.id, 1);
          }
        });
        left.appendChild(handle);
      }
      left.appendChild(el("span", "lib-name-label", `📁 ${lib.name}`));

      const rm = el("button", "remove-btn", "Remove");
      rm.onclick = async () => {
        if (dragging) return; // never mutate the list mid-drag
        rm.disabled = true;
        await api.removeLibrary(lib.id);
        await refreshLibs();
        onChange();
      };

      li.append(left, rm);
      libList.appendChild(li);
    }
  }

  async function loadPicker(path) {
    addError.textContent = "";
    let data;
    try {
      data = await api.fsList(path);
    } catch {
      addError.textContent = "Can't open that folder.";
      return;
    }
    current = data.path;

    crumb.innerHTML = "";
    const crumbBtn = (label, p) => {
      const b = el("button", "crumb", label);
      b.onclick = () => loadPicker(p);
      return b;
    };
    crumb.appendChild(crumbBtn("⌂", ""));
    let acc = "";
    for (const part of current ? current.split("/") : []) {
      acc = acc ? `${acc}/${part}` : part;
      crumb.appendChild(document.createTextNode(" / "));
      crumb.appendChild(crumbBtn(part, acc));
    }

    pickList.innerHTML = "";
    if (data.dirs.length === 0) {
      pickList.appendChild(el("li", "muted", "(no subfolders here)"));
    }
    for (const d of data.dirs) {
      const li = el("li", "pick-dir", `📁 ${d}`);
      li.onclick = () => loadPicker(current ? `${current}/${d}` : d);
      pickList.appendChild(li);
    }

    const segs = current ? current.split("/") : [];
    nameInput.value = segs.length ? segs[segs.length - 1] : "";
  }

  addBtn.onclick = async () => {
    addError.textContent = "";
    addBtn.disabled = true;
    try {
      await api.addLibrary(nameInput.value, current);
      await refreshLibs();
      onChange();
    } catch (e) {
      addError.textContent = e.detail || "Couldn't add this folder.";
    } finally {
      addBtn.disabled = false;
    }
  };

  refreshLibs();
  loadPicker("");
}
