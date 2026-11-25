/**
 * Client bootstrap entry — gates the game module behind a WebGL2 probe so a
 * missing/disabled GPU path produces a readable recovery modal instead of a
 * dead black page. The probe runs BEFORE the three.js engine is constructed;
 * the dynamic import additionally catches synchronous engine-init failure
 * (e.g. the context creation race the probe cannot see) as a fallback.
 */
import { probeWebGL2, showWebGLModal, isWebGLBootError } from "./webgl-gate";

const probe = probeWebGL2();
if (!probe.ok) {
  showWebGLModal(probe.detail);
} else {
  import("./main").catch((err) => {
    if (isWebGLBootError(err) || !probeWebGL2().ok) {
      showWebGLModal(err instanceof Error ? err.message : String(err));
    } else {
      // Not a GPU problem — keep real bugs loud in the console instead of
      // disguising them behind the wrong instructions.
      throw err;
    }
  });
}
