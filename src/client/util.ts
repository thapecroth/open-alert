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

export function fmtCost(n: number) {
  return "$" + n.toLocaleString();
}
