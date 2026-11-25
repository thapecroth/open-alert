// Client-error telemetry — important-only reporting of uncaught exceptions,
// unhandled promise rejections, and console.error calls to the room's ring
// buffer on the server. Plain HTTP POST (never the game websocket): the
// dead-socket failure mode is exactly what this pipeline exists to diagnose.
//
// Noise discipline (per design): no warnings, no info, no lifecycle chatter.
// Valueless reports are dropped client-side: anonymous cross-origin
// "Script error." events carry zero information, and browser-extension noise
// never reaches us. Repeats of the same message coalesce server-side; here we
// hard-cap throughput so a throwing render loop cannot flood (max 6/min).

export interface TelemetryCtx {
  room: string;
  name: string;
  phase: () => string;
  slot: () => number;
}

let ctx: TelemetryCtx | null = null;
let sentAt: number[] = []; // timestamps of the last minute's reports
let installed = false;

const clip = (s: unknown, max: number) => String(s ?? "").slice(0, max);

function report(kind: string, msg: string, stack?: string) {
  if (!ctx) return;
  // valueless cross-origin noise — no message, no stack, no diagnosis possible
  if (msg === "Script error." || !msg) return;
  const now = Date.now();
  sentAt = sentAt.filter((t) => now - t < 60_000);
  if (sentAt.length >= 6) return;
  sentAt.push(now);
  const payload = {
    room: ctx.room,
    name: clip(ctx.name, 40),
    kind,
    msg: clip(msg, 500),
    stack: stack ? clip(stack, 800) : undefined,
    phase: clip(ctx.phase(), 12),
    slot: ctx.slot(),
    ua: clip(navigator.userAgent, 140),
  };
  try {
    void fetch("/client-error", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      keepalive: true,
    }).catch(() => {});
  } catch {
    /* telemetry must never break the game */
  }
}

export function installTelemetry(c: TelemetryCtx) {
  if (installed) return;
  installed = true;
  ctx = c;

  window.addEventListener("error", (ev) => {
    report("exception", ev.message, ev.error instanceof Error ? ev.error.stack : undefined);
  });
  window.addEventListener("unhandledrejection", (ev) => {
    const r = ev.reason;
    report("rejection", r instanceof Error ? r.message : clip(r, 500), r instanceof Error ? r.stack : undefined);
  });

  const origError = console.error.bind(console);
  console.error = (...args: unknown[]) => {
    try {
      const msg = args
        .map((a) => (a instanceof Error ? a.message : typeof a === "string" ? a : JSON.stringify(a)))
        .join(" ");
      const stack = args.find((a) => a instanceof Error);
      report("console.error", msg, stack instanceof Error ? stack.stack : undefined);
    } catch {
      /* never recurse */
    }
    origError(...args);
  };
}
