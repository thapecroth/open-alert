/**
 * WebGL availability gate — probes for the WebGL2 context the three.js renderer
 * hard-requires BEFORE the engine is constructed, and renders a full-screen,
 * impossible-to-miss recovery modal when the GPU path is missing or the engine
 * fails to initialize. Kept dependency-free on purpose: this module must run
 * even when every other part of the client fails to boot.
 */

export interface WebGLProbe {
  ok: boolean;
  detail: string;
}

export function probeWebGL2(): WebGLProbe {
  try {
    const c = document.createElement("canvas");
    const gl = c.getContext("webgl2");
    if (gl) return { ok: true, detail: "" };
    // webgl2 failing leaves the canvas context-less, so a webgl1 probe on the
    // same canvas is still a valid diagnostic of what the browser CAN do.
    const gl1 = c.getContext("webgl") ?? c.getContext("experimental-webgl");
    return {
      ok: false,
      detail: gl1
        ? "WebGL1 is available, but Open Alert needs WebGL2 — your browser or GPU driver is too old, or hardware acceleration is disabled."
        : "The browser refused to create any WebGL context — WebGL is disabled, blocked, or no GPU is available.",
    };
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
}

/** True when an engine-boot failure smells like a WebGL/GPU problem rather than a game bug. */
export function isWebGLBootError(err: unknown): boolean {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return /webgl|web gl|gl context|graphics context|gpu|three\.webglrenderer/.test(msg);
}

function row(browser: string, steps: string): HTMLElement {
  const tr = document.createElement("div");
  tr.className = "webgl-how-row";
  const b = document.createElement("b");
  b.textContent = browser;
  const s = document.createElement("span");
  s.textContent = steps;
  tr.append(b, s);
  return tr;
}

export function showWebGLModal(detail: string): void {
  if (document.getElementById("webgl-modal")) return;
  const root = document.createElement("div");
  root.id = "webgl-modal";
  root.setAttribute("role", "alertdialog");
  root.setAttribute("aria-modal", "true");

  const panel = document.createElement("div");
  panel.className = "webgl-panel";

  const title = document.createElement("h1");
  title.textContent = "WEBGL IS REQUIRED";
  const sub = document.createElement("p");
  sub.className = "webgl-sub";
  sub.textContent =
    "Open Alert renders its 3D battlefield with WebGL2, but this browser could not create a WebGL context — the game cannot start until hardware graphics are enabled.";

  const how = document.createElement("div");
  how.className = "webgl-how";
  const howTitle = document.createElement("h2");
  howTitle.textContent = "HOW TO ENABLE WEBGL";
  how.append(
    howTitle,
    row("Chrome / Edge", "Settings → System → turn ON “Use graphics acceleration” → Relaunch. Verify on chrome://gpu that WebGL is hardware accelerated."),
    row("Firefox", "about:config → accept the risk → set webgl.disabled to false → restart Firefox."),
    row("Safari", "Safari → Settings → Advanced → enable “Show Develop menu”, then Develop → Experimental Features → make sure WebGL / WebGL2 is on."),
  );

  const notes = document.createElement("p");
  notes.className = "webgl-notes";
  notes.textContent =
    "Then update your browser and GPU drivers and restart the browser after every change. Some corporate machines, VMs and remote-desktop sessions disable GPU access entirely — if nothing helps, try another browser or a different machine.";

  const actions = document.createElement("div");
  actions.className = "webgl-actions";
  const retry = document.createElement("button");
  retry.id = "webgl-retry";
  retry.textContent = "RETRY";
  retry.addEventListener("click", () => location.reload());
  actions.append(retry);

  panel.append(title, sub, how, notes, actions);
  if (detail) {
    const small = document.createElement("p");
    small.className = "webgl-detail";
    small.textContent = `Error detail: ${detail}`;
    panel.append(small);
  }
  root.append(panel);
  document.body.append(root);
}
