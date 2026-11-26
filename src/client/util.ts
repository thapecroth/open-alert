import { BUILDINGS, BuildingKind, EntKind, UnitKind, UNITS } from "../shared/gamedefs";

export { BUILDINGS, UNITS };
export type { BuildingKind, EntKind, UnitKind };

export function isBuildingKind(k: EntKind): k is BuildingKind {
  return k in BUILDINGS;
}

export function isUnitKind(k: EntKind): k is UnitKind {
  return k in UNITS;
}

export function el<T extends HTMLElement = HTMLElement>(id: string): T {
  const e = document.getElementById(id);
  if (!e) throw new Error("missing #" + id);
  return e as T;
}


export function toggleFullscreen() {
  if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
  else void document.documentElement.requestFullscreen().catch(() => {});
}

// Keyboard Lock (Chromium, fullscreen-only): captures browser accelerators like
// Ctrl/Cmd+1..9, Ctrl+W, Ctrl+Tab so they reach the game instead of the browser.
// Escape is never capturable (always exits fullscreen) per spec.
interface KeyboardLockCapable {
  lock?: (keyCodes?: string[]) => Promise<void>;
  unlock?: () => void;
}

export function syncKeyboardLock() {
  const kb = (navigator as unknown as { keyboard?: KeyboardLockCapable }).keyboard;
  if (!kb?.lock) return;
  if (document.fullscreenElement) {
    void kb.lock().catch(() => {});
  } else {
    kb.unlock?.();
  }
}

export function fmtCost(n: number) {
  return "$" + n.toLocaleString();
}
