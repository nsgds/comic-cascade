// Global light/dark theme, shared by the directory and the reader. The actual
// colors live in CSS variables (:root vs :root[data-theme="light"]); this just
// flips the attribute, persists the choice, and keeps the browser theme-color in
// sync. A tiny inline script in index.html applies the saved theme before first
// paint to avoid a flash.

const KEY = "cc.theme";
const THEME_COLOR = { dark: "#0a0a0a", light: "#f3eef8" };

export function getTheme() {
  return localStorage.getItem(KEY) === "light" ? "light" : "dark";
}

export function applyTheme(theme) {
  document.documentElement.setAttribute("data-theme", theme);
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute("content", THEME_COLOR[theme] || THEME_COLOR.dark);
}

export function setTheme(theme) {
  localStorage.setItem(KEY, theme);
  applyTheme(theme);
}

export function toggleTheme() {
  const next = getTheme() === "light" ? "dark" : "light";
  setTheme(next);
  return next;
}
