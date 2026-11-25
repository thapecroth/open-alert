// Shared websocket test harness for the v2 keyframe+delta wire protocol.
// Connects to a room and reassembles the delta stream through the SAME
// SnapReassembler the browser client uses (src/shared/snapdelta.ts), so
// st.snaps holds full snapshots exactly like the legacy protocol exposed —
// plus raw protocol stats (st.proto) for keyframe/delta coverage assertions.
//
// opts.v: protocol version stamped on join — 2 (default) opts into the delta
// stream; 1/legacy exercises the backward-compatible full-snapshot fanout.
// opts.onmsg(m, st): hook invoked with the EFFECTIVE message (reassembled full
// snapshot for snap frames, raw message otherwise; dropped deltas never reach it).
// opts.spectate: join explicitly as a spectator instead of taking a player slot.

import { registerHooks, createRequire } from "node:module";
const require = createRequire(new URL("../package.json", import.meta.url));
const ts = require("typescript");

registerHooks({
  resolve(specifier, context, next) {
    try {
      return next(specifier, context);
    } catch (err) {
      if ((specifier.startsWith("./") || specifier.startsWith("../")) && !/\.[a-z0-9]+$/i.test(specifier)) {
        return next(specifier + ".ts", context);
      }
      throw err;
    }
  },
  load(url, context, next) {
    const res = next(url, context);
    if (url.endsWith(".ts")) {
      const out = ts.transpileModule(String(res.source), {
        compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
        fileName: url,
      });
      return { format: "module", source: out.outputText, shortCircuit: true };
    }
    return res;
  },
});

const { SnapReassembler } = await import("../src/shared/snapdelta.ts");

export function wsconn(url, name, token, opts = {}) {
  const ws = new WebSocket(url);
  const rx = new SnapReassembler();
  const st = {
    ws,
    rx,
    msgs: [], // raw wire messages (including raw snap/snapd frames)
    slot: null,
    you: null,
    snaps: [], // reassembled FULL snapshots — same shape the legacy protocol exposed
    lobby: null,
    closed: false,
    proto: { key: 0, delta: 0, droppedDelta: 0, keyBytes: 0, deltaBytes: 0, fullLegacy: 0, fullLegacyBytes: 0 },
  };
  ws.onmessage = (e) => {
    let m = JSON.parse(e.data);
    st.msgs.push(m);
    if (m.t === "init") {
      st.you = m.you;
      st.slot = m.slot;
      rx.reset();
    } else if (m.t === "snap" || m.t === "snapd") {
      const bytes = typeof e.data === "string" ? e.data.length : 0;
      let full = null;
      if (m.t === "snap") {
        full = rx.keyframe(m);
        if (m.key) {
          st.proto.key++;
          st.proto.keyBytes += bytes;
        } else {
          st.proto.fullLegacy++;
          st.proto.fullLegacyBytes += bytes;
        }
      } else {
        full = rx.delta(m);
        st.proto.delta++;
        st.proto.deltaBytes += bytes;
        if (!full) st.proto.droppedDelta++;
      }
      if (full) {
        st.snaps.push(full);
        m = full; // hooks see the reassembled frame, exactly like the browser client
      } else {
        return; // dropped delta — invisible to consumers, just like the browser client
      }
    }
    opts.onmsg?.(m, st);
  };
  ws.onclose = (e) => {
    st.closed = true;
    opts.onclose?.(e, st);
  };
  ws.onerror = () => opts.onerror?.(st);
  ws.onopen = () => {
    const join = { t: "join", name, token };
    if (opts.v !== 1) join.v = 2;
    if (opts.spectate) join.spectate = true;
    ws.send(JSON.stringify(join));
    opts.onopen?.(st);
  };
  return st;
}

// Browser-like send: real clients queue commands while the socket is still
// connecting (PartySocket offline queue). Mirror that instead of throwing —
// test flows routinely fire inputs right after constructing a connection.
export const send = (st, m) => {
  const data = JSON.stringify(m);
  if (st.ws.readyState === 1) return st.ws.send(data);
  if (st.ws.readyState === 0) {
    const iv = setInterval(() => {
      if (st.ws.readyState === 1) {
        clearInterval(iv);
        try {
          st.ws.send(data);
        } catch {
          /* closed meanwhile */
        }
      } else if (st.ws.readyState > 1) clearInterval(iv);
    }, 25);
    setTimeout(() => clearInterval(iv), 5000).unref?.();
    iv.unref?.();
  }
};
export const lastSnap = (st) => st.snaps[st.snaps.length - 1];
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
