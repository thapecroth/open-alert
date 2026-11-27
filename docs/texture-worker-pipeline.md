# Procedural texture worker pipeline

Open Alert generates its battlefield terrain and shared PBR detail maps procedurally. The large battlefield set is 1024x1024 pixels per channel and used to block the main thread for roughly a second whenever a new theater loaded. The generation pipeline is therefore split into deterministic generation code and platform-specific canvas adoption:

- `src/client/texture-core.ts` contains all procedural generation logic. It has no three.js or DOM dependency; callers provide a canvas factory. The same seeds, pixel-loop order, and canvas operation order are used on every path.
- `src/client/texture-worker.ts` runs that core inside a Web Worker with `OffscreenCanvas` and transfers raw pixel buffers back to the main thread.
- `src/client/texture-worker-client.ts` owns worker creation, job cancellation, failure propagation, and battlefield worker replacement when the map changes.
- `src/client/textures.ts` keeps the public material/texture API. It creates correctly configured placeholder `CanvasTexture` objects synchronously, starts the worker job, paints the returned top-left-origin pixels into those canvases, and marks the existing textures dirty so live materials update without recompiling shaders.

The protocol transfers raw `ArrayBuffer` pixels rather than `ImageBitmap` objects. Painting with `putImageData` on the main thread avoids flipY, premultiplication, and color-space ambiguity: the bytes in the final canvas are the bytes produced by the deterministic generator.

## Jobs

The battlefield diffuse, bump, and normal maps run in a dedicated worker because they are large and because changing maps must cancel stale work. Small shared sets — armor, concrete, treads, rock, water normals, and close-up ground micro-detail — share a second worker. Those sets are singleton or shared-material inputs, so their texture objects can be updated in place when the job resolves.

`createBattlefieldTextures` still returns the same texture object shape as before. The scene currently discards the legacy bump texture, so the main thread skips painting that channel if the texture was disposed before the worker result arrived.

Lobby map prewarm starts the battlefield texture job at the beginning of its sliced offline scene build, so pixel generation overlaps the cliff/water/artifact geometry work. Repeated requests for the same in-flight theater share the job rather than restarting a nearly complete bake. If a prewarm is abandoned before its atomic scene commit, the placeholder textures are disposed; disposal guards prevent stale worker results or worker-failure fallbacks from doing main-thread work for that orphaned build.

## Fallback and cancellation

If workers or `OffscreenCanvas` are unavailable, or a worker job fails for a reason other than cancellation, the same core generator runs synchronously on the main thread and the generated canvas is adopted by the placeholder texture. Cancellation is different: a canceled battlefield texture belongs to a map that is no longer current, so it intentionally does not run the fallback.

Sidebar icons are rendered snapshots rather than live materials. `whenModelTexturesReady()` waits for the armor, concrete, and tread jobs before `generateIcons()` captures unit thumbnails; ordinary in-world materials do not need this wait because they reference the texture objects that are updated in place.

## Exactness constraints

Changes in this pipeline must preserve final texture bytes. In particular:

- do not reseed or reorder random-number consumption;
- do not reorder canvas vector operations;
- keep all normal-map Sobel tap ordering and wrapping semantics unchanged;
- keep texture dimensions, wrap modes, repeat values, anisotropy, and color spaces unchanged;
- verify diffuse, bump, normal, roughness, and detail canvases pixel-for-pixel after any generator refactor.

A short placeholder interval is expected while the worker runs. It is transient only; the final pixels must match the previous synchronous renderer exactly.
