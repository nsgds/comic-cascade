// Thin wrappers over the read-only JSON API.

async function request(url, options) {
  const res = await fetch(url, options);
  if (!res.ok) {
    const err = new Error(`HTTP ${res.status}`);
    err.status = res.status;
    try {
      err.detail = (await res.json()).detail;
    } catch {
      /* no body */
    }
    throw err;
  }
  return res.status === 204 ? null : res.json();
}

export const getJSON = (url) => request(url);

const q = encodeURIComponent;

export const api = {
  // returns { libraries: [{id,name}], managed: bool }
  libraries: () => getJSON("/api/libraries"),

  tree: (library, path = "", showAll = false) =>
    getJSON(`/api/tree?library=${q(library)}&path=${q(path)}&show_all=${showAll ? 1 : 0}`),

  comic: (library, path) =>
    getJSON(`/api/comic?library=${q(library)}&path=${q(path)}`),

  pageURL: (library, path, index) =>
    `/api/page?library=${q(library)}&path=${q(path)}&index=${index}`,

  // ---- per-user reading progress (server tier; inert without an identity) ----
  progressGet: (library, path) =>
    getJSON(`/api/progress?library=${q(library)}&path=${q(path)}`),

  progressSet: (body) =>
    request("/api/progress", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),

  // (Forgetting is a page-0 tombstone POST via progressSet — see progress.js.
  //  The server's DELETE endpoint still exists for true removal, but the app
  //  never calls it: a deleted row can't shadow other devices' stale copies.)
  progressRecent: () => getJSON("/api/progress/recent"),

  // ---- library management (only when the server has a browse root) ----
  fsList: (path = "") => getJSON(`/api/fs?path=${q(path)}`),

  addLibrary: (name, path) =>
    request("/api/libraries", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, path }),
    }),

  removeLibrary: (id) => request(`/api/libraries/${q(id)}`, { method: "DELETE" }),

  reorderLibraries: (ids) =>
    request("/api/libraries/order", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ order: ids }),
    }),
};
