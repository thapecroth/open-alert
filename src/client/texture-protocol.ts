import type { MapId } from "../shared/gamedefs";

export type TextureJobKind =
  | "battlefield"
  | "ground-micro"
  | "rock"
  | "water-normal"
  | "armor"
  | "concrete"
  | "tread";

export interface TextureJobRequest {
  id: number;
  kind: TextureJobKind;
  mapId?: MapId;
}

export interface TexturePixels {
  width: number;
  height: number;
  pixels: ArrayBuffer;
}

export type TextureJobTextureMap = Record<string, TexturePixels>;

export interface TextureJobResponse {
  id: number;
  kind: TextureJobKind;
  textures?: TextureJobTextureMap;
  error?: string;
}
