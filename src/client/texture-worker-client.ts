import type { MapId } from "../shared/gamedefs";
import type { TextureJobKind, TextureJobResponse, TextureJobTextureMap } from "./texture-protocol";

export interface TextureJobResult {
  textures: TextureJobTextureMap;
}

export class TextureJobCancelledError extends Error {
  constructor() {
    super("Texture generation job cancelled");
    this.name = "TextureJobCancelledError";
  }
}

export function isTextureJobCancelled(err: unknown): boolean {
  return err instanceof TextureJobCancelledError;
}

function textureWorkersSupported(): boolean {
  return typeof Worker !== "undefined" && typeof OffscreenCanvas !== "undefined";
}

function createWorker(name: string): Worker {
  return new Worker(new URL("./texture-worker.ts", import.meta.url), { type: "module", name });
}

// Small singleton textures share one worker. Their jobs are tens of milliseconds
// at most, while battlefield generation gets a dedicated cancellable worker so
// a stale map never delays a newly selected theater behind a 1024x1024 job.
let staticWorker: Worker | null = null;
let staticWorkerBroken = false;
let nextJobId = 1;
const staticPending = new Map<
  number,
  { resolve: (result: TextureJobResult) => void; reject: (err: Error) => void }
>();

function failStaticJobs(err: Error): void {
  for (const pending of staticPending.values()) pending.reject(err);
  staticPending.clear();
  staticWorker?.terminate();
  staticWorker = null;
  staticWorkerBroken = true;
}

function getStaticWorker(): Worker | null {
  if (!textureWorkersSupported() || staticWorkerBroken) return null;
  if (staticWorker) return staticWorker;
  try {
    const worker = createWorker("oa-texture-static");
    worker.addEventListener("message", (event) => {
      const response = (event as MessageEvent<TextureJobResponse>).data;
      const pending = staticPending.get(response.id);
      if (!pending) return;
      staticPending.delete(response.id);
      if (response.error) {
        pending.reject(new Error(`Texture worker ${response.kind} job failed: ${response.error}`));
      } else if (response.textures) {
        pending.resolve({ textures: response.textures });
      } else {
        pending.reject(new Error(`Texture worker ${response.kind} job returned no textures`));
      }
    });
    worker.addEventListener("error", (event) => {
      failStaticJobs(new Error(event.message || "Texture worker crashed"));
    });
    staticWorker = worker;
    return worker;
  } catch {
    staticWorkerBroken = true;
    return null;
  }
}

export function requestStaticTextureJob(kind: Exclude<TextureJobKind, "battlefield">): Promise<TextureJobResult> | null {
  const worker = getStaticWorker();
  if (!worker) return null;
  const id = nextJobId++;
  try {
    const promise = new Promise<TextureJobResult>((resolve, reject) => {
      staticPending.set(id, { resolve, reject });
    });
    worker.postMessage({ id, kind });
    return promise;
  } catch (err) {
    staticPending.delete(id);
    return null;
  }
}

interface BattlefieldSession {
  worker: Worker;
  cleanup: () => void;
  reject: (err: Error) => void;
  mapId: MapId;
  promise?: Promise<TextureJobResult>;
}

let battlefieldSession: BattlefieldSession | null = null;

export function cancelBattlefieldTextureJob(): void {
  const session = battlefieldSession;
  if (!session) return;
  battlefieldSession = null;
  session.cleanup();
  session.worker.terminate();
  session.reject(new TextureJobCancelledError());
}

export function requestBattlefieldTextureJob(mapId: MapId): Promise<TextureJobResult> | null {
  // Lobby prewarm and the synchronous init path can request the same theater in
  // quick succession. Share the in-flight job in that case instead of throwing
  // away a nearly complete 1024x1024 bake and restarting it.
  const existing = battlefieldSession;
  if (existing?.mapId === mapId && existing.promise) return existing.promise;
  cancelBattlefieldTextureJob();
  if (!textureWorkersSupported()) return null;

  let worker: Worker;
  try {
    worker = createWorker("oa-texture-battlefield");
  } catch {
    return null;
  }

  const id = nextJobId++;
  let cleanup = () => {};
  const promise = new Promise<TextureJobResult>((resolve, reject) => {
    const finish = () => {
      if (battlefieldSession?.worker === worker) battlefieldSession = null;
      cleanup();
    };
    const onMessage = (event: Event) => {
      const response = (event as MessageEvent<TextureJobResponse>).data;
      if (response.id !== id) return;
      finish();
      worker.terminate();
      if (response.error) {
        reject(new Error(`Battlefield texture worker failed: ${response.error}`));
      } else if (response.textures) {
        resolve({ textures: response.textures });
      } else {
        reject(new Error("Battlefield texture worker returned no textures"));
      }
    };
    const onError = (event: Event) => {
      finish();
      worker.terminate();
      reject(new Error(event instanceof ErrorEvent ? event.message : "Battlefield texture worker crashed"));
    };
    cleanup = () => {
      worker.removeEventListener("message", onMessage);
      worker.removeEventListener("error", onError);
    };
    worker.addEventListener("message", onMessage);
    worker.addEventListener("error", onError);
    battlefieldSession = { worker, cleanup, reject, mapId };
    try {
      worker.postMessage({ id, kind: "battlefield", mapId });
    } catch (err) {
      finish();
      worker.terminate();
      reject(err instanceof Error ? err : new Error(String(err)));
    }
  });
  if (battlefieldSession?.worker === worker) battlefieldSession.promise = promise;
  return promise;
}
