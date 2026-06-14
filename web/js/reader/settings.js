// Persisted reader preferences (mode / reading direction / page gap). These are
// global defaults; a specific deep-link can override them via URL params.

const KEY = "cc.reader";
const DEFAULTS = { mode: "vertical", rtl: false, gap: 8, pinned: true };

export const GAP_MIN = 0;
export const GAP_MAX = 64;
export const GAP_STEP = 8;

export function loadSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) || "{}");
    return {
      mode: saved.mode === "horizontal" ? "horizontal" : "vertical",
      rtl: !!saved.rtl,
      gap: clampGap(saved.gap ?? DEFAULTS.gap),
      pinned: saved.pinned !== false, // default pinned
    };
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveSettings(s) {
  localStorage.setItem(
    KEY,
    JSON.stringify({
      mode: s.mode,
      rtl: !!s.rtl,
      gap: clampGap(s.gap),
      pinned: s.pinned !== false,
    }),
  );
}

export function clampGap(g) {
  g = Number(g);
  if (!Number.isFinite(g)) return DEFAULTS.gap;
  return Math.max(GAP_MIN, Math.min(GAP_MAX, Math.round(g)));
}
