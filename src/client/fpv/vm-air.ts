// Air-domain 1P viewmodels (jets, drones, helicopters, gunships, airship).
// Each entry fully replaces the legacy fpv.ts cockpit branch for that kind.
import type { UnitKind } from "../../shared/gamedefs";
import type { VmKit } from "./vmkit";

export const AIR_VM: Partial<Record<UnitKind, (kit: VmKit) => void>> = {};
