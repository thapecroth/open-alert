import {
  generateArmorDetail,
  generateBattlefieldTextures,
  generateConcrete,
  generateGroundMicroDetail,
  generateRockDetail,
  generateTread,
  generateWaterNormal,
  type CanvasFactory,
  type TextureCanvas,
} from "./texture-core";
import type { TextureJobRequest, TextureJobResponse, TextureJobTextureMap, TexturePixels } from "./texture-protocol";

const makeOffscreenCanvas: CanvasFactory = (w, h) => {
  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error(`Could not create ${w}x${h} OffscreenCanvas 2D context`);
  return [canvas as unknown as TextureCanvas, ctx as unknown as ReturnType<CanvasFactory>[1]];
};

function packCanvas(canvas: TextureCanvas): TexturePixels {
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error(`Missing 2D context for ${canvas.width}x${canvas.height} texture canvas`);
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
  return {
    width: canvas.width,
    height: canvas.height,
    pixels: img.data.buffer as ArrayBuffer,
  };
}

function packCanvases(canvases: Record<string, TextureCanvas>): { textures: TextureJobTextureMap; transfer: Transferable[] } {
  const textures: TextureJobTextureMap = {};
  const transfer: Transferable[] = [];
  for (const [name, canvas] of Object.entries(canvases)) {
    const packed = packCanvas(canvas);
    textures[name] = packed;
    transfer.push(packed.pixels);
  }
  return { textures, transfer };
}

function generate(request: TextureJobRequest): Record<string, TextureCanvas> {
  switch (request.kind) {
    case "battlefield": {
      const g = generateBattlefieldTextures(makeOffscreenCanvas, request.mapId ?? "crossroads");
      return { map: g.map, bumpMap: g.bumpMap, normalMap: g.normalMap };
    }
    case "ground-micro": {
      const g = generateGroundMicroDetail(makeOffscreenCanvas);
      return { map: g.map, normalMap: g.normalMap };
    }
    case "rock": {
      const g = generateRockDetail(makeOffscreenCanvas);
      return { normalMap: g.normalMap, roughMap: g.roughMap };
    }
    case "water-normal":
      return { normalMap: generateWaterNormal(makeOffscreenCanvas) };
    case "armor": {
      const g = generateArmorDetail(makeOffscreenCanvas);
      return { normalMap: g.normalMap, roughMap: g.roughMap, detailMap: g.detailMap };
    }
    case "concrete": {
      const g = generateConcrete(makeOffscreenCanvas);
      return { diffuseMap: g.diffuseMap, normalMap: g.normalMap, roughMap: g.roughMap };
    }
    case "tread": {
      const g = generateTread(makeOffscreenCanvas);
      return { map: g.map, normalMap: g.normalMap };
    }
  }
}

globalThis.addEventListener("message", (event) => {
  const request = (event as MessageEvent<TextureJobRequest>).data;
  let response: TextureJobResponse;
  let transfer: Transferable[] = [];
  try {
    const packed = packCanvases(generate(request));
    response = { id: request.id, kind: request.kind, textures: packed.textures };
    transfer = packed.transfer;
  } catch (err) {
    response = {
      id: request.id,
      kind: request.kind,
      error: err instanceof Error ? err.message : String(err),
    };
  }
  (globalThis as unknown as { postMessage(message: TextureJobResponse, transfer: Transferable[]): void }).postMessage(
    response,
    transfer,
  );
});
