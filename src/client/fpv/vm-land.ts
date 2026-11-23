// Land-domain 1P viewmodels (infantry, engineer, rocket + all ground vehicles).
// Each entry fully replaces the legacy fpv.ts cockpit branch for that kind.
import type { UnitKind } from "../../shared/gamedefs";
import type { VmKit } from "./vmkit";

export const LAND_VM: Partial<Record<UnitKind, (kit: VmKit) => void>> = {};
