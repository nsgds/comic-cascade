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
const topbarEl = document.getElementById("topbar");
const selectEl = document.getElementById("library-select");

// The continue-reading row sticks directly below the top bar, whose height
// varies (wraps to two rows on narrow screens, changes when the picker
// appears) — publish the rendered height for the CSS `top` to consume.
// getBoundingClientRect, not offsetHeight: the bar's real height can be
// fractional (the picker row's rem padding) and the integer-rounded value
// would pin the row a sub-pixel below the bar's true bottom edge.
new ResizeObserver(() => {
  const h = topbarEl.getBoundingClientRect().height;
  document.documentElement.style.setProperty("--topbar-h", `${h}px`);
}).observe(topbarEl);
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

// params (optional): a browse deep link's query — ?sel= expands the tree to
// that path and highlights it (the reader's Back button links here).
function renderBrowse(params) {
  if (!state.library) {
    view.innerHTML = `<div class="center-msg">No libraries configured.</div>`;
    return;
  }
  view.innerHTML = "";
  const resumeHost = document.createElement("div");
  resumeHost.className = "resume-host"; // sticky below the top bar (app.css)
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
  }, params ? params.get("sel") : null);
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
    // A browse deep link may name a library other than the active one (the
    // Back button of a comic opened from a continue-reading chip, say) —
    // adopt it so the tree being revealed is the one the path lives in.
    const lib = params.get("lib");
    if (lib && lib !== state.library && state.libraries.some((l) => l.id === lib)) {
      state.library = lib;
      localStorage.setItem("cc.library", lib);
      selectEl.value = lib;
    }
    renderBrowse(params);
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
    // Reset any deep-linked hash (#/read…, or #/?lib&sel from a Back link):
    // its params describe the OLD library and a refresh would flip back to it.
    // The hash change re-renders via route(); a bare hash renders directly.
    if (location.hash && location.hash !== "#/") location.hash = "/";
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
