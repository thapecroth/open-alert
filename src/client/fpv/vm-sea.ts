// Sea-domain 1P viewmodels (ships, sub, kamikaze USV, carrier).
// Each entry fully replaces the legacy fpv.ts cockpit branch for that kind.
import type { UnitKind } from "../../shared/gamedefs";
import type { VmKit } from "./vmkit";

export const SEA_VM: Partial<Record<UnitKind, (kit: VmKit) => void>> = {};
