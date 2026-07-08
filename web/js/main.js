// App bootstrap + hash router: routes between the browse (file tree) and reader
// views, and wires the library picker, manage modal, and theme toggle.

import { api } from "./api.js";
import { renderLibraryPicker } from "./browser/libraries.js";
import { renderResumeRow } from "./browser/resume.js";
import { renderTree } from "./browser/tree.js";
import { openManageModal } from "./browser/manage.js";
import { setScope, setServerEnabled } from "./progress.js";
import { renderReader } from "./reader/reader.js";
import { applyTheme, getTheme, toggleTheme } from "./theme.js";

const view = document.getElementById("view");
const selectEl = document.getElementById("library-select");
const showAllEl = document.getElementById("show-all");
const manageBtn = document.getElementById("manage-btn");
const themeBtn = document.getElementById("theme-btn");

function syncThemeBtn() {
  // show the action (the theme you'll switch TO)
  const dark = getTheme() === "dark";
  themeBtn.textContent = dark ? "☀" : "🌙";
  themeBtn.title = dark ? "Switch to light mode" : "Switch to dark mode";
}
applyTheme(getTheme()); // also syncs theme-color meta on initial load
syncThemeBtn();
themeBtn.addEventListener("click", () => {
  toggleTheme();
  syncThemeBtn();
});

const state = {
  libraries: [],
  managed: false,
  library: localStorage.getItem("cc.library"),
  showAll: localStorage.getItem("cc.showAll") === "1",
};

function parseHash() {
  const h = location.hash.replace(/^#\/?/, "");
  const qi = h.indexOf("?");
  const name = qi >= 0 ? h.slice(0, qi) : h;
  const params = new URLSearchParams(qi >= 0 ? h.slice(qi + 1) : "");
  return { name, params };
}

function openComic(path) {
  location.hash =
    `/read?lib=${encodeURIComponent(state.library)}&path=${encodeURIComponent(path)}`;
}

function renderBrowse() {
  if (!state.library) {
    view.innerHTML = `<div class="center-msg">No libraries configured.</div>`;
    return;
  }
  view.innerHTML = "";
  const resumeHost = document.createElement("div");
  const treeHost = document.createElement("div");
  view.append(resumeHost, treeHost);
  // The row is cross-library and deep-links with the page: tapping a chip is an
  // explicit "continue", so the reader jumps straight there (no pill).
  renderResumeRow(resumeHost, {
    onOpen: (item) => {
      location.hash =
        `/read?lib=${encodeURIComponent(item.library)}` +
        `&path=${encodeURIComponent(item.path)}&page=${item.page}`;
    },
  });
  renderTree(treeHost, {
    library: state.library,
    showAll: state.showAll,
    onOpenComic: openComic,
  });
}

let readerTeardown = null;

function route() {
  if (readerTeardown) {
    readerTeardown();
    readerTeardown = null;
  }
  syncThemeBtn(); // theme may have been toggled from the reader menu
  const { name, params } = parseHash();
  if (name === "read") {
    readerTeardown = renderReader(view, {
      library: params.get("lib") || state.library,
      path: params.get("path"),
      query: params,
    });
  } else {
    renderBrowse();
  }
}

function applyLibrariesData(data) {
  state.libraries = data.libraries;
  state.managed = data.managed;
  // can_manage folds in the optional admin allowlist; fall back to managed for
  // older servers that don't report it.
  state.canManage = data.can_manage ?? data.managed;
  // Server-side read progress is available iff this session has a proxy identity;
  // the scope token partitions LOCAL progress per user on shared browsers.
  setServerEnabled(data.progress ?? false);
  setScope(data.progress_scope ?? null);

  if (!state.libraries.find((l) => l.id === state.library)) {
    state.library = state.libraries[0]?.id || null;
  }
  if (state.library) localStorage.setItem("cc.library", state.library);

  renderLibraryPicker(selectEl, state.libraries, state.library, (id) => {
    state.library = id;
    localStorage.setItem("cc.library", id);
    if (parseHash().name === "read") location.hash = "/";
    else renderBrowse();
  });
  manageBtn.hidden = !state.canManage;
}

// Called by the manage modal after add/remove so the picker + tree stay in sync.
async function reloadLibraries() {
  applyLibrariesData(await api.libraries());
  if (parseHash().name !== "read") renderBrowse();
}

async function boot() {
  showAllEl.checked = state.showAll;
  showAllEl.addEventListener("change", () => {
    state.showAll = showAllEl.checked;
    localStorage.setItem("cc.showAll", state.showAll ? "1" : "0");
    if (parseHash().name !== "read") renderBrowse();
  });

  manageBtn.addEventListener("click", () =>
    openManageModal({ onChange: reloadLibraries }),
  );

  let data;
  try {
    data = await api.libraries();
  } catch (e) {
    view.innerHTML = `<div class="center-msg tree-error">Could not reach the server.</div>`;
    return;
  }
  applyLibrariesData(data);

  window.addEventListener("hashchange", route);
  route();
}

boot();
