import * as THREE from "three";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { MAP_W, MAP_H, MapId, MapArtifact, getMapLayout } from "../shared/gamedefs";
import {
  battlefieldTexturesJob,
  driveBakeJob,
  type BattlefieldTextures,
  createOceanWaterMaterial,
  getCliffRockMaterials,
  getChassisMat,
  getGroundMicroDetail,
} from "./textures";
import { GraphicsManager } from "./graphics";
import { SHADOW_PROXY_LAYER } from "./models";
import { RaytracePass } from "./raytrace";

interface BiomeAtmosphere {
  zenith: number;
  midSky: number;
  horizon: number;
  groundBounce: number;
  sunColor: number;
  sunIntensity: number;
  sunOffset: [number, number, number];
  hemiSky: number;
  hemiGround: number;
  hemiIntensity: number;
  rimColor: number;
  rimIntensity: number;
  skirt: number;
  fogColor: number;
  fogDensity: number;
  cloudTint: number;
  cloudOpacity: number;
  groundRoughness: number;
  groundEnv: number;
}

const BIOME_ATMOSPHERE: Record<MapId, BiomeAtmosphere> = {
  crossroads: {
    // Golden-hour sunlit blue-amber steppe
    zenith: 0x24568c,
    midSky: 0x5c96c8,
    horizon: 0xe6c592,
    groundBounce: 0x4b4636,
    sunColor: 0xfff0d4,
    sunIntensity: 2.45,
    sunOffset: [-42, 58, 28],
    hemiSky: 0xaad2f5,
    hemiGround: 0x544a38,
    hemiIntensity: 1.0,
    rimColor: 0x6cb8ec,
    rimIntensity: 0.56,
    skirt: 0x3b4034,
    fogColor: 0x9fb2c2,
    fogDensity: 0.0028,
    cloudTint: 0xfff2dc,
    cloudOpacity: 0.24,
    groundRoughness: 0.9,
    groundEnv: 0.45,
  },
  fulda_gap: {
    // Golden-hour sunlit blue-amber steppe
    zenith: 0x24568c,
    midSky: 0x5c96c8,
    horizon: 0xe6c592,
    groundBounce: 0x4b4636,
    sunColor: 0xfff0d4,
    sunIntensity: 2.45,
    sunOffset: [-42, 58, 28],
    hemiSky: 0xaad2f5,
    hemiGround: 0x544a38,
    hemiIntensity: 1.0,
    rimColor: 0x6cb8ec,
    rimIntensity: 0.56,
    skirt: 0x3b4034,
    fogColor: 0x9fb2c2,
    fogDensity: 0.0028,
    cloudTint: 0xfff2dc,
    cloudOpacity: 0.24,
    groundRoughness: 0.9,
    groundEnv: 0.45,
  },
  oasis: {
    // Sun-drenched golden Sahara daylight
    zenith: 0x1e5ea0,
    midSky: 0x5da0d6,
    horizon: 0xf4d29a,
    groundBounce: 0x80603c,
    sunColor: 0xffebd0,
    sunIntensity: 2.52,
    sunOffset: [-38, 62, 24],
    hemiSky: 0xb8dcf8,
    hemiGround: 0x8c6942,
    hemiIntensity: 1.05,
    rimColor: 0x7ac4f2,
    rimIntensity: 0.52,
    skirt: 0x765a38,
    fogColor: 0xd0b794,
    fogDensity: 0.0029,
    cloudTint: 0xfff4e0,
    cloudOpacity: 0.16,
    groundRoughness: 0.88,
    groundEnv: 0.48,
  },
  fortress: {
    // Golden-hour sunlit sandstone citadel
    zenith: 0x225288,
    midSky: 0x5e90c2,
    horizon: 0xe8c08a,
    groundBounce: 0x68543a,
    sunColor: 0xffe8c6,
    sunIntensity: 2.45,
    sunOffset: [-44, 54, 30],
    hemiSky: 0xadd0f0,
    hemiGround: 0x6e5a3e,
    hemiIntensity: 1.0,
    rimColor: 0x6cb4e6,
    rimIntensity: 0.55,
    skirt: 0x66533b,
    fogColor: 0xbea98e,
    fogDensity: 0.0028,
    cloudTint: 0xffeeda,
    cloudOpacity: 0.2,
    groundRoughness: 0.9,
    groundEnv: 0.45,
  },
  canyon: {
    // Warm canyon dusk / red-rock sunset
    zenith: 0x2a3868,
    midSky: 0x805a72,
    horizon: 0xee965c,
    groundBounce: 0x643826,
    sunColor: 0xffcfa0,
    sunIntensity: 2.45,
    sunOffset: [-48, 44, 28],
    hemiSky: 0xc8a4bc,
    hemiGround: 0x723e2a,
    hemiIntensity: 0.96,
    rimColor: 0x6aaee4,
    rimIntensity: 0.6,
    skirt: 0x5a3424,
    fogColor: 0xb68066,
    fogDensity: 0.0031,
    cloudTint: 0xffc69a,
    cloudOpacity: 0.28,
    groundRoughness: 0.89,
    groundEnv: 0.46,
  },
  tundra: {
    // Crisp bright arctic zenith
    zenith: 0x2660a4,
    midSky: 0x78b4e6,
    horizon: 0xdceeff,
    groundBounce: 0x6a849e,
    sunColor: 0xf6fbff,
    sunIntensity: 2.32,
    sunOffset: [-36, 54, 32],
    hemiSky: 0xcce6ff,
    hemiGround: 0x6e88a2,
    hemiIntensity: 1.05,
    rimColor: 0x88d2ff,
    rimIntensity: 0.55,
    skirt: 0x6c869e,
    fogColor: 0xb6d0e4,
    fogDensity: 0.0029,
    cloudTint: 0xf4faff,
    cloudOpacity: 0.22,
    groundRoughness: 0.72,
    groundEnv: 0.65,
  },
  archipelago: {
    // Lush sunlit tropical Pacific azure
    zenith: 0x1468b8,
    midSky: 0x4ab6ea,
    horizon: 0xcaeffa,
    groundBounce: 0x26686c,
    sunColor: 0xfff6e6,
    sunIntensity: 2.5,
    sunOffset: [-34, 66, 22],
    hemiSky: 0xa0e2ff,
    hemiGround: 0x2e6e68,
    hemiIntensity: 1.1,
    rimColor: 0x6cdaf2,
    rimIntensity: 0.56,
    skirt: 0x166a82,
    fogColor: 0x8ccce0,
    fogDensity: 0.0024,
    cloudTint: 0xffffff,
    cloudOpacity: 0.26,
    groundRoughness: 0.88,
    groundEnv: 0.5,
  },
  jungle: {
    // Sunlit tropical emerald valley
    zenith: 0x1c629c,
    midSky: 0x52a6ca,
    horizon: 0xbae0ca,
    groundBounce: 0x2a4c30,
    sunColor: 0xfff1d4,
    sunIntensity: 2.45,
    sunOffset: [-38, 62, 26],
    hemiSky: 0x9ad8ea,
    hemiGround: 0x2f5432,
    hemiIntensity: 1.04,
    rimColor: 0x64c6da,
    rimIntensity: 0.54,
    skirt: 0x26442c,
    fogColor: 0x7ba896,
    fogDensity: 0.0031,
    cloudTint: 0xf0faf4,
    cloudOpacity: 0.28,
    groundRoughness: 0.87,
    groundEnv: 0.48,
  },
  islands: {
    // Sunlit coastal archipelago & maritime sky
    zenith: 0x1c5c9c,
    midSky: 0x5aa4d6,
    horizon: 0xd0e6f2,
    groundBounce: 0x2c565e,
    sunColor: 0xfff4e0,
    sunIntensity: 2.45,
    sunOffset: [-40, 60, 26],
    hemiSky: 0xaadcf6,
    hemiGround: 0x30585e,
    hemiIntensity: 1.05,
    rimColor: 0x70c6ee,
    rimIntensity: 0.55,
    skirt: 0x1c5268,
    fogColor: 0x8eb8cc,
    fogDensity: 0.0026,
    cloudTint: 0xf6fbff,
    cloudOpacity: 0.24,
    groundRoughness: 0.88,
    groundEnv: 0.5,
  },
  coastline: {
    // Dramatic storm-silver North Sea sky
    zenith: 0x22364c,
    midSky: 0x54728a,
    horizon: 0xa6bccb,
    groundBounce: 0x2c3c46,
    sunColor: 0xecf4ff,
    sunIntensity: 2.32,
    sunOffset: [-44, 52, 30],
    hemiSky: 0x9ebad2,
    hemiGround: 0x2e3e46,
    hemiIntensity: 1.0,
    rimColor: 0x6cb0da,
    rimIntensity: 0.62,
    skirt: 0x1f3a4c,
    fogColor: 0x748d9e,
    fogDensity: 0.0033,
    cloudTint: 0xd2e0ea,
    cloudOpacity: 0.4,
    groundRoughness: 0.84,
    groundEnv: 0.56,
  },
  basin: {
    // Dramatic storm-silver alpine volcanic caldera
    zenith: 0x1f3246,
    midSky: 0x4e687e,
    horizon: 0x9eb4c4,
    groundBounce: 0x2e363e,
    sunColor: 0xeef5ff,
    sunIntensity: 2.36,
    sunOffset: [-42, 56, 28],
    hemiSky: 0x9ab8d6,
    hemiGround: 0x323a42,
    hemiIntensity: 1.0,
    rimColor: 0x6ab2e4,
    rimIntensity: 0.62,
    skirt: 0x2b343e,
    fogColor: 0x708596,
    fogDensity: 0.0032,
    cloudTint: 0xcfdce6,
    cloudOpacity: 0.38,
    groundRoughness: 0.86,
    groundEnv: 0.54,
  },
  atlantis: {
    // Mythic Sea: sunlit azure sky & luminous turquoise tropical reef
    zenith: 0x1068b8,
    midSky: 0x3ec2ee,
    horizon: 0xd0f6fc,
    groundBounce: 0x24828c,
    sunColor: 0xfff8e2,
    sunIntensity: 2.55,
    sunOffset: [-34, 64, 24],
    hemiSky: 0x9cecff,
    hemiGround: 0x308280,
    hemiIntensity: 1.12,
    rimColor: 0x70ecff,
    rimIntensity: 0.6,
    skirt: 0x14788c,
    fogColor: 0x86d6e6,
    fogDensity: 0.0023,
    cloudTint: 0xffffff,
    cloudOpacity: 0.22,
    groundRoughness: 0.78,
    groundEnv: 0.62,
  },
  shipwreck: {
    // Abyssal: dramatic silver-blue storm sky over deep teal-slate ocean
    zenith: 0x1a2c42,
    midSky: 0x42607a,
    horizon: 0x94b2c4,
    groundBounce: 0x20343c,
    sunColor: 0xe2f0ff,
    sunIntensity: 2.28,
    sunOffset: [-46, 48, 30],
    hemiSky: 0x8eb0cc,
    hemiGround: 0x243840,
    hemiIntensity: 0.98,
    rimColor: 0x60a8d8,
    rimIntensity: 0.66,
    skirt: 0x123242,
    fogColor: 0x607c8e,
    fogDensity: 0.0035,
    cloudTint: 0xc2d6e4,
    cloudOpacity: 0.44,
    groundRoughness: 0.82,
    groundEnv: 0.58,
  },
  volcano: {
    // Volcanic: dramatic fiery dusk sky over smoldering basalt caldera
    zenith: 0x22182c,
    midSky: 0x6e363c,
    horizon: 0xef7e3e,
    groundBounce: 0x522618,
    sunColor: 0xffb878,
    sunIntensity: 2.42,
    sunOffset: [-48, 42, 26],
    hemiSky: 0xc28a7c,
    hemiGround: 0x662c18,
    hemiIntensity: 0.96,
    rimColor: 0xff8040,
    rimIntensity: 0.66,
    skirt: 0x1c2832,
    fogColor: 0x844e3c,
    fogDensity: 0.0033,
    cloudTint: 0xffaa74,
    cloudOpacity: 0.36,
    groundRoughness: 0.85,
    groundEnv: 0.52,
  },
  oilrig: {
    // Deep Sea: crisp North Atlantic maritime sky over deep sapphire ocean
    zenith: 0x184c88,
    midSky: 0x4c8cc2,
    horizon: 0xc4e0f2,
    groundBounce: 0x1a3c62,
    sunColor: 0xf8fbff,
    sunIntensity: 2.48,
    sunOffset: [-38, 60, 26],
    hemiSky: 0xaad4f8,
    hemiGround: 0x264462,
    hemiIntensity: 1.06,
    rimColor: 0x70bcf0,
    rimIntensity: 0.58,
    skirt: 0x0e345c,
    fogColor: 0x7ea6c4,
    fogDensity: 0.0026,
    cloudTint: 0xf4faff,
    cloudOpacity: 0.28,
    groundRoughness: 0.72,
    groundEnv: 0.72,
  },
  cybergrid: {
    // Orbital: sleek deep twilight sky with luminous cyan horizon
    zenith: 0x0a1026,
    midSky: 0x182b52,
    horizon: 0x3686a8,
    groundBounce: 0x142638,
    sunColor: 0xd8f4ff,
    sunIntensity: 2.38,
    sunOffset: [-40, 56, 28],
    hemiSky: 0x76b8e8,
    hemiGround: 0x1c3248,
    hemiIntensity: 1.02,
    rimColor: 0x32dcff,
    rimIntensity: 0.78,
    skirt: 0x141c28,
    fogColor: 0x223850,
    fogDensity: 0.0028,
    cloudTint: 0x62c0e6,
    cloudOpacity: 0.2,
    groundRoughness: 0.42,
    groundEnv: 0.95,
  },
  hormuz: {
    // Gulf Strait: hazy desert-gold sun over a deep teal Persian Gulf
    zenith: 0x1a5a96,
    midSky: 0x5aa0cc,
    horizon: 0xf0ddc0,
    groundBounce: 0x5a4c34,
    sunColor: 0xfff2dc,
    sunIntensity: 2.56,
    sunOffset: [-40, 62, 26],
    hemiSky: 0xaad8f4,
    hemiGround: 0x4c4230,
    hemiIntensity: 1.06,
    rimColor: 0x84d4f0,
    rimIntensity: 0.56,
    skirt: 0x0e4a66,
    fogColor: 0x9cc0ce,
    fogDensity: 0.0023,
    cloudTint: 0xfff6e2,
    cloudOpacity: 0.2,
    groundRoughness: 0.9,
    groundEnv: 0.44,
  },
  delta: {
    // River Delta: humid tropical light over jungle-green waterways & muddy banks
    zenith: 0x14709a,
    midSky: 0x4cb4d4,
    horizon: 0xd8f0e8,
    groundBounce: 0x2c5034,
    sunColor: 0xfff8e4,
    sunIntensity: 2.44,
    sunOffset: [-34, 64, 24],
    hemiSky: 0xa0e2f4,
    hemiGround: 0x2a4c30,
    hemiIntensity: 1.1,
    rimColor: 0x66e0e0,
    rimIntensity: 0.54,
    skirt: 0x0e5a6e,
    fogColor: 0x9ad0d2,
    fogDensity: 0.0024,
    cloudTint: 0xffffff,
    cloudOpacity: 0.3,
    groundRoughness: 0.88,
    groundEnv: 0.5,
  },
  bering: {
    // Polar Strait: pale arctic sun over steel-blue ice-choked water
    zenith: 0x1c548e,
    midSky: 0x64a6d8,
    horizon: 0xd8ecf8,
    groundBounce: 0x5e7c94,
    sunColor: 0xf2faff,
    sunIntensity: 2.32,
    sunOffset: [-38, 50, 34],
    hemiSky: 0xc4e2fe,
    hemiGround: 0x5a7a96,
    hemiIntensity: 1.04,
    rimColor: 0x86d2fe,
    rimIntensity: 0.6,
    skirt: 0x26486a,
    fogColor: 0xacc8e0,
    fogDensity: 0.0022,
    cloudTint: 0xeaf6ff,
    cloudOpacity: 0.32,
    groundRoughness: 0.94,
    groundEnv: 0.42,
  },
  europa: {
    // Continental European steppe & highlands: rich golden-hour sun & clear azure-amber sky
    zenith: 0x20548e,
    midSky: 0x5894ca,
    horizon: 0xebca96,
    groundBounce: 0x424d34,
    sunColor: 0xffefd0,
    sunIntensity: 2.48,
    sunOffset: [-46, 54, 30],
    hemiSky: 0xaad4f6,
    hemiGround: 0x485436,
    hemiIntensity: 1.02,
    rimColor: 0x6cb8ec,
    rimIntensity: 0.56,
    skirt: 0x35442e,
    fogColor: 0xa4b8c6,
    fogDensity: 0.0021,
    cloudTint: 0xfff3de,
    cloudOpacity: 0.25,
    groundRoughness: 0.89,
    groundEnv: 0.46,
  },
  pacific_theatre: {
    // Coral Sea Theatre: vivid sunlit tropical Pacific sky & turquoise ocean horizon
    zenith: 0x1066ba,
    midSky: 0x44b8ee,
    horizon: 0xd0f4fc,
    groundBounce: 0x226e74,
    sunColor: 0xfff7e6,
    sunIntensity: 2.52,
    sunOffset: [-36, 66, 24],
    hemiSky: 0xa2e6ff,
    hemiGround: 0x2a706c,
    hemiIntensity: 1.1,
    rimColor: 0x6ce0f6,
    rimIntensity: 0.58,
    skirt: 0x126e88,
    fogColor: 0x8cd2e6,
    fogDensity: 0.0019,
    cloudTint: 0xffffff,
    cloudOpacity: 0.24,
    groundRoughness: 0.86,
    groundEnv: 0.52,
  },
  panama: {
    // Coral Sea Theatre: vivid sunlit tropical Pacific sky & turquoise ocean horizon
    zenith: 0x1066ba,
    midSky: 0x44b8ee,
    horizon: 0xd0f4fc,
    groundBounce: 0x226e74,
    sunColor: 0xfff7e6,
    sunIntensity: 2.52,
    sunOffset: [-36, 66, 24],
    hemiSky: 0xa2e6ff,
    hemiGround: 0x2a706c,
    hemiIntensity: 1.1,
    rimColor: 0x6ce0f6,
    rimIntensity: 0.58,
    skirt: 0x126e88,
    fogColor: 0x8cd2e6,
    fogDensity: 0.0019,
    cloudTint: 0xffffff,
    cloudOpacity: 0.24,
    groundRoughness: 0.86,
    groundEnv: 0.52,
  },
  english_channel: {
    // Coral Sea Theatre: vivid sunlit tropical Pacific sky & turquoise ocean horizon
    zenith: 0x1066ba,
    midSky: 0x44b8ee,
    horizon: 0xd0f4fc,
    groundBounce: 0x226e74,
    sunColor: 0xfff7e6,
    sunIntensity: 2.52,
    sunOffset: [-36, 66, 24],
    hemiSky: 0xa2e6ff,
    hemiGround: 0x2a706c,
    hemiIntensity: 1.1,
    rimColor: 0x6ce0f6,
    rimIntensity: 0.58,
    skirt: 0x126e88,
    fogColor: 0x8cd2e6,
    fogDensity: 0.0019,
    cloudTint: 0xffffff,
    cloudOpacity: 0.24,
    groundRoughness: 0.86,
    groundEnv: 0.52,
  },
  arctic_front: {
    // Polar Sea Front: crisp arctic blue-white zenith & icy steel-blue polar horizon
    zenith: 0x20589c,
    midSky: 0x6caae2,
    horizon: 0xdaf0ff,
    groundBounce: 0x567492,
    sunColor: 0xf4faff,
    sunIntensity: 2.36,
    sunOffset: [-38, 52, 34],
    hemiSky: 0xc6e4ff,
    hemiGround: 0x5c7c9a,
    hemiIntensity: 1.05,
    rimColor: 0x82d0ff,
    rimIntensity: 0.58,
    skirt: 0x2a4e6c,
    fogColor: 0xb0cce4,
    fogDensity: 0.0021,
    cloudTint: 0xf2faff,
    cloudOpacity: 0.25,
    groundRoughness: 0.72,
    groundEnv: 0.66,
  },
  megacontinent: {
    // Eurasia Grand Theater: sweeping golden-hour steppe & alpine peaks over a deep azure sea strait
    zenith: 0x1e528c,
    midSky: 0x5696cc,
    horizon: 0xecc996,
    groundBounce: 0x4c4838,
    sunColor: 0xfff0d4,
    sunIntensity: 2.5,
    sunOffset: [-48, 56, 30],
    hemiSky: 0xacd6f8,
    hemiGround: 0x524b3a,
    hemiIntensity: 1.04,
    rimColor: 0x6ebcee,
    rimIntensity: 0.58,
    skirt: 0x244254,
    fogColor: 0x9eb8ca,
    fogDensity: 0.0015,
    cloudTint: 0xfff4e0,
    cloudOpacity: 0.24,
    groundRoughness: 0.88,
    groundEnv: 0.48,
  },
  persian_gulf: {
    // Eurasia Grand Theater: sweeping golden-hour steppe & alpine peaks over a deep azure sea strait
    zenith: 0x1e528c,
    midSky: 0x5696cc,
    horizon: 0xecc996,
    groundBounce: 0x4c4838,
    sunColor: 0xfff0d4,
    sunIntensity: 2.5,
    sunOffset: [-48, 56, 30],
    hemiSky: 0xacd6f8,
    hemiGround: 0x524b3a,
    hemiIntensity: 1.04,
    rimColor: 0x6ebcee,
    rimIntensity: 0.58,
    skirt: 0x244254,
    fogColor: 0x9eb8ca,
    fogDensity: 0.0015,
    cloudTint: 0xfff4e0,
    cloudOpacity: 0.24,
    groundRoughness: 0.88,
    groundEnv: 0.48,
  },
  mediterranean: {
    // bright southern sun, warm limestone coasts and luminous blue water
    zenith: 0x1d5e9e, midSky: 0x61aad6, horizon: 0xf4d6a0, groundBounce: 0x665437,
    sunColor: 0xffedc8, sunIntensity: 2.55, sunOffset: [-44, 58, 28], hemiSky: 0xb6def8, hemiGround: 0x66543d,
    hemiIntensity: 1.05, rimColor: 0x77c6f0, rimIntensity: 0.58, skirt: 0x25536a, fogColor: 0xaec6cf,
    fogDensity: 0.0014, cloudTint: 0xfff6e5, cloudOpacity: 0.23, groundRoughness: 0.86, groundEnv: 0.5,
  },
  scandinavia: {
    // cold high-latitude light, blue-grey fjord haze and snow-bright granite
    zenith: 0x274f7f, midSky: 0x7395b8, horizon: 0xd8e2e6, groundBounce: 0x354842,
    sunColor: 0xf5f0df, sunIntensity: 2.15, sunOffset: [-52, 48, 34], hemiSky: 0xb9d3e5, hemiGround: 0x3d4b45,
    hemiIntensity: 1.0, rimColor: 0x8fc2e8, rimIntensity: 0.52, skirt: 0x203b4d, fogColor: 0x9fb5c2,
    fogDensity: 0.0018, cloudTint: 0xecf4f8, cloudOpacity: 0.3, groundRoughness: 0.9, groundEnv: 0.43,
  },
  terra: {
    // orbital blue-planet clarity: oceanic atmosphere over varied continental biomes
    zenith: 0x164f91, midSky: 0x4f9ed2, horizon: 0xcfe5ef, groundBounce: 0x43563d,
    sunColor: 0xfff2d6, sunIntensity: 2.45, sunOffset: [-46, 56, 30], hemiSky: 0xb4dcfa, hemiGround: 0x495842,
    hemiIntensity: 1.04, rimColor: 0x79c8f4, rimIntensity: 0.6, skirt: 0x1d4662, fogColor: 0x9fbdd0,
    fogDensity: 0.00145, cloudTint: 0xf7fbff, cloudOpacity: 0.27, groundRoughness: 0.87, groundEnv: 0.5,
  },
};

const SKY_VERT = /* glsl */ `
  varying vec3 vWorldDir;
  void main() {
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vWorldDir = normalize(position);
    gl_Position = projectionMatrix * viewMatrix * wp;
  }
`;

const SKY_FRAG = /* glsl */ `
  uniform vec3 uZenith;
  uniform vec3 uMidSky;
  uniform vec3 uHorizon;
  uniform vec3 uGround;
  uniform vec3 uSunDir;
  uniform vec3 uSunColor;
  uniform vec3 uCloudTint;
  uniform float uCloudOpacity;
  uniform float uSunBoost;
  varying vec3 vWorldDir;

  float hash2(vec2 p) {
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
  }
  float noise2(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    float a = hash2(i);
    float b = hash2(i + vec2(1.0, 0.0));
    float c = hash2(i + vec2(0.0, 1.0));
    float d = hash2(i + vec2(1.0, 1.0));
    return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
  }

  void main() {
    vec3 dir = normalize(vWorldDir);
    float h = dir.y;

    // Smooth atmospheric Rayleigh vertical gradient
    vec3 sky;
    if (h >= 0.0) {
      float tMid = smoothstep(0.0, 0.28, h);
      float tZen = smoothstep(0.18, 0.88, h);
      sky = mix(uHorizon, uMidSky, tMid);
      sky = mix(sky, uZenith, tZen);
    } else {
      sky = mix(uHorizon, uGround, smoothstep(0.0, -0.35, h));
    }

    // Mie forward-scattering solar glow & crisp sun disc
    float sunDot = max(dot(dir, normalize(uSunDir)), 0.0);
    float halo = pow(sunDot, 6.0) * 0.28 + pow(sunDot, 42.0) * 0.42;
    float disc = smoothstep(0.9965, 0.9994, sunDot) * uSunBoost;
    sky += uSunColor * (halo + disc) * smoothstep(-0.08, 0.08, h);

    // Subtle wispy high-altitude clouds in upper hemisphere
    if (h > 0.03 && uCloudOpacity > 0.01) {
      vec2 uv = dir.xz / (h + 0.16) * 1.45;
      float c1 = noise2(uv * 1.8 + vec2(2.3, 4.1));
      float c2 = noise2(uv * 3.7 - vec2(1.4, 2.7)) * 0.5;
      float c3 = noise2(uv * 7.5 + vec2(5.1, 0.8)) * 0.25;
      float cloud = smoothstep(0.92, 1.42, c1 + c2 + c3);
      float fade = smoothstep(0.03, 0.24, h) * (1.0 - smoothstep(0.75, 0.98, h) * 0.35);
      sky = mix(sky, uCloudTint, cloud * fade * uCloudOpacity);
    }

    gl_FragColor = vec4(sky, 1.0);
  }
`;

// Facade preserving the legacy engine API expected by main.ts / input.ts / tests
class EngineShim {
  constructor(private gs: GameScene) {}
  getRenderingCanvas() {
    return this.gs.canvas;
  }
  getRenderWidth() {
    return this.gs.canvas.clientWidth;
  }
  getRenderHeight() {
    return this.gs.canvas.clientHeight;
  }
  getDeltaTime() {
    return this.gs.dtMs;
  }
  runRenderLoop(cb: () => void) {
    this.gs.setLoop(cb);
  }
  resize() {
    this.gs.resize();
  }
}

// Deterministic per-tile hash in [0, 1) for organic rock & tree placement
function tileHash(x: number, y: number, salt: number): number {
  let h = (x * 374761393 + y * 668265263 + salt * 1442695041) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

interface ShadowObjectWatch {
  obj: THREE.Object3D;
  inst: THREE.InstancedMesh | null;
  dynamicInstances: boolean;
  // Approximate caster radius in world units, estimated once. Rotation/scale
  // thresholds derive from it: what reaches the shadowmap is silhouette EDGE
  // motion (radius × angle, radius × scaleDelta), so a uniform angular threshold
  // would be needlessly strict for small decorations and too lax for buildings.
  radius: number;
  // Anchors are captured when the shadowmap is actually rendered. The cache
  // invalidates on ACCUMULATED DRIFT since that render rather than on quantized
  // absolute state; plain quantization cannot absorb oscillating idle animation
  // (a sine straddling a quantum boundary flips the hash every frame), while
  // drift semantics both absorb oscillation and self-regulate the update rate in
  // proportion to real silhouette motion measured in depth texels.
  anchored: boolean;
  ax: number;
  ay: number;
  az: number;
  arx: number;
  ary: number;
  arz: number;
  asx: number;
  asy: number;
  asz: number;
  am: Float32Array | null; // frozen local-matrix snapshot for matrixAutoUpdate=false objects
  // Discrete structural signature — exact compare, no thresholds.
  sigVisible: boolean;
  sigCastShadow: boolean;
  sigLayers: number;
  sigGeoId: number;
  sigMatIds: number[];
  // Dynamic instance-buffer snapshot (copied at render time so drift can be
  // measured against what the shadowmap actually contains).
  instSnap: Float32Array | null;
  instSnapCount: number;
  instSnapVersion: number;
}

// Shared depth-pass stand-in for environment shadow proxies. The colorWrite flag
// is irrelevant while three.js substitutes MeshDepthMaterial, but keeping this
// colorless material mirrors the vehicle/building proxy convention and makes the
// objects unambiguous in frame captures even if accidentally exposed to layer 0.
const ENV_SHADOW_PROXY_MAT = new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false });

export class GameScene {
  canvas: HTMLCanvasElement;
  renderer: THREE.WebGLRenderer;
  public graphics: GraphicsManager;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  composer: EffectComposer;
  engine: EngineShim;
  camTarget = new THREE.Vector3(MAP_W / 2, 0, MAP_H / 2);
  camHeight = 26;
  camYaw = 0; // radians around Y axis (0 = North-Up)
  fpvActive = false;
  public mapW = MAP_W;
  public mapH = MAP_H;
  ground!: THREE.Group; // chunked 16x16-tile terrain meshes — frustum culling drops off-screen chunks
  raycaster = (() => {
    const r = new THREE.Raycaster();
    r.layers.enableAll(); // pick-hit boxes live on layer 1 (render-invisible)
    return r;
  })();
  pickables: THREE.Object3D[] = []; // entity roots — raycast for pickEntity
  pointerX = 0;
  pointerY = 0;
  pointerInside = false;
  dtMs = 16;
  envReady = false;

  private raytracePass: RaytracePass;
  private bloomPass: UnrealBloomPass;
  private contextLost = false;
  private frameCount = 0;

  // Shadow invalidation/cache state. The texel-snapped frustum makes static-camera
  // shadowmaps bit-exactly reusable; these watchers let us skip the whole depth pass
  // until either that quantized frustum key changes or a caster drifts far enough
  // from what the rendered shadowmap actually contains.
  private shadowSceneChildren: THREE.Object3D[] = [];
  private shadowSceneChildCounts: number[] = [];
  private shadowStructureSafetyFrame = -1000;
  private shadowWatches: ShadowObjectWatch[] = [];
  private shadowRenderedFrustumKey = "";
  private shadowFramesSinceUpdate = 1_000_000;
  private shadowForceDirty = true;
  private shadowForceImmediate = true;
  private shadowCasterMembershipLost = false;

  private groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  private groundMat!: THREE.MeshStandardMaterial;
  private microRepeatUniform = { value: MAP_W * 0.5 };
  private gridHelper!: THREE.GridHelper;
  private skirtMesh!: THREE.Mesh;
  private skirtMat!: THREE.MeshStandardMaterial;
  private borderLine!: THREE.Line;
  private skyMesh!: THREE.Mesh;
  private skyRadius = 420;
  private oreGeo!: THREE.BufferGeometry;
  private oreMat!: THREE.MeshStandardMaterial;
  // ore lives in per-region InstancedMesh pools so off-screen regions frustum-cull
  private oreRegions: THREE.InstancedMesh[] = [];
  private oreRegionFree: number[][] = [];
  private oreRegionPeak: number[] = [];
  private oreSlots = new Map<number, { r: number; i: number }>(); // cellKey -> region+instance
  private oreCols = 1;
  private oreMax = MAP_W * MAP_H;
  private dummy = new THREE.Object3D();

  // Cinematic 3-point biome lighting, procedural sky & PMREM environment
  private hemiLight!: THREE.HemisphereLight;
  private sunLight!: THREE.DirectionalLight;
  private rimLight!: THREE.DirectionalLight;
  private curSunOffset: [number, number, number] = [-42, 58, 28];
  private shadowFpvTight = false;
  private skyMat!: THREE.ShaderMaterial;
  private envSkyMat!: THREE.ShaderMaterial;
  private envScene!: THREE.Scene;
  private pmrem!: THREE.PMREMGenerator;
  private envRT: THREE.WebGLRenderTarget | null = null;

  // Map cliffs, navigable water, biome terrain & sculpted 3D world artifacts
  private mapId: MapId = "crossroads";
  // True once loadMap has fully committed a build of `mapId`. Repeat loads of
  // the same map are then cheap no-ops (crucial at game start: the exact same
  // scene was already built during boot/lobby prewarm). A WebGL context restore
  // or an actual map switch forces a rebuild.
  private mapLoaded = false;
  private cliffSet = new Set<number>();
  private waterSet = new Set<number>();
  private mapGroup: THREE.Group | null = null;
  private waterMat: THREE.MeshStandardMaterial | null = null;
  private foamMat: THREE.MeshBasicMaterial | null = null;
  private waterTime = 0;
  private waterBaseEmissive = 0.28;
  private artifactAnims: ((t: number, dt: number) => void)[] = [];
  private artifactMats: THREE.Material[] = [];

  // Live dynamic mapW x mapH Fog of War shroud plane (chunked like the ground)
  private fogMesh!: THREE.Group;
  private fogMat!: THREE.MeshBasicMaterial;
  private fogTex!: THREE.DataTexture;
  private fogW = MAP_W;
  private fogH = MAP_H;
  private fogData = new Uint8Array(MAP_W * MAP_H * 4);
  private fogExplored = new Uint8Array(MAP_W * MAP_H);
  private fogVisBuf = new Float32Array(MAP_W * MAP_H);
  private reconReveals: { x: number; y: number; r: number; expiresAt: number }[] = [];
  private lastFogSlot = -1;
  private lastFogSources: { x: number; y: number; r: number }[] = [];

  // Build-zone perimeter overlay
  private buildZoneGroup = new THREE.Group();

  // Damped cinematic camera shake
  private shakeAmp = 0;
  private shakePhase = 0;
  private shakeOffset = new THREE.Vector3();
  private lookVec = new THREE.Vector3();

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.engine = new EngineShim(this);

    this.renderer = new THREE.WebGLRenderer({
      canvas,
      alpha: false, // Opaque canvas lets macOS CoreAnimation/Metal skip full-screen alpha compositing
      antialias: true,
      powerPreference: "high-performance",
      stencil: false,
      preserveDrawingBuffer: false,
    });
    this.graphics = new GraphicsManager(this.renderer);
    this.renderer.setPixelRatio(this.graphics.getTargetDpr());
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.shadowMap.autoUpdate = false;
    this.renderer.shadowMap.needsUpdate = true;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.18;

    // WebGL context-loss resilience (e.g. laptop sleep/resume or GPU driver reset)
    canvas.addEventListener("webglcontextlost", (e) => {
      e.preventDefault();
      this.contextLost = true;
    });
    canvas.addEventListener("webglcontextrestored", () => {
      this.contextLost = false;
      this.applyGraphicsSettings();
      this.loadMap(this.mapId, true);
    });

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x9fb2c2);
    this.scene.fog = new THREE.FogExp2(0x9fb2c2, 0.0028);

    this.camera = new THREE.PerspectiveCamera(48, 1, 0.5, 700);
    this.scene.add(this.camera);
    this.updateCamera();

    // Cinematic 3-point sunlit biome lighting (tuned per theater in loadMap)
    this.hemiLight = new THREE.HemisphereLight(0xaad2f5, 0x544a38, 1.0);
    this.scene.add(this.hemiLight);

    const initShadowSize = this.graphics.getShadowSize();
    this.sunLight = new THREE.DirectionalLight(0xfff0d4, 2.45);
    this.sunLight.position.set(MAP_W / 2 - 42, 58, MAP_H / 2 + 28);
    this.sunLight.target.position.set(MAP_W / 2, 0, MAP_H / 2);
    this.sunLight.castShadow = true;
    this.sunLight.shadow.mapSize.set(initShadowSize, initShadowSize);
    this.sunLight.shadow.camera.left = -45;
    this.sunLight.shadow.camera.right = 45;
    this.sunLight.shadow.camera.top = 45;
    this.sunLight.shadow.camera.bottom = -45;
    this.sunLight.shadow.camera.near = 12;
    this.sunLight.shadow.camera.far = 165;
    this.sunLight.shadow.bias = -0.0003;
    this.sunLight.shadow.normalBias = 0.024;
    // Keep ordinary layer-0 casters active and additionally admit depth-only
    // simplified proxy meshes. Because the mask now has a non-zero bit outside
    // layer 0, three.js uses exactly this mask for the shadow pass; the main
    // camera still renders only layer 0, so proxies cost no main-pass draws.
    this.sunLight.shadow.camera.layers.enable(SHADOW_PROXY_LAYER);
    this.scene.add(this.sunLight, this.sunLight.target);

    // Crisp cool counter-rim light so shaded metallic facets & silhouettes stay razor-sharp
    this.rimLight = new THREE.DirectionalLight(0x6cb8ec, 0.56);
    this.rimLight.position.set(MAP_W / 2 + 48, 28, MAP_H / 2 - 36);
    this.scene.add(this.rimLight);

    // Biome-matched procedural PMREM environment generator for gleaming metallic & glass reflections
    this.pmrem = new THREE.PMREMGenerator(this.renderer);
    this.scene.environmentIntensity = 0.78;

    // Hardware DepthTexture EffectComposer (with Safari/macOS HalfFloat fallback check)
    const initW = Math.max(1, Math.floor((canvas.clientWidth || innerWidth) * this.graphics.getTargetDpr()));
    const initH = Math.max(1, Math.floor((canvas.clientHeight || innerHeight) * this.graphics.getTargetDpr()));
    const hasHalfFloat =
      this.renderer.capabilities.isWebGL2 &&
      (this.renderer.extensions.has("EXT_color_buffer_float") ||
        this.renderer.extensions.has("EXT_color_buffer_half_float"));
    const rtType = hasHalfFloat ? THREE.HalfFloatType : THREE.UnsignedByteType;
    const depthTex1 = new THREE.DepthTexture(initW, initH, THREE.UnsignedIntType);
    const rt = new THREE.WebGLRenderTarget(initW, initH, {
      type: rtType,
      depthTexture: depthTex1,
    });
    this.composer = new EffectComposer(this.renderer, rt);
    // Give renderTarget2 its own DepthTexture so ping-ponging never creates a WebGL2 feedback loop
    this.composer.renderTarget2.depthTexture = new THREE.DepthTexture(initW, initH, THREE.UnsignedIntType);

    this.composer.addPass(new RenderPass(this.scene, this.camera));

    this.raytracePass = new RaytracePass(this.scene, this.camera, initW, initH);
    this.raytracePass.setAppleSilicon(this.graphics.gpu.appleSilicon);
    this.raytracePass.setDepthTexture(this.composer.readBuffer.depthTexture ?? depthTex1);
    this.composer.addPass(this.raytracePass);

    // Half-resolution filmic bloom cuts Metal TBDR bandwidth ~70% on Retina MacBooks with identical glow
    const bScale = this.graphics.getBloomScale();
    this.bloomPass = new UnrealBloomPass(
      new THREE.Vector2(Math.max(1, Math.floor(initW * bScale)), Math.max(1, Math.floor(initH * bScale))),
      0.28,
      0.4,
      0.96,
    );
    this.composer.addPass(this.bloomPass);
    this.composer.addPass(new OutputPass());

    this.graphics.onChange = () => this.applyGraphicsSettings();

    // Pointer tracking — synced on move AND down so clicks never use stale coordinates
    canvas.addEventListener("pointermove", (e) => this.syncPointer(e.clientX, e.clientY));
    canvas.addEventListener("pointerdown", (e) => this.syncPointer(e.clientX, e.clientY));

    this.buildSky();
    this.buildGround();
    this.buildPerimeter();
    this.buildOre();
    this.buildFog();
    this.buildZoneGroup.renderOrder = 4;
    this.buildZoneGroup.visible = false;
    this.scene.add(this.buildZoneGroup);
    this.loadMap("crossroads");
    this.applyGraphicsSettings();
  }

  public applyGraphicsSettings(): void {
    const s = this.graphics.getEffectiveSettings();
    const targetDpr = this.graphics.getTargetDpr();
    this.renderer.setPixelRatio(targetDpr);

    const shadowSize = this.graphics.getShadowSize();
    if (this.sunLight.shadow.mapSize.x !== shadowSize || this.sunLight.shadow.mapSize.y !== shadowSize) {
      this.sunLight.shadow.mapSize.set(shadowSize, shadowSize);
      if (this.sunLight.shadow.map) {
        this.sunLight.shadow.map.dispose();
        this.sunLight.shadow.map = null;
      }
    }
    this.invalidateSunShadows(true);

    this.raytracePass.enabled = s.raytracing || s.contactShadows;
    this.raytracePass.setQuality(s.preset, s.raytracing, s.contactShadows);
    this.bloomPass.enabled = s.bloom;

    this.resize();
  }

  syncPointer(clientX: number, clientY: number) {
    const r = this.canvas.getBoundingClientRect();
    this.pointerX = clientX - r.left;
    this.pointerY = clientY - r.top;
  }

  // ---------- environment pieces ----------

  private makeSkyMaterial(sunBoost: number): THREE.ShaderMaterial {
    return new THREE.ShaderMaterial({
      vertexShader: SKY_VERT,
      fragmentShader: SKY_FRAG,
      side: THREE.BackSide,
      fog: false,
      depthWrite: false,
      uniforms: {
        uZenith: { value: new THREE.Color(0x24568c) },
        uMidSky: { value: new THREE.Color(0x5c96c8) },
        uHorizon: { value: new THREE.Color(0xe6c592) },
        uGround: { value: new THREE.Color(0x4b4636) },
        uSunDir: { value: new THREE.Vector3(-42, 58, 28).normalize() },
        uSunColor: { value: new THREE.Color(0xfff0d4) },
        uCloudTint: { value: new THREE.Color(0xfff2dc) },
        uCloudOpacity: { value: 0.24 },
        uSunBoost: { value: sunBoost },
      },
    });
  }

  private buildSky() {
    this.skyRadius = Math.max(420, this.mapW * 5);
    const geo = new THREE.SphereGeometry(this.skyRadius, 32, 20);
    this.skyMat = this.makeSkyMaterial(1.1);
    const sky = new THREE.Mesh(geo, this.skyMat);
    sky.position.set(this.mapW / 2, 0, this.mapH / 2);
    sky.renderOrder = -10;
    this.skyMesh = sky;
    this.scene.add(sky);

    // Lightweight offscreen sky dome with heightened HDR sun specular for PMREM reflections
    this.envScene = new THREE.Scene();
    this.envSkyMat = this.makeSkyMaterial(3.2);
    const envDome = new THREE.Mesh(new THREE.SphereGeometry(20, 24, 16), this.envSkyMat);
    this.envScene.add(envDome);
  }

  private getSunScale(): number {
    return this.mapW > 64 ? 1 + (this.mapW - 64) / 96 : 1;
  }

  // Camera-fitted RTS shadow frustum. Previously the ortho box spanned ±0.62*mapW
  // (~±119 world units on 192-wide theaters): at 1024px that is ~4.3 texels per
  // world unit (soft blurry shadows) and the shadow pass rasterized nearly every
  // static mesh on the map each update. Fitting the box to the visible camera
  // footprint (~±35 at default zoom) makes shadows ~4x crisper at the same map
  // size AND lets frustum culling drop most off-screen casters from the shadow pass.
  // The box center is texel-snapped in the light's ground-plane basis so the
  // shadowmap grid stays world-locked while panning (no edge crawling).
  private updateSunShadowFrustum(): void {
    if (this.shadowFpvTight) return;
    const sc = this.sunLight.shadow.camera;
    const maxHalf = Math.max(45, Math.round(this.mapW * 0.62));
    const half = Math.min(maxHalf, Math.max(26, this.camHeight * 1.08 + 9));
    const [sx, sy, sz] = this.curSunOffset;
    const sunScale = this.getSunScale();
    const sunDist = Math.hypot(sx, sy, sz) * sunScale;
    const far = Math.max(140, Math.round(sunDist + half * 1.9 + 24));
    if (sc.right !== half || sc.far !== far) {
      sc.left = -half;
      sc.right = half;
      sc.top = half;
      sc.bottom = -half;
      sc.far = far;
      sc.updateProjectionMatrix();
    }

    const cx = Math.max(-6, Math.min(this.mapW + 6, this.camTarget.x));
    const cz = Math.max(-6, Math.min(this.mapH + 6, this.camTarget.z));

    // Texel snap: project the desired center onto the light basis in the ground
    // plane and round to whole shadowmap texels.
    const len = Math.hypot(sx, sy, sz) || 1;
    const dx = sx / len,
      dy = sy / len,
      dz = sz / len;
    const hxz = Math.hypot(dx, dz);
    let tx = cx,
      tz = cz;
    if (hxz > 1e-4) {
      const xx = dz / hxz,
        xz = -dx / hxz;
      const yx = dy * xz,
        yz = -dy * xx;
      const texel = (half * 2) / Math.max(1, this.sunLight.shadow.mapSize.x);
      const px = cx * xx + cz * xz;
      const py = cx * yx + cz * yz;
      const ox = Math.round(px / texel) * texel - px;
      const oy = Math.round(py / texel) * texel - py;
      tx = cx + xx * ox + yx * oy;
      tz = cz + xz * ox + yz * oy;
    }
    this.sunLight.target.position.set(tx, 0, tz);
    this.sunLight.position.set(tx + sx * sunScale, sy * sunScale, tz + sz * sunScale);
    this.sunLight.target.updateMatrixWorld();
  }

  // ---------- shadow invalidation & texel-keyed reuse ----------

  private invalidateSunShadows(immediate = false): void {
    this.shadowForceDirty = true;
    if (immediate) this.shadowForceImmediate = true;
  }

  private materialIdsOf(obj: THREE.Object3D): number[] {
    const mesh = obj as THREE.Mesh;
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    const ids: number[] = [];
    for (const mat of mats) ids.push(mat?.id ?? 0);
    return ids;
  }

  private estimateShadowRadius(obj: THREE.Object3D): number {
    let r = 0;
    const consider = (m: THREE.Object3D): void => {
      if (!(m instanceof THREE.Mesh)) return;
      const geo = m.geometry as THREE.BufferGeometry | undefined;
      if (!geo) return;
      if (!geo.boundingSphere) geo.computeBoundingSphere();
      const br = geo.boundingSphere?.radius ?? 0;
      if (br > r) r = br;
    };
    consider(obj);
    if (r === 0) {
      // Groups (radar pedestals, turret shells, crate spinners) have no geometry of
      // their own; the silhouette that matters is their largest caster descendant.
      obj.traverse((m) => {
        if (m.castShadow) consider(m);
      });
    }
    if (r === 0) r = 1;
    const s = obj.scale;
    r *= Math.max(Math.abs(s.x), Math.abs(s.y), Math.abs(s.z), 0.001);
    return Math.min(4, Math.max(0.25, r));
  }

  private captureShadowWatchAnchor(w: ShadowObjectWatch): void {
    const obj = w.obj;
    w.anchored = true;
    if (w.radius === 0) w.radius = this.estimateShadowRadius(obj);
    w.ax = obj.position.x;
    w.ay = obj.position.y;
    w.az = obj.position.z;
    w.arx = obj.rotation.x;
    w.ary = obj.rotation.y;
    w.arz = obj.rotation.z;
    w.asx = obj.scale.x;
    w.asy = obj.scale.y;
    w.asz = obj.scale.z;
    if (!obj.matrixAutoUpdate) {
      if (!w.am) w.am = new Float32Array(16);
      w.am.set(obj.matrix.elements);
    }
    w.sigVisible = obj.visible;
    w.sigCastShadow = obj.castShadow;
    w.sigLayers = obj.layers.mask;
    if (obj instanceof THREE.Mesh) {
      w.sigGeoId = obj.geometry?.id ?? 0;
      w.sigMatIds = this.materialIdsOf(obj);
    } else {
      w.sigGeoId = 0;
      w.sigMatIds = [];
    }
    if (w.inst && w.dynamicInstances) {
      const im = w.inst;
      const live = Math.max(0, Math.min(im.count, Math.floor(im.instanceMatrix.array.length / 16)));
      const n = live * 16;
      if (!w.instSnap || w.instSnap.length < n) w.instSnap = new Float32Array(n);
      w.instSnap.set((im.instanceMatrix.array as Float32Array).subarray(0, n));
      w.instSnapCount = im.count;
      w.instSnapVersion = im.instanceMatrix.version;
    }
  }

  // Returns true when the object (or its instance buffer) has diverged from the
  // rendered shadowmap by more than the supplied silhouette thresholds. Discrete
  // structural state compares exactly; continuous transform state uses drift.
  private shadowWatchDrifted(w: ShadowObjectWatch, posQ: number): boolean {
    const obj = w.obj;
    if (!w.anchored) return true;
    // Rotation/scale thresholds in edge-motion units: a drift is significant only
    // when it can move the silhouette by more than posQ world units at the
    // object's own radius. Small pulsing decorations (radius ~0.3) thus tolerate
    // several percent of scale oscillation while building-scale motion stays strict.
    const radius = w.radius > 0 ? w.radius : 1;
    const rotQ = Math.min(0.09, Math.max(0.012, posQ / radius));
    const scaleQ = Math.min(0.12, Math.max(0.015, posQ / radius));
    if (
      obj.visible !== w.sigVisible ||
      obj.castShadow !== w.sigCastShadow ||
      obj.layers.mask !== w.sigLayers
    ) {
      return true;
    }
    if (obj instanceof THREE.Mesh) {
      if ((obj.geometry?.id ?? 0) !== w.sigGeoId) return true;
      const ids = w.sigMatIds;
      const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
      if (mats.length !== ids.length) return true;
      for (let i = 0; i < mats.length; i++) {
        if ((mats[i]?.id ?? 0) !== ids[i]) return true;
      }
      // Bone texture mutation has no CPU-side version we can inspect cheaply.
      // Treat skinned casters as continuously animated; there are currently no
      // skinned battlefield units, but this keeps the invalidation conservative.
      if (obj instanceof THREE.SkinnedMesh) return true;
    }
    if (
      Math.abs(obj.position.x - w.ax) > posQ ||
      Math.abs(obj.position.y - w.ay) > posQ ||
      Math.abs(obj.position.z - w.az) > posQ ||
      Math.abs(obj.rotation.x - w.arx) > rotQ ||
      Math.abs(obj.rotation.y - w.ary) > rotQ ||
      Math.abs(obj.rotation.z - w.arz) > rotQ ||
      Math.abs(obj.scale.x - w.asx) > scaleQ ||
      Math.abs(obj.scale.y - w.asy) > scaleQ ||
      Math.abs(obj.scale.z - w.asz) > scaleQ
    ) {
      return true;
    }
    if (!obj.matrixAutoUpdate) {
      // Frozen objects can be moved by direct matrix writes, so the matrix itself
      // is the source of truth for that small subset.
      if (!w.am) return true;
      const e = obj.matrix.elements;
      for (let i = 0; i < 16; i++) {
        const q = i >= 12 && i <= 14 ? posQ : rotQ;
        if (Math.abs(e[i] - w.am[i]) > q) return true;
      }
    }
    if (w.inst && w.dynamicInstances) {
      const im = w.inst;
      if (im.count !== w.instSnapCount) return true;
      const attr = im.instanceMatrix;
      if (attr.version !== w.instSnapVersion) {
        // The buffer was rewritten since the render; scan for drift beyond the
        // thresholds rather than assuming the rewrite matters (idle suspension
        // rewrite noise is the common case and stays sub-texel).
        if (!w.instSnap) return true;
        const arr = attr.array as Float32Array;
        const live = Math.max(0, Math.min(im.count, Math.floor(arr.length / 16)));
        const n = live * 16;
        for (let i = 0; i < n; i++) {
          const slot = i & 15;
          const q = slot >= 12 && slot <= 14 ? posQ : rotQ;
          if (Math.abs(arr[i] - w.instSnap[i]) > q) return true;
        }
      }
    }
    return false;
  }

  private rebuildShadowWatches(): void {
    const shadowLayers = this.sunLight.shadow.camera.layers;
    const needed = new Set<THREE.Object3D>();
    this.scene.traverse((obj) => {
      const renderable = obj instanceof THREE.Mesh || obj instanceof THREE.Line || obj instanceof THREE.Points;
      if (!renderable || !obj.castShadow || !obj.layers.test(shadowLayers)) return;
      needed.add(obj);
      // Parent transforms/visibility control the shadow even though the parent
      // itself may be a non-rendering Group. Watch the whole ancestor chain.
      for (let p = obj.parent; p && p !== this.scene; p = p.parent) needed.add(p);
    });

    // Preserve anchor state by object identity across rebuilds: vfx/overlay churn
    // in the direct child list must not discard accumulated drift bookkeeping for
    // the casters that stayed in the scene.
    const prev = new Map<THREE.Object3D, ShadowObjectWatch>();
    for (const w of this.shadowWatches) prev.set(w.obj, w);
    const watches: ShadowObjectWatch[] = [];
    this.scene.traverse((obj) => {
      if (!needed.has(obj)) return;
      const existing = prev.get(obj);
      if (existing) {
        prev.delete(obj);
        watches.push(existing);
        return;
      }
      const inst = obj instanceof THREE.InstancedMesh ? obj : null;
      watches.push({
        obj,
        inst,
        dynamicInstances: inst !== null && obj.userData.staticShadowInstances !== true,
        radius: 0,
        anchored: false,
        ax: 0, ay: 0, az: 0,
        arx: 0, ary: 0, arz: 0,
        asx: 0, asy: 0, asz: 0,
        am: null,
        sigVisible: true,
        sigCastShadow: true,
        sigLayers: -1,
        sigGeoId: -1,
        sigMatIds: [],
        instSnap: null,
        instSnapCount: -1,
        instSnapVersion: -1,
      });
    });
    this.shadowWatches = watches;
    this.shadowStructureSafetyFrame = this.frameCount;
    // Anything left in prev is a caster that vanished from the scene (sell/destroy)
    // or stopped casting. Drift scanning cannot notice a watch that no longer exists,
    // so latch the loss until the next shadow render: a stale building-shaped hole
    // in the depth map is exactly the failure this must prevent.
    if (prev.size > 0) this.shadowCasterMembershipLost = true;
  }

  private syncShadowCasterStructure(): boolean {
    const children = this.scene.children;
    let changed = children.length !== this.shadowSceneChildren.length;
    if (!changed) {
      for (let i = 0; i < children.length; i++) {
        if (children[i] !== this.shadowSceneChildren[i]) {
          changed = true;
          break;
        }
      }
    }
    // One level deeper catches lazily-created instance pools (they are added
    // inside the shared instGroup/vehicle-group children rather than as direct
    // scene children) and construction/upgrade mesh swaps on building rigs.
    if (!changed) {
      for (let i = 0; i < children.length; i++) {
        if (children[i].children.length !== (this.shadowSceneChildCounts[i] ?? -1)) {
          changed = true;
          break;
        }
      }
    }
    // Cheap safety net: deeper graph mutations not covered above (a mesh swapped
    // for a same-count caster three levels down) are picked up within a quarter
    // second. Anchor preservation makes these rebuilds drift-neutral.
    if (!changed && this.frameCount - this.shadowStructureSafetyFrame < 15) return false;
    this.shadowSceneChildren = children.slice();
    this.shadowSceneChildCounts = children.map((c) => c.children.length);
    this.rebuildShadowWatches();
    return changed;
  }

  private currentSunShadowFrustumKey(): string {
    const sc = this.sunLight.shadow.camera;
    const p = this.sunLight.position;
    const t = this.sunLight.target.position;
    const vals = [
      sc.left,
      sc.right,
      sc.top,
      sc.bottom,
      sc.near,
      sc.far,
      p.x,
      p.y,
      p.z,
      t.x,
      t.y,
      t.z,
      this.sunLight.shadow.mapSize.x,
      this.sunLight.shadow.mapSize.y,
    ];
    // 1/4096 world-unit quantization is orders of magnitude below one texel; it
    // only removes floating-point noise from the repeated texel-snap calculation.
    return vals.map((v) => Math.round(v * 4096).toString(36)).join(",");
  }

  private scheduleSunShadowUpdate(): void {
    this.shadowFramesSinceUpdate++;
    const structureChanged = this.syncShadowCasterStructure();
    const frustumKey = this.currentSunShadowFrustumKey();

    const sc = this.sunLight.shadow.camera;
    const texel = Math.max(0.001, (sc.right - sc.left) / Math.max(1, this.sunLight.shadow.mapSize.x));
    // Position drift threshold in shadow-texel units. The floor absorbs the
    // ±0.005 idle-suspension oscillation that vehicles play continuously: it can
    // never accumulate past the floor, while genuinely moving units cross it
    // within a frame or two. Rotation/scale thresholds are derived per watch from
    // the caster radius inside shadowWatchDrifted.
    const posQ = Math.max(0.011, texel * 0.5);

    let casterDirty = this.shadowCasterMembershipLost;
    if (!casterDirty) {
      for (const w of this.shadowWatches) {
        if (this.shadowWatchDrifted(w, posQ)) {
          casterDirty = true;
          break;
        }
      }
    }

    const frustumDirty = frustumKey !== this.shadowRenderedFrustumKey;
    const dirty = this.shadowForceDirty || casterDirty || frustumDirty;
    if (!dirty) return;

    // Structural caster changes (place/sell/destroy/upgrade) jump the stride queue:
    // they are rare, and a stale building shadow even for one cadence is a visible bug.
    const structuralCasterChange = (structureChanged || this.shadowCasterMembershipLost) && casterDirty;
    const immediate = this.shadowForceImmediate || structuralCasterChange || frustumDirty;
    const stride = Math.max(1, Math.round(this.graphics.getShadowUpdateStride()));
    if (!immediate && this.shadowFramesSinceUpdate < stride) return;

    this.renderer.shadowMap.needsUpdate = true;
    this.shadowFramesSinceUpdate = 0;
    for (const w of this.shadowWatches) this.captureShadowWatchAnchor(w);
    this.shadowRenderedFrustumKey = frustumKey;
    this.shadowForceDirty = false;
    this.shadowForceImmediate = false;
    this.shadowCasterMembershipLost = false;
  }

  private applyBiomeAtmosphere(atm: BiomeAtmosphere) {
    // Update 3-point sunlit lighting
    this.hemiLight.color.setHex(atm.hemiSky);
    this.hemiLight.groundColor.setHex(atm.hemiGround);
    this.hemiLight.intensity = atm.hemiIntensity;

    const [sx, sy, sz] = atm.sunOffset;
    const sunScale = this.getSunScale();
    this.curSunOffset = [sx, sy, sz];
    this.sunLight.color.setHex(atm.sunColor);
    this.sunLight.intensity = atm.sunIntensity;
    const sunCenterX = this.fpvActive ? this.sunLight.target.position.x : this.mapW / 2;
    const sunCenterZ = this.fpvActive ? this.sunLight.target.position.z : this.mapH / 2;
    if (!this.fpvActive) {
      this.sunLight.target.position.set(this.mapW / 2, 0, this.mapH / 2);
      this.sunLight.target.updateMatrixWorld();
      this.sunLight.position.set(sunCenterX + sx * sunScale, sy * sunScale, sunCenterZ + sz * sunScale);
    } else {
      this.sunLight.position.set(sunCenterX + sx, sy, sunCenterZ + sz);
    }
    this.updateSunShadowFrustum();

    this.rimLight.color.setHex(atm.rimColor);
    this.rimLight.intensity = atm.rimIntensity;
    this.rimLight.position.set(
      this.mapW / 2 - sx * 1.15 * sunScale,
      Math.max(22, sy * 0.48 * sunScale),
      this.mapH / 2 - sz * 1.25 * sunScale,
    );

    // Update sky shader uniforms, RaytracePass sun direction & matching PMREM radiance map
    const sunDir = new THREE.Vector3(sx, sy, sz).normalize();
    this.raytracePass.setSunDirection(sunDir);
    for (const mat of [this.skyMat, this.envSkyMat]) {
      mat.uniforms.uZenith.value.setHex(atm.zenith);
      mat.uniforms.uMidSky.value.setHex(atm.midSky);
      mat.uniforms.uHorizon.value.setHex(atm.horizon);
      mat.uniforms.uGround.value.setHex(atm.groundBounce);
      mat.uniforms.uSunDir.value.copy(sunDir);
      mat.uniforms.uSunColor.value.setHex(atm.sunColor);
      mat.uniforms.uCloudTint.value.setHex(atm.cloudTint);
      mat.uniforms.uCloudOpacity.value = atm.cloudOpacity;
    }

    const prevEnvRT = this.envRT;
    this.envRT = this.pmrem.fromScene(this.envScene, 0.03);
    this.scene.environment = this.envRT.texture;
    this.scene.environmentIntensity = 0.78;
    prevEnvRT?.dispose();
    this.envReady = true;

    // Atmospheric horizon haze & grounded outer skirt
    (this.scene.background as THREE.Color).setHex(atm.fogColor);
    if (this.scene.fog instanceof THREE.FogExp2) {
      this.scene.fog.color.setHex(atm.fogColor);
      this.scene.fog.density = atm.fogDensity;
    }
    this.skirtMat.color.setHex(atm.skirt);
  }

  // Lazy terrain rendering: split whole-map overlays into 16x16-tile chunk
  // meshes so three.js frustum culling can drop off-screen chunks each frame.
  // UVs are remapped to world space (u = x/W, v = 1 - z/H — the same mapping a
  // single full-map PlaneGeometry produces) so shared whole-map textures and
  // the fog DataTexture stay pixel-identical.
  private static readonly TERRAIN_CHUNK = 16;
  // Chunks are merged 2x2 into one static cluster mesh (positions baked into the
  // geometry, identity transform) so each visible cluster is a single draw call.
  // 32x32 tiles vs 48x48 (3x3): at the common RTS camera heights (11-40, roughly
  // 30-55 tiles visible across) a 48-tile cluster is larger than the visible
  // swath, so nearly every cluster straddles the frustum and culling degenerates
  // to drawing everything. 32 still drops edge clusters (a typical view
  // intersects a 2x2 cluster block) while already quartering node count and
  // worst-case visible draw calls vs bare chunks (64 -> 16 on a 128x128 map).
  private static readonly TERRAIN_CLUSTER = GameScene.TERRAIN_CHUNK * 2;

  private fillTerrainChunks(
    group: THREE.Group,
    W: number,
    H: number,
    y: number,
    mat: THREE.Material,
    renderOrder = 0,
    receiveShadow = false,
  ): void {
    for (const child of [...group.children]) {
      group.remove(child);
      if (child instanceof THREE.Mesh) child.geometry.dispose();
    }
    const CH = GameScene.TERRAIN_CHUNK;
    const CL = GameScene.TERRAIN_CLUSTER;
    const clusters = new Map<number, THREE.BufferGeometry[]>();
    for (let cz = 0; cz < H; cz += CH) {
      for (let cx = 0; cx < W; cx += CH) {
        const cw = Math.min(CH, W - cx);
        const ch = Math.min(CH, H - cz);
        const geo = new THREE.PlaneGeometry(cw, ch);
        geo.rotateX(-Math.PI / 2);
        const posA = geo.attributes.position as THREE.BufferAttribute;
        const uvA = geo.attributes.uv as THREE.BufferAttribute;
        const ox = cx + cw / 2,
          oz = cz + ch / 2;
        for (let i = 0; i < posA.count; i++) {
          uvA.setXY(i, (ox + posA.getX(i)) / W, 1 - (oz + posA.getZ(i)) / H);
        }
        // Bake the chunk's world position into its vertices (after the UV remap,
        // which is written against the pre-translation local positions) so chunks
        // of a cluster merge into one static geometry at the identity transform.
        geo.translate(ox, y, oz);
        const key = Math.floor(cz / CL) * 1024 + Math.floor(cx / CL);
        let list = clusters.get(key);
        if (!list) clusters.set(key, (list = []));
        list.push(geo);
      }
    }
    for (const geos of clusters.values()) {
      // Uniform indexed PlaneGeometry attribute layout, so the merge cannot fail.
      const merged = mergeGeometries(geos)!;
      for (const g of geos) g.dispose();
      const m = new THREE.Mesh(merged, mat);
      m.renderOrder = renderOrder;
      m.receiveShadow = receiveShadow;
      group.add(m);
    }
  }

  private buildGround() {
    const { map: microMap, normalMap: microNormalMap } = getGroundMicroDetail();
    this.groundMat = new THREE.MeshStandardMaterial({
      normalScale: new THREE.Vector2(0.88, 0.88),
      roughness: 0.9,
      metalness: 0.03,
      envMapIntensity: 0.45,
    });
    // Dual-UV close-up micro-detail shader: mapW * 0.5 repeats of 256px seamless grain (128 px/tile)
    // fades smoothly with camera distance so 1P eye-level ground stays identically crisp on 64/96/128 maps.
    this.groundMat.customProgramCacheKey = () => "ground-micro-detail-v3";
    this.groundMat.onBeforeCompile = (shader) => {
      shader.uniforms.uMicroMap = { value: microMap };
      shader.uniforms.uMicroNormalMap = { value: microNormalMap };
      shader.uniforms.uMicroRepeat = this.microRepeatUniform;
      shader.fragmentShader = shader.fragmentShader
        .replace(
          "#include <map_pars_fragment>",
          `#include <map_pars_fragment>
          uniform sampler2D uMicroMap;
          uniform sampler2D uMicroNormalMap;
          uniform float uMicroRepeat;`,
        )
        .replace(
          "#include <map_fragment>",
          `#include <map_fragment>
          #ifdef USE_MAP
            float microDist = length(vViewPosition);
            float microFade = 1.0 - smoothstep(10.0, 62.0, microDist);
            if (microFade > 0.001) {
              vec3 microSample = texture2D(uMicroMap, vMapUv * uMicroRepeat).rgb;
              // Taper contrast strength with distance so far ground keeps gentle grain
              // (kills banding/flatness) without visible tiling or moire crawl.
              float microAmp = mix(0.52, 1.0, 1.0 - smoothstep(12.0, 30.0, microDist));
              vec3 microContrast = mix(vec3(1.0), 0.84 + microSample * 0.32, microFade * microAmp);
              // Second, heavily magnified octave of the same tileable grain breaks the
              // uniform repeat and restores the large-scale soil tonality drift that the
              // 5px/tile baked terrain texture cannot carry. Costs one cached texel fetch.
              vec3 macroSample = texture2D(uMicroMap, vMapUv * (uMicroRepeat * 0.059) + vec2(0.37, 0.71)).rgb;
              float macroFade = 1.0 - smoothstep(20.0, 68.0, microDist);
              vec3 macroContrast = mix(vec3(1.0), 0.90 + macroSample * 0.20, macroFade);
              diffuseColor.rgb *= microContrast * macroContrast;
            }
          #endif`,
        )
        .replace(
          "#include <normal_fragment_maps>",
          `#include <normal_fragment_maps>
          #if defined( USE_NORMALMAP_TANGENTSPACE ) && !defined( USE_NORMALMAP_OBJECTSPACE )
            float microNormFade = 1.0 - smoothstep(9.0, 26.0, length(vViewPosition));
            if (microNormFade > 0.001) {
              vec3 microN = texture2D(uMicroNormalMap, vNormalMapUv * uMicroRepeat).xyz * 2.0 - 1.0;
              vec3 detailN = normalize(vec3(mapN.xy + microN.xy * (0.58 * microNormFade), max(0.05, mapN.z * microN.z)));
              normal = normalize(tbn * detailN);
            }
          #endif`,
        );
    };
    this.ground = new THREE.Group();
    this.fillTerrainChunks(this.ground, this.mapW, this.mapH, 0, this.groundMat, 0, true);
    this.scene.add(this.ground);

    // Subtle tactical command grid overlay (uniform color so no fake center UV seam)
    const gridSize = Math.max(this.mapW, this.mapH);
    const grid = new THREE.GridHelper(gridSize, gridSize, 0x3b6e80, 0x3b6e80);
    (grid.material as THREE.Material).transparent = true;
    (grid.material as THREE.Material).opacity = 0.045;
    grid.position.set(this.mapW / 2, 0.018, this.mapH / 2);
    this.gridHelper = grid;
    this.scene.add(grid);
  }

  private buildPerimeter() {
    // Grounded outer terrain skirt fading into atmospheric fog instead of floating over pitch black
    const skirtGeo = new THREE.PlaneGeometry(this.mapW * 4, this.mapH * 4);
    skirtGeo.rotateX(-Math.PI / 2);
    this.skirtMat = new THREE.MeshStandardMaterial({
      color: 0x3b4034,
      roughness: 0.95,
      metalness: 0.02,
      envMapIntensity: 0.35,
    });
    const skirt = new THREE.Mesh(skirtGeo, this.skirtMat);
    skirt.position.set(this.mapW / 2, -0.18, this.mapH / 2);
    skirt.receiveShadow = true;
    this.skirtMesh = skirt;
    this.scene.add(skirt);

    // Subtle glowing tactical boundary line around the playable theater
    const borderPts = [
      new THREE.Vector3(0, 0.05, 0),
      new THREE.Vector3(this.mapW, 0.05, 0),
      new THREE.Vector3(this.mapW, 0.05, this.mapH),
      new THREE.Vector3(0, 0.05, this.mapH),
      new THREE.Vector3(0, 0.05, 0),
    ];
    const border = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints(borderPts),
      new THREE.LineBasicMaterial({ color: 0x3c8ba6, transparent: true, opacity: 0.45 }),
    );
    this.borderLine = border;
    this.scene.add(border);
  }

  private resizeWorldGeometry(): void {
    const W = this.mapW;
    const H = this.mapH;

    // 1) Chunked ground meshes + proportional micro-detail repeat (keeps identical crispness on 64/96/128)
    this.fillTerrainChunks(this.ground, W, H, 0, this.groundMat, 0, true);
    this.microRepeatUniform.value = W * 0.5;

    // 2) Tactical grid overlay
    if (this.gridHelper) {
      this.scene.remove(this.gridHelper);
      this.gridHelper.geometry.dispose();
      const gm = this.gridHelper.material as THREE.Material | THREE.Material[];
      if (Array.isArray(gm)) gm.forEach((m) => m.dispose());
      else gm.dispose();
    }
    const gridSize = Math.max(W, H);
    const grid = new THREE.GridHelper(gridSize, gridSize, 0x3b6e80, 0x3b6e80);
    (grid.material as THREE.Material).transparent = true;
    (grid.material as THREE.Material).opacity = 0.045;
    grid.position.set(W / 2, 0.018, H / 2);
    this.gridHelper = grid;
    this.scene.add(grid);

    // 3) Outer terrain skirt & glowing playable theater border
    this.skirtMesh.geometry.dispose();
    const skirtGeo = new THREE.PlaneGeometry(W * 4, H * 4);
    skirtGeo.rotateX(-Math.PI / 2);
    this.skirtMesh.geometry = skirtGeo;
    this.skirtMesh.position.set(W / 2, -0.18, H / 2);

    this.borderLine.geometry.dispose();
    this.borderLine.geometry = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(0, 0.05, 0),
      new THREE.Vector3(W, 0.05, 0),
      new THREE.Vector3(W, 0.05, H),
      new THREE.Vector3(0, 0.05, H),
      new THREE.Vector3(0, 0.05, 0),
    ]);

    // 4) Sky dome & camera far clip plane
    const nextSkyR = Math.max(420, W * 5);
    if (nextSkyR !== this.skyRadius) {
      this.skyMesh.geometry.dispose();
      this.skyMesh.geometry = new THREE.SphereGeometry(nextSkyR, 32, 20);
      this.skyRadius = nextSkyR;
    }
    this.skyMesh.position.set(W / 2, 0, H / 2);
    const targetFar = Math.max(700, Math.round(nextSkyR * 1.6));
    if (this.camera.far !== targetFar) {
      this.camera.far = targetFar;
      this.camera.updateProjectionMatrix();
    }

    // 5) Fog of War plane, DataTexture & backing typed arrays
    if (this.fogW !== W || this.fogH !== H) {
      this.fogW = W;
      this.fogH = H;
      this.fogData = new Uint8Array(W * H * 4);
      this.fogExplored = new Uint8Array(W * H);
      this.fogVisBuf = new Float32Array(W * H);
      this.fogTex.dispose();
      this.fogTex = new THREE.DataTexture(this.fogData, W, H, THREE.RGBAFormat);
      this.fogTex.magFilter = THREE.LinearFilter;
      this.fogTex.minFilter = THREE.LinearFilter;
      this.fogTex.generateMipmaps = false;
      this.fogTex.wrapS = THREE.ClampToEdgeWrapping;
      this.fogTex.wrapT = THREE.ClampToEdgeWrapping;
      this.fogMat.map = this.fogTex;
      this.fogMat.needsUpdate = true;
      this.fillTerrainChunks(this.fogMesh, W, H, 0.038, this.fogMat, 2);
    }

    // 6) Ore capacity: regions are per-tile — a new map size resets them all
    const nextOreMax = W * H;
    if (this.oreMax !== nextOreMax) {
      this.oreMax = nextOreMax;
      this.oreCols = Math.max(1, Math.ceil(W / 16));
      for (const im of this.oreRegions) {
        if (!im) continue; // sparse array — holes iterate as undefined with for..of
        this.scene.remove(im);
        im.dispose();
      }
      this.oreRegions.length = 0;
      this.oreRegionFree.length = 0;
      this.oreRegionPeak.length = 0;
      this.oreSlots.clear();
    }

    // 7) Keep camera within valid theater bounds and height cap
    const maxH = this.getMaxCamHeight();
    this.camTarget.x = Math.max(-2, Math.min(W + 2, this.camTarget.x));
    this.camTarget.z = Math.max(-2, Math.min(H + 2, this.camTarget.z));
    if (this.camHeight > maxH) this.camHeight = maxH;
    this.updateCamera();
  }

  // ---------- Elevated 3D Cliff Mesas & Map Loading ----------

  loadMap(mapId: MapId, force = false): void {
    if (!force && this.mapLoaded && this.mapId === mapId) return;
    driveBakeJob(this.mapBuildJob(mapId));
  }

  // Cooperative lobby prewarm: runs the exact same build pipeline as loadMap
  // but in sub-frame slices interleaved with rendering, so the lobby stays
  // responsive. Cancellation before the final atomic commit is fully safe —
  // the live scene still holds the previous map and the orphaned partial
  // build is disposed inside the generator's finally block.
  async prewarmMap(mapId: MapId, isCancelled: () => boolean): Promise<boolean> {
    if (this.mapLoaded && this.mapId === mapId) return true;
    const job = this.mapBuildJob(mapId);
    for (;;) {
      if (isCancelled()) {
        job.return(undefined);
        return false;
      }
      const t0 = performance.now();
      let r = job.next();
      while (!r.done && performance.now() - t0 < 8) r = job.next();
      if (r.done) return true;
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
  }

  // Everything a cancelled mid-build job may have allocated offline. Never
  // touches the live scene — disposal here mirrors exactly what the atomic
  // commit would have done with these resources had it taken ownership.
  private disposePartialMapBuild(p: {
    textures: BattlefieldTextures | null;
    group: THREE.Group | null;
    waterMat: THREE.MeshStandardMaterial | null;
    foamMat: THREE.MeshBasicMaterial | null;
    artifactMats: THREE.Material[];
  }): void {
    if (p.textures) {
      p.textures.map.dispose();
      p.textures.bumpMap.dispose();
      p.textures.normalMap.dispose();
      p.textures = null;
    }
    if (p.group) {
      p.group.traverse((o) => {
        if (o instanceof THREE.Mesh || o instanceof THREE.InstancedMesh) {
          o.geometry.dispose();
        }
      });
      p.group = null;
    }
    for (const m of p.artifactMats) m.dispose();
    p.artifactMats.length = 0;
    if (p.waterMat) {
      p.waterMat.normalMap?.dispose();
      p.waterMat.bumpMap?.dispose();
      p.waterMat.dispose();
      p.waterMat = null;
    }
    if (p.foamMat) {
      p.foamMat.dispose();
      p.foamMat = null;
    }
  }

  // Sliceable map construction. Phase one builds terrain textures, cliff/water/
  // artifact geometry fully offline (the generator yields at row/tile
  // boundaries); phase two is one atomic synchronous commit that mutates the
  // live scene. Abandoning the generator before the commit leaves the previous
  // map intact, and the finally block disposes the orphaned partial build.
  private *mapBuildJob(mapId: MapId): Generator<undefined, void, undefined> {
    const partial = {
      textures: null as BattlefieldTextures | null,
      group: null as THREE.Group | null,
      waterMat: null as THREE.MeshStandardMaterial | null,
      foamMat: null as THREE.MeshBasicMaterial | null,
      artifactMats: [] as THREE.Material[],
      artifactAnims: [] as ((t: number, dt: number) => void)[],
    };
    let committed = false;
    try {
      yield* this.mapBuildInner(mapId, partial);
      committed = true;
    } finally {
      if (!committed) this.disposePartialMapBuild(partial);
    }
  }

  private *mapBuildInner(
    mapId: MapId,
    partial: {
      textures: BattlefieldTextures | null;
      group: THREE.Group | null;
      waterMat: THREE.MeshStandardMaterial | null;
      foamMat: THREE.MeshBasicMaterial | null;
      artifactMats: THREE.Material[];
      artifactAnims: ((t: number, dt: number) => void)[];
    },
  ): Generator<undefined, void, undefined> {
    const layout = getMapLayout(mapId);
    const atm = BIOME_ATMOSPHERE[mapId] ?? BIOME_ATMOSPHERE.crossroads;

    // ---- offline build phase (no live-scene mutation until the commit) ----
    partial.textures = yield* battlefieldTexturesJob(mapId);

    const W = layout.w;
    const H = layout.h;
    const cliffSet = new Set<number>();
    for (const [cx, cy] of layout.cliffs) {
      cliffSet.add(cy * W + cx);
    }
    const waterSet = new Set<number>();
    for (const [wx, wy] of layout.water) {
      waterSet.add(wy * W + wx);
    }

    const group = new THREE.Group();
    partial.group = group;

    // Static map dressing is emitted as compact 48x48-tile instanced sectors rather
    // than single whole-map InstancedMesh objects. Three.js can then frustum-cull
    // cliffs/foliage/foam outside the camera AND the (now tightened) shadow frustum.
    // 48 keeps the fully-zoomed-out draw-call overhead small while cutting the bulk
    // of off-screen vertex work at normal RTS zooms.
    const STATIC_INSTANCE_CHUNK = 48;
    const addChunkedInstances = (
      geometry: THREE.BufferGeometry,
      material: THREE.Material,
      matrices: THREE.Matrix4[],
      castShadow: boolean,
      receiveShadow: boolean,
      renderOrder = 0,
      shadowGeometry?: THREE.BufferGeometry,
    ): void => {
      if (matrices.length === 0) return;
      const buckets = new Map<number, THREE.Matrix4[]>();
      for (const m of matrices) {
        const e = m.elements;
        const cx = Math.max(0, Math.floor(e[12] / STATIC_INSTANCE_CHUNK));
        const cz = Math.max(0, Math.floor(e[14] / STATIC_INSTANCE_CHUNK));
        const key = cz * 1024 + cx;
        let list = buckets.get(key);
        if (!list) buckets.set(key, (list = []));
        list.push(m);
      }
      for (const list of buckets.values()) {
        const inst = new THREE.InstancedMesh(geometry, material, list.length);
        for (let i = 0; i < list.length; i++) inst.setMatrixAt(i, list[i]);
        inst.instanceMatrix.needsUpdate = true;
        const useShadowProxy = castShadow && shadowGeometry !== undefined;
        inst.castShadow = castShadow && !useShadowProxy;
        inst.receiveShadow = receiveShadow;
        inst.renderOrder = renderOrder;
        // Instances never move after map construction. The invalidation watcher uses
        // this tag to trust their instance buffers instead of rehashing thousands of
        // static matrix floats every frame (fog hiding is unrelated to these meshes).
        inst.userData.staticShadowInstances = true;
        // Instances never move after map construction, so pay the tight bounding
        // sphere union once here; the renderer then gets real per-sector culling.
        inst.computeBoundingSphere();
        group.add(inst);

        if (useShadowProxy) {
          const proxy = new THREE.InstancedMesh(shadowGeometry, ENV_SHADOW_PROXY_MAT, list.length);
          proxy.name = "env-shadow-proxy";
          for (let i = 0; i < list.length; i++) proxy.setMatrixAt(i, list[i]);
          proxy.instanceMatrix.needsUpdate = true;
          proxy.castShadow = true;
          proxy.receiveShadow = false;
          proxy.layers.set(SHADOW_PROXY_LAYER);
          proxy.raycast = () => {};
          proxy.userData.staticShadowInstances = true;
          proxy.computeBoundingSphere();
          if (inst.boundingSphere) {
            // Use the visual union as a conservative culling bound: the simplified
            // silhouette may be a few percent smaller but must never vanish early.
            proxy.boundingSphere = inst.boundingSphere.clone();
          }
          group.add(proxy);
        }
      }
    };

    const cliffs = layout.cliffs;
    if (cliffs.length > 0) {
      const mats = getCliffRockMaterials(mapId);
      const hasCliff = (tx: number, ty: number) =>
        tx >= 0 && ty >= 0 && tx < W && ty < H && cliffSet.has(ty * W + tx);

      const isIslands = mapId === "islands";
      const isFortress = mapId === "fortress";
      const isTundra = mapId === "tundra" || mapId === "arctic_front";
      const isJungle = mapId === "jungle";
      const isOasis = mapId === "oasis";
      const isArchipelago = mapId === "archipelago" || mapId === "pacific_theatre";
      const isCoastline = mapId === "coastline";
      const isAtlantis = mapId === "atlantis";
      const isShipwreck = mapId === "shipwreck";
      const isVolcano = mapId === "volcano";
      const isCyber = mapId === "cybergrid";
      const isEuropa = mapId === "europa" || mapId === "megacontinent";
      const isArchitectural = isFortress || isAtlantis || isCyber;

      // 1) Tapered rocky/glacial/citadel/monolith base wall blocks
      const wallGeo = isArchitectural
        ? new THREE.BoxGeometry(1.02, 1, 1.02)
        : new THREE.CylinderGeometry(isIslands ? 0.56 : 0.67, isIslands ? 0.78 : 0.82, 1, 4);
      if (!isArchitectural) wallGeo.rotateY(Math.PI / 4);
      // Shadow-only cliff walls: the same four-sided silhouette with no top/bottom
      // cap triangles. Caps/decks are almost entirely contained in this wall volume
      // at ground-shadow scale, so they stay visual receivers but do not rasterize
      // redundant caster geometry (see the addChunkedInstances calls below).
      const wallShadowGeo = isArchitectural
        ? new THREE.CylinderGeometry(0.722, 0.722, 1, 4, 1, true)
        : new THREE.CylinderGeometry(isIslands ? 0.56 : 0.67, isIslands ? 0.78 : 0.82, 1, 4, 1, true);
      wallShadowGeo.rotateY(Math.PI / 4);
      const wallMatrices: THREE.Matrix4[] = [];

      // 2) Sunlit terraced weathered cap plateau
      const capGeo = isArchitectural
        ? new THREE.BoxGeometry(1.06, 1, 1.06)
        : new THREE.CylinderGeometry(isIslands ? 0.44 : 0.58, isIslands ? 0.6 : 0.7, 1, 4);
      if (!isArchitectural) capGeo.rotateY(Math.PI / 4);
      const capMatrices: THREE.Matrix4[] = [];

      // 3) Interior mesa bridge slabs so multi-tile mesas have a solid unified terrace deck
      const deckGeo = new THREE.BoxGeometry(1.06, isArchitectural ? 0.42 : 0.36, 1.06);
      const deckMatrices: THREE.Matrix4[] = [];

      // Optional river-gorge water slab across impassable channels on Islands
      let cliffWaterGeo: THREE.BufferGeometry | null = null;
      const cliffWaterMatrices: THREE.Matrix4[] = [];
      if (isIslands && mats.water) {
        cliffWaterGeo = new THREE.BoxGeometry(1.06, 0.14, 1.06);
      }

      const boulderTransforms: { x: number; y: number; z: number; sx: number; sy: number; sz: number; ry: number }[] = [];
      const treeTransforms: { x: number; y: number; z: number; s: number; ry: number }[] = [];
      const accentTransforms: { x: number; y: number; z: number; sx: number; sy: number; sz: number; ry: number }[] = [];

      const d = this.dummy;
      for (let i = 0; i < cliffs.length; i++) {
        if ((i & 47) === 47) yield;
        const [tx, ty] = cliffs[i];
        const h1 = tileHash(tx, ty, 1);
        const h2 = tileHash(tx, ty, 2);
        const h3 = tileHash(tx, ty, 3);
        const nN = hasCliff(tx, ty - 1);
        const nS = hasCliff(tx, ty + 1);
        const nW = hasCliff(tx - 1, ty);
        const nE = hasCliff(tx + 1, ty);
        const neighbors = (nN ? 1 : 0) + (nS ? 1 : 0) + (nW ? 1 : 0) + (nE ? 1 : 0);

        const cx = tx + 0.5;
        const cz = ty + 0.5;

        if (cliffWaterGeo) {
          d.position.set(cx, 0.08, cz);
          d.rotation.set(0, 0, 0);
          d.scale.set(1, 1, 1);
          d.updateMatrix();
          cliffWaterMatrices.push(d.matrix.clone());
        }

        // Biome-appropriate cliff elevation
        let baseH = 1.48 + h1 * 0.34 + (neighbors >= 3 ? 0.2 : 0);
        if (mapId === "canyon") baseH = 1.85 + h1 * 0.34 + (neighbors >= 3 ? 0.2 : 0);
        else if (isEuropa) baseH = 1.72 + h1 * 0.44 + (neighbors >= 3 ? 0.26 : 0);
        else if (isTundra) baseH = 1.64 + h1 * 0.44 + (neighbors >= 3 ? 0.24 : 0);
        else if (isFortress) baseH = 1.56 + (neighbors >= 2 ? 0.1 : 0) + h1 * 0.09;
        else if (isAtlantis) baseH = 1.38 + (neighbors >= 2 ? 0.14 : 0) + h1 * 0.1;
        else if (isCyber) baseH = 1.58 + (neighbors >= 2 ? 0.16 : 0) + h1 * 0.06;
        else if (isVolcano) baseH = 1.76 + h1 * 0.46 + (neighbors >= 3 ? 0.28 : 0);
        else if (isShipwreck) baseH = 1.25 + h1 * 0.42 + (neighbors >= 3 ? 0.16 : 0);
        else if (isJungle) baseH = 1.6 + h1 * 0.36 + (neighbors >= 3 ? 0.22 : 0);
        else if (isOasis) baseH = 1.5 + h1 * 0.34 + (neighbors >= 3 ? 0.18 : 0);
        else if (isIslands) baseH = 0.46 + h1 * 0.46 + (neighbors < 4 ? 0.18 : 0);

        const capH = isArchitectural ? 0.24 : isIslands ? 0.18 + h2 * 0.14 : 0.28 + h2 * 0.16;

        // On Islands, leave sleek deep water channels in interior tiles while raising jagged wet-slate crags along banks & islets
        const buildCrag = !isIslands || neighbors < 4 || h2 > 0.52;
        if (buildCrag) {
          d.position.set(cx, baseH * 0.5 - 0.04, cz);
          d.rotation.set(0, isIslands ? (h1 - 0.5) * 0.28 : 0, 0);
          const sx = isIslands ? 0.78 + h2 * 0.28 : 1.04 + (nW || nE ? 0.06 : 0);
          const sz = isIslands ? 0.78 + h3 * 0.28 : 1.04 + (nN || nS ? 0.06 : 0);
          d.scale.set(sx, baseH, sz);
          d.updateMatrix();
          wallMatrices.push(d.matrix.clone());

          d.position.set(
            cx + (h2 - 0.5) * (isArchitectural ? 0.01 : 0.05),
            baseH + capH * 0.42,
            cz + (h3 - 0.5) * (isArchitectural ? 0.01 : 0.05),
          );
          d.rotation.set(0, isArchitectural ? 0 : (h1 - 0.5) * 0.1, 0);
          d.scale.set(isIslands ? sx * 0.85 : 0.98, capH, isIslands ? sz * 0.85 : 0.98);
          d.updateMatrix();
          capMatrices.push(d.matrix.clone());
        }

        // Unified mesa deck on tiles connected to >= 2 cliff neighbors (skipped on open river channels)
        if (!isIslands && neighbors >= 2) {
          d.position.set(cx, baseH - 0.06, cz);
          d.rotation.set(0, 0, 0);
          d.scale.set(1, 1, 1);
          d.updateMatrix();
          deckMatrices.push(d.matrix.clone());
        }

        // Edge scree boulders tucked tightly against exposed cliff flanks
        const edgeDirs: [number, number][] = [];
        if (!nN) edgeDirs.push([0, -1]);
        if (!nS) edgeDirs.push([0, 1]);
        if (!nW) edgeDirs.push([-1, 0]);
        if (!nE) edgeDirs.push([1, 0]);
        for (let ei = 0; ei < edgeDirs.length; ei++) {
          const rh = tileHash(tx + ei * 17, ty, 7);
          const boulderThresh = isCyber ? 1.1 : isFortress || isAtlantis ? 0.78 : isIslands ? 0.46 : 0.54;
          if (rh > boulderThresh) {
            const [ex, ez] = edgeDirs[ei];
            const tang = (tileHash(tx, ty + ei * 13, 11) - 0.5) * 0.58;
            const bx = cx + ex * 0.56 + (ez !== 0 ? tang : 0);
            const bz = cz + ez * 0.56 + (ex !== 0 ? tang : 0);
            const bs = 0.22 + tileHash(tx, ty, 19 + ei) * 0.22;
            boulderTransforms.push({
              x: bx,
              y: bs * 0.48,
              z: bz,
              sx: bs * (0.95 + rh * 0.45),
              sy: bs * (0.65 + h2 * 0.4),
              sz: bs * (0.9 + h3 * 0.4),
              ry: rh * Math.PI * 2,
            });
          }

          // Fortified parapet merlons (Fortress), golden temple cornices (Atlantis), or glowing cyan energy trim (Cybergrid)
          if (isFortress && (tx + ty) % 2 === 0) {
            const [ex, ez] = edgeDirs[ei];
            accentTransforms.push({
              x: cx + ex * 0.36,
              y: baseH + capH + 0.12,
              z: cz + ez * 0.36,
              sx: ez !== 0 ? 0.46 : 0.24,
              sy: 0.28,
              sz: ex !== 0 ? 0.46 : 0.24,
              ry: 0,
            });
          } else if (isAtlantis) {
            const [ex, ez] = edgeDirs[ei];
            accentTransforms.push({
              x: cx + ex * 0.42,
              y: baseH + capH + 0.08,
              z: cz + ez * 0.42,
              sx: ez !== 0 ? 0.92 : 0.16,
              sy: 0.16,
              sz: ex !== 0 ? 0.92 : 0.16,
              ry: 0,
            });
          } else if (isCyber) {
            const [ex, ez] = edgeDirs[ei];
            accentTransforms.push({
              x: cx + ex * 0.48,
              y: baseH + capH * 0.35,
              z: cz + ez * 0.48,
              sx: ez !== 0 ? 0.96 : 0.08,
              sy: 0.12,
              sz: ex !== 0 ? 0.96 : 0.08,
              ry: 0,
            });
          } else if (isVolcano && rh > 0.56) {
            // Glowing molten lava fissure seams protruding from volcanic caldera flanks
            const [ex, ez] = edgeDirs[ei];
            accentTransforms.push({
              x: cx + ex * 0.46,
              y: baseH * (0.38 + h2 * 0.35),
              z: cz + ez * 0.46,
              sx: ez !== 0 ? 0.58 : 0.16,
              sy: 0.18 + h1 * 0.22,
              sz: ex !== 0 ? 0.58 : 0.16,
              ry: (h2 - 0.5) * 0.25,
            });
          }
        }

        // Glacier ice spires on Tundra ledges
        if (isTundra && h2 > 0.62) {
          accentTransforms.push({
            x: cx + (h1 - 0.5) * 0.36,
            y: baseH + capH * 0.8 + 0.28,
            z: cz + (h3 - 0.5) * 0.36,
            sx: 0.22 + h1 * 0.16,
            sy: 0.55 + h2 * 0.6,
            sz: 0.22 + h3 * 0.16,
            ry: h1 * Math.PI * 2,
          });
        }

        // Biome-specific trees / palms / jungle canopy / scrub placement (skip trees on Cybergrid, Volcano & Atlantis pylons)
        const treeThresh = isCyber || isVolcano || isAtlantis
          ? 2.0
          : isJungle
            ? 0.28
            : isArchipelago
              ? 0.36
              : isFortress || isShipwreck
                ? 0.82
                : isIslands
                  ? 0.64
                  : isCoastline
                    ? 0.48
                    : isOasis
                      ? 0.52
                      : 0.56;
        if (buildCrag && h3 > treeThresh) {
          const count = isJungle || isArchipelago ? (h1 > 0.45 ? 2 : 1) : h1 > 0.65 ? 2 : 1;
          for (let ti = 0; ti < count; ti++) {
            const ox = (tileHash(tx, ty, 31 + ti) - 0.5) * 0.52;
            const oz = (tileHash(tx, ty, 47 + ti) - 0.5) * 0.52;
            const scBase =
              mapId === "canyon" || isFortress
                ? 0.52
                : isJungle
                  ? 0.92
                  : isOasis || isArchipelago
                    ? 0.88
                    : isIslands || isCoastline || isShipwreck
                      ? 0.72
                      : 0.72;
            const sc = scBase + tileHash(tx, ty, 59 + ti) * 0.42;
            treeTransforms.push({
              x: cx + ox,
              y: baseH + capH * 0.78,
              z: cz + oz,
              s: sc,
              ry: tileHash(tx, ty, 71 + ti) * Math.PI * 2,
            });
          }
        }
      }
      addChunkedInstances(wallGeo, mats.wall, wallMatrices, true, true, 0, wallShadowGeo);
      // Cap/deck silhouette is redundant with the wall blocks for GROUND shadows,
      // but their self-shadowing is what shades the mesa panel grooves — removing
      // it measurably brightened the whole plateau in A/B pixel comparison, so they
      // keep casting with their exact (already minimal) geometry.
      addChunkedInstances(capGeo, mats.cap, capMatrices, true, true);
      addChunkedInstances(deckGeo, mats.cap, deckMatrices, true, true);
      if (cliffWaterGeo && mats.water) {
        addChunkedInstances(cliffWaterGeo, mats.water, cliffWaterMatrices, false, true);
      }

      // Scree boulders around cliff bases
      if (boulderTransforms.length > 0) {
        const bGeo = new THREE.DodecahedronGeometry(0.65, 0);
        const boulderMatrices: THREE.Matrix4[] = [];
        boulderTransforms.forEach((b) => {
          d.position.set(b.x, b.y, b.z);
          d.rotation.set(b.ry * 0.3, b.ry, b.ry * 0.2);
          d.scale.set(b.sx, b.sy, b.sz);
          d.updateMatrix();
          boulderMatrices.push(d.matrix.clone());
        });
        // Scree boulders keep their exact dodecahedral caster: the octahedral
        // stand-in produced visibly different shadow spikes at cliff bases in A/B
        // comparison, and boulder counts are too low for the tri saving to matter.
        addChunkedInstances(bGeo, mats.boulder, boulderMatrices, true, true);
      }

      // Biome accent architecture / glacier crystal spires
      if (accentTransforms.length > 0 && mats.accent) {
        const accGeo = isTundra ? new THREE.ConeGeometry(0.55, 1, 5) : new THREE.BoxGeometry(1, 1, 1);
        const accentMatrices: THREE.Matrix4[] = [];
        accentTransforms.forEach((aTr) => {
          d.position.set(aTr.x, aTr.y, aTr.z);
          d.rotation.set(0, aTr.ry, 0);
          d.scale.set(aTr.sx, aTr.sy, aTr.sz);
          d.updateMatrix();
          accentMatrices.push(d.matrix.clone());
        });
        addChunkedInstances(accGeo, mats.accent, accentMatrices, true, true);
      }

      // Stylized biome foliage: conifer pines, snow-frosted spruce, desert/tropical palms, lush jungle canopies, or canyon scrub
      if (treeTransforms.length > 0) {
        const isPalm = isOasis || isArchipelago;
        const trunkH = isPalm ? 0.88 : isJungle ? 0.56 : 0.34;
        const trunkGeo = new THREE.CylinderGeometry(isPalm ? 0.042 : 0.055, isPalm ? 0.078 : 0.085, trunkH, 6);
        trunkGeo.translate(0, trunkH * 0.5, 0);
        const treeMatrices: THREE.Matrix4[] = [];

        let canopyGeo: THREE.BufferGeometry;
        let snowCapGeo: THREE.BufferGeometry | null = null;
        if (mapId === "canyon" || isFortress) {
          // Hardy desert scrub cluster
          const s1 = new THREE.DodecahedronGeometry(0.28, 0);
          s1.scale(1.15, 0.68, 1.15);
          s1.translate(0, 0.28, 0);
          const s2 = new THREE.DodecahedronGeometry(0.2, 0);
          s2.translate(0.14, 0.22, 0.08);
          canopyGeo = mergeGeometries([s1, s2])!;
          s1.dispose();
          s2.dispose();
        } else if (isPalm) {
          // Iconic Sahara / tropical palm crown (radiating arched fronds)
          const fronds: THREE.BufferGeometry[] = [];
          for (let fi = 0; fi < 6; fi++) {
            const ang = (fi / 6) * Math.PI * 2;
            const raw = new THREE.BoxGeometry(0.12, 0.03, 0.52);
            const f = raw.index ? raw.toNonIndexed() : raw;
            if (f !== raw) raw.dispose();
            f.rotateX(0.32);
            f.translate(0, 0, 0.24);
            f.rotateY(ang);
            f.translate(0, trunkH + 0.02, 0);
            fronds.push(f);
          }
          const rawCrown = new THREE.DodecahedronGeometry(0.12, 0);
          const crown = rawCrown.index ? rawCrown.toNonIndexed() : rawCrown;
          if (crown !== rawCrown) rawCrown.dispose();
          crown.translate(0, trunkH + 0.05, 0);
          fronds.push(crown);
          canopyGeo = mergeGeometries(fronds)!;
          fronds.forEach((g) => g.dispose());
        } else if (isJungle) {
          // Rich dense multi-layered tropical broadleaf umbrella canopy
          const b1 = new THREE.DodecahedronGeometry(0.42, 0);
          b1.scale(1.25, 0.58, 1.25);
          b1.translate(0, trunkH + 0.16, 0);
          const b2 = new THREE.DodecahedronGeometry(0.32, 0);
          b2.scale(1.15, 0.62, 1.15);
          b2.translate(0.22, trunkH + 0.05, 0.14);
          const b3 = new THREE.DodecahedronGeometry(0.28, 0);
          b3.scale(1.1, 0.65, 1.1);
          b3.translate(-0.2, trunkH + 0.22, -0.14);
          canopyGeo = mergeGeometries([b1, b2, b3])!;
          b1.dispose();
          b2.dispose();
          b3.dispose();
        } else {
          // Layered tactical pine / arctic spruce conifer (3 stacked faceted cones)
          const c1 = new THREE.ConeGeometry(0.36, 0.56, 7);
          c1.translate(0, 0.52, 0);
          const c2 = new THREE.ConeGeometry(0.28, 0.5, 7);
          c2.translate(0, 0.84, 0);
          const c3 = new THREE.ConeGeometry(0.18, 0.42, 7);
          c3.translate(0, 1.14, 0);
          canopyGeo = mergeGeometries([c1, c2, c3])!;
          c1.dispose();
          c2.dispose();
          c3.dispose();
          if (isTundra && mats.accent) {
            // Crisp snow-frosted crown dusting on top of arctic spruce
            const sc1 = new THREE.ConeGeometry(0.2, 0.28, 7);
            sc1.translate(0, 1.22, 0);
            const sc2 = new THREE.ConeGeometry(0.3, 0.16, 7);
            sc2.translate(0, 0.94, 0);
            snowCapGeo = mergeGeometries([sc1, sc2])!;
            sc1.dispose();
            sc2.dispose();
          }
        }
        treeTransforms.forEach((tr) => {
          d.position.set(tr.x, tr.y, tr.z);
          d.rotation.set(0, tr.ry, 0);
          d.scale.setScalar(tr.s);
          d.updateMatrix();
          treeMatrices.push(d.matrix.clone());
        });

        // Tree shadow geometry is the EXACT visual geometry merged into a single
        // instanced mesh. An earlier iteration of this lane used simplified crown
        // primitives; A/B pixel comparison showed measurable silhouette and
        // self-shadowing drift on the canopy, so simplification was rejected. The
        // remaining win is structural: trunk+canopy(+snowcap) rasterize as one
        // depth-pass draw per sector instead of two or three separate ones, with
        // zero silhouette change.
        const treeParts: THREE.BufferGeometry[] = [trunkGeo, canopyGeo];
        if (snowCapGeo && mats.accent) treeParts.push(snowCapGeo);
        // mergeGeometries requires uniform indexing; palm/jungle canopies are
        // already non-indexed soup while cones/cylinders are indexed.
        const anyNonIndexed = treeParts.some((g) => !g.index);
        const mergeParts = anyNonIndexed
          ? treeParts.map((g) => {
              if (!g.index) return g;
              const ni = g.toNonIndexed();
              return ni;
            })
          : treeParts;
        const treeShadowGeo = treeParts.length > 1 ? mergeGeometries(mergeParts) : null;
        if (anyNonIndexed) {
          mergeParts.forEach((g, i) => {
            if (g !== treeParts[i]) g.dispose();
          });
        }

        if (treeShadowGeo) {
          addChunkedInstances(trunkGeo, mats.trunk, treeMatrices, false, false);
          addChunkedInstances(canopyGeo, mats.foliage, treeMatrices, true, true, 0, treeShadowGeo);
          if (snowCapGeo && mats.accent) {
            addChunkedInstances(snowCapGeo, mats.accent, treeMatrices, false, true);
          }
        } else {
          addChunkedInstances(trunkGeo, mats.trunk, treeMatrices, true, false);
          addChunkedInstances(canopyGeo, mats.foliage, treeMatrices, true, true);
        }
      }
    }

    // Animated 3D Navigable Ocean Water Surface + Coastal Shoreline Foam
    // Water is emitted per 32x32-tile cluster (same vertex layout as one merged
    // mesh, positions already world-baked) so frustum culling can drop off-screen
    // chunks on ocean-heavy maps. Cluster granularity matches fillTerrainChunks:
    // one merged mesh per cluster instead of 4 separate 16x16 chunk meshes.
    const waterTiles = layout.water;
    if (waterTiles.length > 0) {
      const uvScale = 0.22;
      const yWater = 0.03;

      const hasWaterTile = (tx: number, ty: number) =>
        tx < 0 || ty < 0 || tx >= W || ty >= H ? true : waterSet.has(ty * W + tx);

      const foamEdges: { x: number; z: number; ry: number }[] = [];
      const CH = GameScene.TERRAIN_CLUSTER;
      const chunks = new Map<number, [number, number][]>();
      for (const t of waterTiles) {
        const key = Math.floor(t[1] / CH) * 64 + Math.floor(t[0] / CH);
        let list = chunks.get(key);
        if (!list) chunks.set(key, (list = []));
        list.push(t);

        const [tx, ty] = t;
        // Shoreline white foam strips along every border between water and dry land
        if (!hasWaterTile(tx, ty - 1)) foamEdges.push({ x: tx + 0.5, z: ty + 0.12, ry: 0 });
        if (!hasWaterTile(tx, ty + 1)) foamEdges.push({ x: tx + 0.5, z: ty + 0.88, ry: Math.PI });
        if (!hasWaterTile(tx - 1, ty)) foamEdges.push({ x: tx + 0.12, z: ty + 0.5, ry: Math.PI / 2 });
        if (!hasWaterTile(tx + 1, ty)) foamEdges.push({ x: tx + 0.88, z: ty + 0.5, ry: -Math.PI / 2 });
      }

      partial.waterMat = createOceanWaterMaterial(mapId);
      const waterMat = partial.waterMat;
      for (const tiles of chunks.values()) {
        yield;
        const nTiles = tiles.length;
        const pos = new Float32Array(nTiles * 4 * 3);
        const norm = new Float32Array(nTiles * 4 * 3);
        const uv = new Float32Array(nTiles * 4 * 2);
        const indices = new Uint32Array(nTiles * 6);

        for (let i = 0; i < nTiles; i++) {
          const [tx, ty] = tiles[i];
          const x0 = tx - 0.008;
          const x1 = tx + 1.008;
          const z0 = ty - 0.008;
          const z1 = ty + 1.008;
          const vOff = i * 4;
          const pOff = vOff * 3;
          const uOff = vOff * 2;
          const iOff = i * 6;

          // Quad lying flat in XZ with upward +Y normal and continuous world-space UVs
          pos[pOff] = x0;
          pos[pOff + 1] = yWater;
          pos[pOff + 2] = z0;
          pos[pOff + 3] = x0;
          pos[pOff + 4] = yWater;
          pos[pOff + 5] = z1;
          pos[pOff + 6] = x1;
          pos[pOff + 7] = yWater;
          pos[pOff + 8] = z1;
          pos[pOff + 9] = x1;
          pos[pOff + 10] = yWater;
          pos[pOff + 11] = z0;

          for (let k = 0; k < 4; k++) {
            norm[pOff + k * 3] = 0;
            norm[pOff + k * 3 + 1] = 1;
            norm[pOff + k * 3 + 2] = 0;
          }

          uv[uOff] = x0 * uvScale;
          uv[uOff + 1] = z0 * uvScale;
          uv[uOff + 2] = x0 * uvScale;
          uv[uOff + 3] = z1 * uvScale;
          uv[uOff + 4] = x1 * uvScale;
          uv[uOff + 5] = z1 * uvScale;
          uv[uOff + 6] = x1 * uvScale;
          uv[uOff + 7] = z0 * uvScale;

          indices[iOff] = vOff;
          indices[iOff + 1] = vOff + 1;
          indices[iOff + 2] = vOff + 2;
          indices[iOff + 3] = vOff;
          indices[iOff + 4] = vOff + 2;
          indices[iOff + 5] = vOff + 3;
        }

        const waterGeo = new THREE.BufferGeometry();
        waterGeo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
        waterGeo.setAttribute("normal", new THREE.BufferAttribute(norm, 3));
        waterGeo.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
        waterGeo.setIndex(new THREE.BufferAttribute(indices, 1));

        const waterMesh = new THREE.Mesh(waterGeo, waterMat);
        waterMesh.receiveShadow = true;
        waterMesh.renderOrder = 1;
        group.add(waterMesh);
      }

      if (foamEdges.length > 0) {
        const foamGeo = new THREE.PlaneGeometry(1.06, 0.22);
        foamGeo.rotateX(-Math.PI / 2);
        const foamColor =
          mapId === "atlantis"
            ? 0xe2ffff
            : mapId === "archipelago" || mapId === "pacific_theatre"
              ? 0xd8fcff
              : mapId === "arctic_front"
                ? 0xdaf0fc
                : mapId === "megacontinent"
                  ? 0xc4ecfa
                  : mapId === "shipwreck"
                    ? 0xa4c8d2
                    : mapId === "volcano"
                      ? 0xc0d4dc
                      : mapId === "oilrig"
                        ? 0xc2e6f6
                        : mapId === "coastline"
                          ? 0xb4dce8
                          : 0xc8f0f8;
        partial.foamMat = new THREE.MeshBasicMaterial({
          color: foamColor,
          transparent: true,
          opacity: 0.42,
          depthWrite: false,
        });
        const foamMatrices: THREE.Matrix4[] = [];
        const d = this.dummy;
        for (let i = 0; i < foamEdges.length; i++) {
          const f = foamEdges[i];
          d.position.set(f.x, 0.033, f.z);
          d.rotation.set(0, f.ry, 0);
          d.scale.set(1, 1, 1);
          d.updateMatrix();
          foamMatrices.push(d.matrix.clone());
        }
        addChunkedInstances(foamGeo, partial.foamMat, foamMatrices, false, false, 1);
      }
    }

    // Sculpted 3D Ocean & World Artifacts (static parts frozen with matrixAutoUpdate = false)
    if (layout.artifacts && layout.artifacts.length > 0) {
      yield;
      this.buildArtifacts(group, layout.artifacts, mapId, partial.artifactMats, partial.artifactAnims);
    }

    // ---- atomic commit: the live scene flips to the new map in one synchronous
    // pass. No generator yields below this point, so a cancelled build can never
    // observe a half-mutated scene (and ownership of every offline resource
    // transfers here, which is why the partials are nulled as they move). ----
    const textures = partial.textures!;
    partial.textures = null;
    this.mapId = mapId;
    const dimsChanged = this.mapW !== layout.w || this.mapH !== layout.h;
    this.mapW = layout.w;
    this.mapH = layout.h;
    if (dimsChanged) {
      this.resizeWorldGeometry();
    } else {
      this.microRepeatUniform.value = this.mapW * 0.5;
    }

    const prevMap = this.groundMat.map;
    const prevNormal = this.groundMat.normalMap;
    const prevBump = this.groundMat.bumpMap;
    textures.bumpMap.dispose();
    this.groundMat.map = textures.map;
    this.groundMat.normalMap = textures.normalMap;
    this.groundMat.bumpMap = null;
    this.groundMat.roughness = atm.groundRoughness;
    this.groundMat.envMapIntensity = atm.groundEnv;
    this.groundMat.needsUpdate = true;
    prevMap?.dispose();
    prevNormal?.dispose();
    prevBump?.dispose();

    this.applyBiomeAtmosphere(atm);

    // Clear previous 3D cliff mesas, water surfaces, artifacts & props
    if (this.mapGroup) {
      this.scene.remove(this.mapGroup);
      this.mapGroup.traverse((o) => {
        if (o instanceof THREE.Mesh || o instanceof THREE.InstancedMesh) {
          o.geometry.dispose();
        }
      });
      this.mapGroup = null;
    }
    for (const m of this.artifactMats) m.dispose();
    this.artifactMats = partial.artifactMats;
    partial.artifactMats = [];
    this.artifactAnims = partial.artifactAnims;
    if (this.waterMat) {
      this.waterMat.normalMap?.dispose();
      this.waterMat.bumpMap?.dispose();
      this.waterMat.dispose();
      this.waterMat = null;
    }
    if (this.foamMat) {
      this.foamMat.dispose();
      this.foamMat = null;
    }
    this.waterMat = partial.waterMat;
    partial.waterMat = null;
    if (this.waterMat) this.waterBaseEmissive = this.waterMat.emissiveIntensity;
    this.foamMat = partial.foamMat;
    partial.foamMat = null;
    this.cliffSet = cliffSet;
    this.waterSet = waterSet;

    // Never add mapGroup to this.pickables so terrain & water never block unit selection!
    partial.group = null;
    this.mapGroup = group;
    this.scene.add(group);
    this.mapLoaded = true;
    this.raytracePass.setWaterLevel(0.03, this.hasWater());
    this.invalidateSunShadows(true);
    this.resetFog();
  }

  // ---------- Sculpted 3D Ocean & World Artifacts ----------

  private buildArtifacts(
    group: THREE.Group,
    artifacts: MapArtifact[],
    mapId: MapId,
    mats: THREE.Material[] = this.artifactMats,
    anims: ((t: number, dt: number) => void)[] = this.artifactAnims,
  ): void {
    const trackMat = <T extends THREE.Material>(m: T): T => {
      mats.push(m);
      return m;
    };
    const freezeStatic = (obj: THREE.Object3D): void => {
      obj.updateMatrix();
      obj.matrixAutoUpdate = false;
    };
    const addStatic = (
      parent: THREE.Object3D,
      geo: THREE.BufferGeometry,
      mat: THREE.Material,
      px = 0,
      py = 0,
      pz = 0,
      rx = 0,
      ry = 0,
      rz = 0,
      castShadow = true,
      receiveShadow = true,
    ): THREE.Mesh => {
      const m = new THREE.Mesh(geo, mat);
      m.position.set(px, py, pz);
      m.rotation.set(rx, ry, rz);
      m.castShadow = castShadow;
      m.receiveShadow = receiveShadow;
      freezeStatic(m);
      parent.add(m);
      return m;
    };

    // Per-map shared artifact materials (auto-disposed on next loadMap)
    const foamRingMat = trackMat(
      new THREE.MeshBasicMaterial({
        color: mapId === "atlantis" ? 0xe4ffff : 0xd6f4fc,
        transparent: true,
        opacity: 0.48,
        depthWrite: false,
        side: THREE.DoubleSide,
      }),
    );
    const rustHullMat = trackMat(
      new THREE.MeshStandardMaterial({
        color: 0x5c3628,
        roughness: 0.8,
        metalness: 0.52,
        envMapIntensity: 0.75,
      }),
    );
    const darkHullMat = trackMat(
      new THREE.MeshStandardMaterial({
        color: 0x2c343c,
        roughness: 0.7,
        metalness: 0.62,
        envMapIntensity: 0.85,
      }),
    );
    const rustedDeckMat = trackMat(
      new THREE.MeshStandardMaterial({
        color: 0x4b4038,
        roughness: 0.85,
        metalness: 0.38,
      }),
    );
    const whitePaintMat = trackMat(
      new THREE.MeshStandardMaterial({
        color: 0xe8edf0,
        roughness: 0.56,
        metalness: 0.12,
      }),
    );
    const redPaintMat = trackMat(
      new THREE.MeshStandardMaterial({
        color: 0xc82c24,
        roughness: 0.52,
        metalness: 0.18,
      }),
    );
    const pierStoneMat = trackMat(
      new THREE.MeshStandardMaterial({
        color: 0x626b72,
        roughness: 0.86,
        metalness: 0.1,
      }),
    );
    const lanternGlowMat = trackMat(new THREE.MeshBasicMaterial({ color: new THREE.Color(0xffeaa0).multiplyScalar(1.55) }));
    const beamConeMat = trackMat(
      new THREE.MeshBasicMaterial({
        color: 0xfff2b8,
        transparent: true,
        opacity: 0.16,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        side: THREE.DoubleSide,
      }),
    );
    const marbleMat = trackMat(
      new THREE.MeshStandardMaterial({
        color: 0xe2dac4,
        roughness: 0.36,
        metalness: 0.18,
        envMapIntensity: 0.95,
      }),
    );
    const coralStoneMat = trackMat(
      new THREE.MeshStandardMaterial({
        color: 0x3b8694,
        roughness: 0.48,
        metalness: 0.16,
        envMapIntensity: 0.9,
      }),
    );
    const goldMat = trackMat(
      new THREE.MeshStandardMaterial({
        color: 0xeec452,
        roughness: 0.24,
        metalness: 0.84,
        envMapIntensity: 1.35,
      }),
    );
    const cyanGlowMat = trackMat(new THREE.MeshBasicMaterial({ color: new THREE.Color(0x2cf2ff).multiplyScalar(1.45) }));
    const hazardYellowMat = trackMat(
      new THREE.MeshStandardMaterial({
        color: 0xe6ae22,
        roughness: 0.42,
        metalness: 0.48,
        envMapIntensity: 1.0,
      }),
    );
    const steelMat = getChassisMat("#3c4854", 0.42, 0.68);
    const obsidianMat = trackMat(
      new THREE.MeshStandardMaterial({
        color: 0x1e1a1c,
        roughness: 0.58,
        metalness: 0.28,
        flatShading: true,
      }),
    );
    const lavaGlowMat = trackMat(new THREE.MeshBasicMaterial({ color: new THREE.Color(0xff5e12).multiplyScalar(1.65) }));
    const titanMat = trackMat(
      new THREE.MeshStandardMaterial({
        color: 0x161e2c,
        roughness: 0.22,
        metalness: 0.88,
        envMapIntensity: 1.4,
      }),
    );
    const cliffMats = getCliffRockMaterials(mapId);

    for (let idx = 0; idx < artifacts.length; idx++) {
      const art = artifacts[idx];
      const sc = art.scale ?? 1;
      const rot = art.rot ?? 0;
      const phase = idx * 1.37 + art.x * 0.23 + art.y * 0.17;
      const root = new THREE.Group();
      root.position.set(art.x, 0, art.y);
      root.rotation.y = rot;
      root.scale.setScalar(sc);

      if (art.kind === "shipwreck") {
        // Half-sunk colossal rusted armored dreadnought hull tilted dramatically at ~22 deg out of the waves
        const hullTilt = new THREE.Group();
        hullTilt.position.set(0, 0.28, 0);
        hullTilt.rotation.set(0.16, 0, 0.38); // ~22 deg list + bow pitched skyward

        // Armored main hull & dark lower belt
        addStatic(hullTilt, new THREE.BoxGeometry(1.55, 0.72, 3.6), rustHullMat, 0, 0.1, 0);
        addStatic(hullTilt, new THREE.BoxGeometry(1.62, 0.24, 3.68), darkHullMat, 0, -0.18, 0);
        addStatic(hullTilt, new THREE.BoxGeometry(1.36, 0.1, 3.35), rustedDeckMat, 0, 0.48, 0.05);

        // Tapered armored dreadnought prow jutting dramatically from the waves
        const prowGeo = new THREE.ConeGeometry(0.96, 1.85, 4);
        prowGeo.rotateY(Math.PI / 4);
        prowGeo.rotateX(Math.PI / 2);
        prowGeo.scale(0.86, 0.62, 1);
        addStatic(hullTilt, prowGeo, rustHullMat, 0, 0.14, 2.55);

        // Broken superstructure conning tower & bent mast
        addStatic(hullTilt, new THREE.BoxGeometry(0.95, 0.92, 1.15), darkHullMat, 0.04, 0.92, -0.25, 0, 0, -0.06);
        addStatic(hullTilt, new THREE.BoxGeometry(0.72, 0.46, 0.75), rustHullMat, 0.06, 1.52, -0.22, 0.04, 0, -0.1);
        addStatic(hullTilt, new THREE.CylinderGeometry(0.035, 0.055, 1.3, 6), darkHullMat, 0.1, 2.1, -0.2, 0.22, 0, -0.24);
        addStatic(hullTilt, new THREE.BoxGeometry(0.65, 0.04, 0.05), darkHullMat, 0.2, 2.35, -0.12, 0, 0.2, -0.22);

        // Tilted heavy naval gun turret with twin long barrels
        addStatic(hullTilt, new THREE.CylinderGeometry(0.38, 0.46, 0.34, 6), darkHullMat, 0, 0.66, 1.05, 0, 0.42, 0);
        addStatic(hullTilt, new THREE.CylinderGeometry(0.055, 0.065, 1.35, 6), rustHullMat, 0.12, 0.84, 1.58, 1.24, 0.42, 0);
        addStatic(hullTilt, new THREE.CylinderGeometry(0.055, 0.065, 1.35, 6), rustHullMat, -0.06, 0.84, 1.65, 1.24, 0.42, 0);

        // Angled rusted smokestack funnel
        addStatic(hullTilt, new THREE.CylinderGeometry(0.24, 0.29, 1.05, 8), rustHullMat, -0.04, 1.12, -1.12, -0.16, 0, -0.08);
        addStatic(hullTilt, new THREE.CylinderGeometry(0.26, 0.26, 0.16, 8), darkHullMat, -0.06, 1.64, -1.2, -0.16, 0, -0.08);

        freezeStatic(hullTilt);
        root.add(hullTilt);

        // Waterline white splash foam ring surrounding the sunken dreadnought
        const foamRing = new THREE.Mesh(new THREE.RingGeometry(1.35, 2.15, 24), foamRingMat);
        foamRing.rotation.x = -Math.PI / 2;
        foamRing.scale.set(0.76, 1.55, 1);
        foamRing.position.y = 0.045;
        foamRing.renderOrder = 1;
        root.add(foamRing);
        anims.push((t) => {
          const pulse = 1 + Math.sin(t * 2.1 + phase) * 0.045;
          foamRing.scale.set(0.76 * pulse, 1.55 * pulse, 1);
        });
      } else if (art.kind === "lighthouse") {
        // Octagonal rocky/concrete pier base
        addStatic(root, new THREE.CylinderGeometry(1.05, 1.28, 0.56, 8), pierStoneMat, 0, 0.28, 0);
        addStatic(root, new THREE.CylinderGeometry(0.9, 1.04, 0.18, 8), darkHullMat, 0, 0.62, 0);

        // Striped tapered red & white coastal lighthouse tower
        addStatic(root, new THREE.CylinderGeometry(0.54, 0.66, 0.72, 12), whitePaintMat, 0, 1.06, 0);
        addStatic(root, new THREE.CylinderGeometry(0.45, 0.54, 0.72, 12), redPaintMat, 0, 1.78, 0);
        addStatic(root, new THREE.CylinderGeometry(0.37, 0.45, 0.72, 12), whitePaintMat, 0, 2.5, 0);
        addStatic(root, new THREE.CylinderGeometry(0.31, 0.37, 0.62, 12), redPaintMat, 0, 3.17, 0);

        // Iron gallery balcony & glowing lantern room + conical cupola
        addStatic(root, new THREE.CylinderGeometry(0.52, 0.44, 0.14, 12), darkHullMat, 0, 3.52, 0);
        addStatic(root, new THREE.CylinderGeometry(0.27, 0.27, 0.46, 10), lanternGlowMat, 0, 3.82, 0, 0, 0, 0, false, false);
        addStatic(root, new THREE.ConeGeometry(0.36, 0.42, 10), redPaintMat, 0, 4.24, 0);
        addStatic(root, new THREE.CylinderGeometry(0.02, 0.03, 0.38, 6), darkHullMat, 0, 4.6, 0);

        // Slowly rotating dual volumetric translucent light beam cones!
        const beamPivot = new THREE.Group();
        beamPivot.position.set(0, 3.82, 0);
        const beamGeo1 = new THREE.ConeGeometry(1.35, 9.5, 14, 1, true);
        beamGeo1.rotateX(Math.PI / 2);
        beamGeo1.translate(0, 0, 4.85);
        const b1 = new THREE.Mesh(beamGeo1, beamConeMat);
        b1.rotation.x = 0.24;
        b1.renderOrder = 3;
        freezeStatic(b1);
        const beamGeo2 = new THREE.ConeGeometry(1.35, 9.5, 14, 1, true);
        beamGeo2.rotateX(-Math.PI / 2);
        beamGeo2.translate(0, 0, -4.85);
        const b2 = new THREE.Mesh(beamGeo2, beamConeMat);
        b2.rotation.x = -0.24;
        b2.renderOrder = 3;
        freezeStatic(b2);
        beamPivot.add(b1, b2);
        root.add(beamPivot);

        anims.push((t) => {
          beamPivot.rotation.y = t * 0.72 + phase;
        });
      } else if (art.kind === "buoy") {
        // Floating maritime navigation buoy with lattice tower & blinking beacon
        const floater = new THREE.Group();
        floater.position.set(0, 0.08, 0);

        addStatic(floater, new THREE.CylinderGeometry(0.46, 0.52, 0.28, 10), redPaintMat, 0, 0.08, 0);
        addStatic(floater, new THREE.CylinderGeometry(0.42, 0.46, 0.12, 10), whitePaintMat, 0, 0.26, 0);

        // 4-leg steel lattice frame
        for (let si = 0; si < 4; si++) {
          const ang = (si / 4) * Math.PI * 2 + Math.PI / 4;
          const strut = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.032, 0.88, 5), redPaintMat);
          strut.position.set(Math.cos(ang) * 0.2, 0.68, Math.sin(ang) * 0.2);
          strut.rotation.set(Math.sin(ang) * 0.24, 0, -Math.cos(ang) * 0.24);
          strut.castShadow = true;
          freezeStatic(strut);
          floater.add(strut);
        }
        addStatic(floater, new THREE.CylinderGeometry(0.18, 0.2, 0.08, 8), whitePaintMat, 0, 1.1, 0);

        const beaconMat = trackMat(new THREE.MeshBasicMaterial({ color: new THREE.Color(0xff5518).multiplyScalar(1.8) }));
        const beacon = new THREE.Mesh(new THREE.SphereGeometry(0.13, 8, 8), beaconMat);
        beacon.position.set(0, 1.24, 0);
        floater.add(beacon);
        root.add(floater);

        // Subtle waterline ripple ring
        addStatic(root, new THREE.RingGeometry(0.5, 0.78, 16), foamRingMat, 0, 0.04, 0, -Math.PI / 2, 0, 0, false, false);

        anims.push((t) => {
          floater.position.y = 0.07 + Math.sin(t * 2.2 + phase) * 0.055;
          floater.rotation.z = Math.sin(t * 1.7 + phase) * 0.1;
          floater.rotation.x = Math.cos(t * 1.45 + phase) * 0.08;
          const blink = Math.sin(t * 3.4 + phase) > 0.18;
          beacon.visible = blink;
        });
      } else if (art.kind === "obelisk") {
        // Tall sculpted glowing Atlantean crystal-marble obelisk with floating golden halo ring & cyan runes
        addStatic(root, new THREE.BoxGeometry(1.55, 0.32, 1.55), coralStoneMat, 0, 0.16, 0);
        addStatic(root, new THREE.BoxGeometry(1.18, 0.28, 1.18), marbleMat, 0, 0.44, 0);

        const shaftGeo = new THREE.CylinderGeometry(0.32, 0.56, 3.2, 4);
        shaftGeo.rotateY(Math.PI / 4);
        addStatic(root, shaftGeo, marbleMat, 0, 2.15, 0);

        // Gleaming golden pyramidion tip
        const tipGeo = new THREE.ConeGeometry(0.33, 0.68, 4);
        tipGeo.rotateY(Math.PI / 4);
        addStatic(root, tipGeo, goldMat, 0, 4.08, 0);

        // Glowing cyan Atlantean runes inlaid along all 4 obelisk faces
        for (let fi = 0; fi < 4; fi++) {
          const ang = (fi / 4) * Math.PI * 2;
          const rx = Math.sin(ang) * 0.34;
          const rz = Math.cos(ang) * 0.34;
          addStatic(root, new THREE.BoxGeometry(0.08, 2.15, 0.05), cyanGlowMat, rx, 2.08, rz, 0, ang, 0, false, false);
        }

        // Animated floating golden halo ring orbiting upper spire
        const halo = new THREE.Mesh(new THREE.TorusGeometry(0.68, 0.055, 8, 20), goldMat);
        halo.position.set(0, 3.45, 0);
        halo.rotation.x = Math.PI / 2 + 0.24;
        halo.castShadow = true;
        root.add(halo);

        anims.push((t) => {
          halo.position.y = 3.45 + Math.sin(t * 1.9 + phase) * 0.16;
          halo.rotation.z = t * 0.9 + phase;
          halo.rotation.x = Math.PI / 2 + Math.sin(t * 1.2 + phase) * 0.22;
        });
      } else if (art.kind === "seagate") {
        // Monumental half-submerged ancient Atlantean stone & glowing-crystal archway rising from the ocean
        for (const side of [-1, 1]) {
          const px = side * 2.1;
          addStatic(root, new THREE.BoxGeometry(1.5, 0.72, 1.5), coralStoneMat, px, 0.32, 0);
          addStatic(root, new THREE.BoxGeometry(1.12, 3.6, 1.12), marbleMat, px, 2.35, 0);
          addStatic(root, new THREE.BoxGeometry(1.32, 0.34, 1.32), goldMat, px, 4.2, 0);
          // Vertical glowing cyan crystal inlays on inner & outer arch pillars
          addStatic(root, new THREE.BoxGeometry(0.14, 2.8, 0.26), cyanGlowMat, px - side * 0.54, 2.35, 0, 0, 0, 0, false, false);
          // Waterline foam collar around each submerged pylon base
          addStatic(root, new THREE.RingGeometry(0.95, 1.48, 18), foamRingMat, px, 0.042, 0, -Math.PI / 2, 0, 0, false, false);
        }

        // Monumental carved marble & gold archway lintel + stepped crown
        addStatic(root, new THREE.BoxGeometry(5.6, 0.62, 1.24), marbleMat, 0, 4.55, 0);
        addStatic(root, new THREE.BoxGeometry(4.4, 0.44, 1.05), coralStoneMat, 0, 5.02, 0);
        addStatic(root, new THREE.BoxGeometry(5.8, 0.16, 1.36), goldMat, 0, 4.28, 0);
        addStatic(root, new THREE.BoxGeometry(3.2, 0.14, 0.28), cyanGlowMat, 0, 4.56, 0.56, 0, 0, 0, false, false);
        addStatic(root, new THREE.BoxGeometry(3.2, 0.14, 0.28), cyanGlowMat, 0, 4.56, -0.56, 0, 0, 0, false, false);

        // Hovering glowing Atlantean crystal keystone under the arch apex
        const keystone = new THREE.Mesh(new THREE.OctahedronGeometry(0.48, 0), cyanGlowMat);
        keystone.position.set(0, 3.25, 0);
        root.add(keystone);

        anims.push((t) => {
          keystone.position.y = 3.25 + Math.sin(t * 2.0 + phase) * 0.18;
          keystone.rotation.y = t * 1.1 + phase;
        });
      } else if (art.kind === "oilrig_tower") {
        // Towering yellow/steel offshore drilling derrick with helipad ring, exhaust flare flame & massive steel support legs
        const legOffsets: [number, number][] = [
          [-0.95, -0.95],
          [0.95, -0.95],
          [-0.95, 0.95],
          [0.95, 0.95],
        ];
        for (const [lx, lz] of legOffsets) {
          addStatic(root, new THREE.CylinderGeometry(0.2, 0.26, 2.0, 8), steelMat, lx, 0.45, lz);
          addStatic(root, new THREE.RingGeometry(0.28, 0.52, 12), foamRingMat, lx, 0.042, lz, -Math.PI / 2, 0, 0, false, false);
        }
        // Heavy steel platform deck + yellow hazard safety rim + control cabin
        addStatic(root, new THREE.BoxGeometry(2.55, 0.26, 2.55), steelMat, 0, 1.4, 0);
        addStatic(root, new THREE.BoxGeometry(2.64, 0.1, 2.64), hazardYellowMat, 0, 1.54, 0);
        addStatic(root, new THREE.BoxGeometry(0.85, 0.65, 1.15), whitePaintMat, -0.68, 1.88, -0.42);
        addStatic(root, new THREE.BoxGeometry(0.88, 0.16, 1.18), steelMat, -0.68, 2.24, -0.42);

        // Towering yellow steel lattice drilling derrick pyramid
        for (const [lx, lz] of legOffsets) {
          const sx = lx * 0.64;
          const sz = lz * 0.64;
          addStatic(
            root,
            new THREE.CylinderGeometry(0.06, 0.095, 3.65, 6),
            hazardYellowMat,
            sx * 0.68,
            3.3,
            sz * 0.68,
            -sz * 0.2,
            0,
            sx * 0.2,
          );
        }
        // Derrick crossbeams & crown pulley block
        addStatic(root, new THREE.BoxGeometry(0.95, 0.09, 0.95), hazardYellowMat, 0, 2.55, 0);
        addStatic(root, new THREE.BoxGeometry(0.68, 0.09, 0.68), hazardYellowMat, 0, 3.6, 0);
        addStatic(root, new THREE.BoxGeometry(0.46, 0.24, 0.46), steelMat, 0, 5.05, 0);
        addStatic(root, new THREE.CylinderGeometry(0.06, 0.08, 3.5, 6), steelMat, 0, 3.25, 0);

        // Cantilevered offshore circular helipad deck with crisp yellow H-pad ring
        addStatic(root, new THREE.CylinderGeometry(0.82, 0.78, 0.12, 16), steelMat, 1.55, 1.65, 0.55);
        addStatic(root, new THREE.RingGeometry(0.54, 0.66, 20), hazardYellowMat, 1.55, 1.72, 0.55, -Math.PI / 2, 0, 0, false, false);

        // Angled exhaust flare boom arm + animated flickering glowing orange-gold flare flame!
        addStatic(root, new THREE.CylinderGeometry(0.05, 0.08, 2.4, 6), steelMat, -1.45, 2.75, 1.05, 0.55, 0, 0.68);
        const flareMat = trackMat(new THREE.MeshBasicMaterial({ color: new THREE.Color(0xff8418).multiplyScalar(1.85) }));
        const flare = new THREE.Mesh(new THREE.ConeGeometry(0.24, 0.78, 7), flareMat);
        flare.position.set(-2.15, 3.65, 1.6);
        root.add(flare);

        anims.push((t) => {
          const flick = 0.82 + Math.sin(t * 14.5 + phase) * 0.16 + Math.cos(t * 23.2 + phase) * 0.12;
          flare.scale.set(0.9 + flick * 0.18, flick * 1.15, 0.9 + flick * 0.18);
          flare.rotation.y = t * 5.0 + phase;
        });
      } else if (art.kind === "lava_vent") {
        // Jagged obsidian volcanic spire with glowing molten lava pool & rising embers at its mouth
        addStatic(root, new THREE.CylinderGeometry(0.76, 1.48, 1.55, 7), obsidianMat, 0, 0.75, 0);
        // Surrounding jagged volcanic caldera rim fangs
        for (let fi = 0; fi < 5; fi++) {
          const ang = (fi / 5) * Math.PI * 2 + phase;
          const h = 0.55 + (fi % 2) * 0.35;
          addStatic(
            root,
            new THREE.ConeGeometry(0.32, h, 5),
            obsidianMat,
            Math.cos(ang) * 0.72,
            1.5 + h * 0.32,
            Math.sin(ang) * 0.72,
            Math.sin(ang) * 0.18,
            ang,
            -Math.cos(ang) * 0.18,
          );
        }
        // Incandescent molten lava crater pool + magma rivulets
        const pool = new THREE.Mesh(new THREE.CylinderGeometry(0.62, 0.58, 0.16, 10), lavaGlowMat);
        pool.position.set(0, 1.48, 0);
        root.add(pool);
        addStatic(root, new THREE.BoxGeometry(0.18, 1.1, 0.14), lavaGlowMat, 0.68, 0.85, 0.38, 0.25, 0.5, -0.35, false, false);
        addStatic(root, new THREE.BoxGeometry(0.16, 0.95, 0.12), lavaGlowMat, -0.58, 0.78, -0.45, -0.25, -0.4, 0.36, false, false);

        // Animated rising incandescent embers
        const embers: { mesh: THREE.Mesh; offset: number; ox: number; oz: number }[] = [];
        for (let ei = 0; ei < 4; ei++) {
          const em = new THREE.Mesh(new THREE.OctahedronGeometry(0.085, 0), lavaGlowMat);
          root.add(em);
          embers.push({
            mesh: em,
            offset: ei * 0.25,
            ox: Math.cos(ei * 1.9 + phase) * 0.36,
            oz: Math.sin(ei * 1.9 + phase) * 0.36,
          });
        }
        anims.push((t) => {
          const pulse = 1 + Math.sin(t * 3.2 + phase) * 0.08;
          pool.scale.set(pulse, 1, pulse);
          for (const e of embers) {
            const u = ((t * 0.48 + e.offset + phase * 0.1) % 1 + 1) % 1;
            e.mesh.position.set(e.ox * (1 + u * 0.7), 1.56 + u * 1.85, e.oz * (1 + u * 0.7));
            const s = (1 - u) * 1.15;
            e.mesh.scale.setScalar(Math.max(0.05, s));
            e.mesh.rotation.y = t * 3 + e.offset * 6;
          }
        });
      } else if (art.kind === "monolith") {
        // Sleek floating dark-titanium sci-fi crystal monolith hovering gently over a glowing cyan energy pedestal
        addStatic(root, new THREE.CylinderGeometry(0.95, 1.12, 0.28, 8), titanMat, 0, 0.14, 0);
        addStatic(root, new THREE.RingGeometry(0.62, 0.78, 16), cyanGlowMat, 0, 0.3, 0, -Math.PI / 2, 0, 0, false, false);
        addStatic(root, new THREE.RingGeometry(0.28, 0.4, 16), cyanGlowMat, 0, 0.31, 0, -Math.PI / 2, 0, 0, false, false);

        // Hovering dark-titanium faceted monolith + glowing cyan core seam + tilted holographic ring
        const hover = new THREE.Group();
        hover.position.set(0, 2.35, 0);
        const bodyGeo = new THREE.OctahedronGeometry(0.74, 0);
        bodyGeo.scale(0.68, 2.25, 0.68);
        addStatic(hover, bodyGeo, titanMat, 0, 0, 0);
        addStatic(hover, new THREE.BoxGeometry(0.1, 2.4, 0.72), cyanGlowMat, 0, 0, 0, 0, Math.PI / 4, 0, false, false);
        addStatic(hover, new THREE.BoxGeometry(0.72, 2.4, 0.1), cyanGlowMat, 0, 0, 0, 0, Math.PI / 4, 0, false, false);
        const holoRing = new THREE.Mesh(new THREE.TorusGeometry(0.96, 0.032, 8, 24), cyanGlowMat);
        holoRing.rotation.x = Math.PI / 2 + 0.35;
        freezeStatic(holoRing);
        hover.add(holoRing);
        root.add(hover);

        anims.push((t) => {
          hover.position.y = 2.35 + Math.sin(t * 1.65 + phase) * 0.24;
          hover.rotation.y = t * 0.55 + phase;
        });
      } else if (art.kind === "seastack") {
        // Dramatic layered coastal sea-stack rock formation jutting from the waves with white splash foam collar
        addStatic(root, new THREE.CylinderGeometry(0.62, 1.25, 2.6, 6), cliffMats.wall, 0, 1.25, 0, 0.04, 0.2, -0.05);
        addStatic(root, new THREE.CylinderGeometry(0.45, 0.72, 1.35, 6), cliffMats.cap, 0.08, 2.85, -0.05, -0.05, 0.7, 0.04);
        // Flanking leaning sea-needles
        addStatic(root, new THREE.ConeGeometry(0.52, 2.0, 5), cliffMats.wall, 0.92, 0.92, 0.42, 0.14, 0.4, -0.22);
        addStatic(root, new THREE.ConeGeometry(0.44, 1.6, 5), cliffMats.boulder, -0.82, 0.74, -0.48, -0.18, 1.1, 0.2);

        const splashRing = new THREE.Mesh(new THREE.RingGeometry(1.12, 1.72, 20), foamRingMat);
        splashRing.rotation.x = -Math.PI / 2;
        splashRing.position.y = 0.042;
        splashRing.renderOrder = 1;
        root.add(splashRing);
        anims.push((t) => {
          const s = 1 + Math.sin(t * 2.25 + phase) * 0.06;
          splashRing.scale.set(s, s, 1);
        });
      }

      freezeStatic(root);
      group.add(root);
    }
  }

  isCliff(x: number, y: number): boolean {
    const tx = Math.floor(x);
    const ty = Math.floor(y);
    if (tx < 0 || ty < 0 || tx >= this.mapW || ty >= this.mapH) return false;
    return this.cliffSet.has(ty * this.mapW + tx);
  }

  isWater(x: number, y: number): boolean {
    const tx = Math.floor(x);
    const ty = Math.floor(y);
    if (tx < 0 || ty < 0 || tx >= this.mapW || ty >= this.mapH) return false;
    return this.waterSet.has(ty * this.mapW + tx);
  }

  hasWater(): boolean {
    return this.waterSet.size > 0;
  }

  // ---------- Live Fog of War Shroud ----------

  private buildFog() {
    this.fogW = this.mapW;
    this.fogH = this.mapH;
    this.fogTex = new THREE.DataTexture(this.fogData, this.fogW, this.fogH, THREE.RGBAFormat);
    this.fogTex.magFilter = THREE.LinearFilter;
    this.fogTex.minFilter = THREE.LinearFilter;
    this.fogTex.generateMipmaps = false;
    this.fogTex.wrapS = THREE.ClampToEdgeWrapping;
    this.fogTex.wrapT = THREE.ClampToEdgeWrapping;

    this.fogMat = new THREE.MeshBasicMaterial({
      map: this.fogTex,
      transparent: true,
      depthWrite: false,
      fog: false,
    });
    this.fogMesh = new THREE.Group();
    this.fogMesh.visible = false;
    this.scene.add(this.fogMesh);
    this.fillTerrainChunks(this.fogMesh, this.fogW, this.fogH, 0.038, this.fogMat, 2);
    this.resetFog();
  }

  resetFog(): void {
    this.reconReveals = [];
    this.lastFogSlot = -1;
    this.lastFogSources = [];
    this.fogExplored.fill(0);
    const d = this.fogData;
    const total = this.mapW * this.mapH;
    for (let i = 0; i < total; i++) {
      const p = i * 4;
      d[p] = 7;
      d[p + 1] = 12;
      d[p + 2] = 20;
      d[p + 3] = 184; // ~0.72 unexplored shroud
    }
    this.fogTex.needsUpdate = true;
  }

  addReconReveal(x: number, y: number, r: number, durationMs = 10000): void {
    this.reconReveals.push({ x, y, r, expiresAt: performance.now() + durationMs });
    if (this.lastFogSlot >= 0) {
      this.updateFog(this.lastFogSlot, this.lastFogSources, true);
    }
  }

  getActiveReconReveals(): { x: number; y: number; r: number }[] {
    const now = performance.now();
    if (this.reconReveals.length > 0) {
      let write = 0;
      for (let i = 0; i < this.reconReveals.length; i++) {
        if (this.reconReveals[i].expiresAt > now) {
          this.reconReveals[write++] = this.reconReveals[i];
        }
      }
      this.reconReveals.length = write;
    }
    return this.reconReveals;
  }

  // Fog is recomputed at most every 3rd call (~20Hz at 60fps). The shroud edge
  // moves at unit speed — a 50ms refresh stride is imperceptible — but the
  // per-frame cost (source×tile scan + full-map rewrite + a 150-200KB texture
  // upload) drops ~3×. Forced updates (recon reveals, map reset) bypass the stride.
  private fogStrideCount = 0;

  updateFog(mySlot: number, visionSources: { x: number; y: number; r: number }[], force = false): void {
    this.lastFogSlot = mySlot;
    this.lastFogSources = visionSources;
    if (mySlot < 0) {
      this.fogMesh.visible = false;
      return;
    }
    if (!force && ++this.fogStrideCount % 3 !== 1) return;
    this.fogMesh.visible = true;

    const W = this.mapW;
    const H = this.mapH;
    const vis = this.fogVisBuf;
    const exp = this.fogExplored;
    vis.fill(0);

    const recon = this.getActiveReconReveals();
    const totalSources = visionSources.length + recon.length;
    for (let i = 0; i < totalSources; i++) {
      const s = i < visionSources.length ? visionSources[i] : recon[i - visionSources.length];
      const rOut = s.r + 1.15;
      const rIn = Math.max(0.5, s.r - 1.5);
      const span = Math.max(0.1, rOut - rIn);
      const rOut2 = rOut * rOut;
      const x0 = Math.max(0, Math.floor(s.x - rOut));
      const x1 = Math.min(W - 1, Math.ceil(s.x + rOut));
      const y0 = Math.max(0, Math.floor(s.y - rOut));
      const y1 = Math.min(H - 1, Math.ceil(s.y + rOut));
      for (let ty = y0; ty <= y1; ty++) {
        const dy = ty + 0.5 - s.y;
        const rowOff = ty * W;
        for (let tx = x0; tx <= x1; tx++) {
          const dx = tx + 0.5 - s.x;
          const d2 = dx * dx + dy * dy;
          if (d2 < rOut2) {
            const dist = Math.sqrt(d2);
            const idx = rowOff + tx;
            if (dist <= s.r + 0.2) exp[idx] = 1;
            let f = dist <= rIn ? 1 : 1 - (dist - rIn) / span;
            f = f * f * (3 - 2 * f);
            if (f > vis[idx]) vis[idx] = f;
          }
        }
      }
    }

    const d = this.fogData;
    for (let ty = 0; ty < H; ty++) {
      const rowOff = ty * W;
      // DataTexture flipY=false maps row 0 to v=0 (+Z = H) and row H-1 to v=1 (z = 0)
      const texRowOff = (H - 1 - ty) * W;
      for (let tx = 0; tx < W; tx++) {
        const idx = rowOff + tx;
        const explored = exp[idx];
        const v = vis[idx];
        const baseAlpha = explored ? 87 : 184; // ~0.34 explored dimmed fog, ~0.72 unexplored shroud
        const p = (texRowOff + tx) * 4;
        d[p] = explored ? 10 : 7;
        d[p + 1] = explored ? 18 : 12;
        d[p + 2] = explored ? 28 : 20;
        d[p + 3] = Math.round(baseAlpha * (1 - v));
      }
    }
    this.fogTex.needsUpdate = true;
  }

  // ---------- Build-Zone Overlay (+2 tile perimeter frames) ----------

  setBuildZones(zones: { x: number; y: number; w: number; h: number }[] | null): void {
    while (this.buildZoneGroup.children.length > 0) {
      const c = this.buildZoneGroup.children.pop()!;
      c.traverse((o) => {
        if (o instanceof THREE.Mesh || o instanceof THREE.Line || o instanceof THREE.LineSegments) {
          o.geometry.dispose();
          const m = o.material as THREE.Material | THREE.Material[];
          if (Array.isArray(m)) m.forEach((x) => x.dispose());
          else m.dispose();
        }
      });
    }
    if (!zones || zones.length === 0) {
      this.buildZoneGroup.visible = false;
      return;
    }
    this.buildZoneGroup.visible = true;

    const fillMat = new THREE.MeshBasicMaterial({
      color: 0x30dcff,
      transparent: true,
      opacity: 0.065,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    const lineMat = new THREE.LineBasicMaterial({
      color: 0x52f2ff,
      transparent: true,
      opacity: 0.85,
      depthWrite: false,
    });
    const cornerMat = new THREE.LineBasicMaterial({
      color: 0xb8fbff,
      transparent: true,
      opacity: 0.96,
      depthWrite: false,
    });

    const yFill = 0.048;
    const yLine = 0.062;
    const cornerPts: THREE.Vector3[] = [];

    for (const z of zones) {
      // Zones pass building top-left tile (x, y) and footprint (w, h); expand by +2 tiles each side
      const x0 = Math.max(0, z.x - 2);
      const x1 = Math.min(this.mapW, z.x + z.w + 2);
      const z0 = Math.max(0, z.y - 2);
      const z1 = Math.min(this.mapH, z.y + z.h + 2);
      const bw = x1 - x0;
      const bh = z1 - z0;
      if (bw <= 0 || bh <= 0) continue;

      // Subtle translucent cyan pad highlight
      const planeGeo = new THREE.PlaneGeometry(bw, bh);
      planeGeo.rotateX(-Math.PI / 2);
      const fill = new THREE.Mesh(planeGeo, fillMat.clone());
      fill.position.set((x0 + x1) * 0.5, yFill, (z0 + z1) * 0.5);
      fill.renderOrder = 4;
      this.buildZoneGroup.add(fill);

      // Glowing cyan perimeter frame
      const framePts = [
        new THREE.Vector3(x0, yLine, z0),
        new THREE.Vector3(x1, yLine, z0),
        new THREE.Vector3(x1, yLine, z1),
        new THREE.Vector3(x0, yLine, z1),
        new THREE.Vector3(x0, yLine, z0),
      ];
      const frame = new THREE.Line(new THREE.BufferGeometry().setFromPoints(framePts), lineMat.clone());
      frame.renderOrder = 5;
      this.buildZoneGroup.add(frame);

      // Crisp bright L-brackets at all 4 corners
      const arm = Math.min(0.65, bw * 0.2, bh * 0.2);
      const yC = yLine + 0.008;
      // Top-left
      cornerPts.push(new THREE.Vector3(x0, yC, z0 + arm), new THREE.Vector3(x0, yC, z0));
      cornerPts.push(new THREE.Vector3(x0, yC, z0), new THREE.Vector3(x0 + arm, yC, z0));
      // Top-right
      cornerPts.push(new THREE.Vector3(x1 - arm, yC, z0), new THREE.Vector3(x1, yC, z0));
      cornerPts.push(new THREE.Vector3(x1, yC, z0), new THREE.Vector3(x1, yC, z0 + arm));
      // Bottom-right
      cornerPts.push(new THREE.Vector3(x1, yC, z1 - arm), new THREE.Vector3(x1, yC, z1));
      cornerPts.push(new THREE.Vector3(x1, yC, z1), new THREE.Vector3(x1 - arm, yC, z1));
      // Bottom-left
      cornerPts.push(new THREE.Vector3(x0 + arm, yC, z1), new THREE.Vector3(x0, yC, z1));
      cornerPts.push(new THREE.Vector3(x0, yC, z1), new THREE.Vector3(x0, yC, z1 - arm));
    }

    if (cornerPts.length > 0) {
      const corners = new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(cornerPts), cornerMat);
      corners.renderOrder = 6;
      this.buildZoneGroup.add(corners);
    } else {
      cornerMat.dispose();
    }
    fillMat.dispose();
    lineMat.dispose();
  }

  // ---------- Ore Field ----------

  private buildOre() {
    // Rich mineral crystal clusters anchored into a rocky base
    const shards: THREE.BufferGeometry[] = [];
    const mk = (x: number, z: number, s: number, h: number, rot: number, tilt: number) => {
      const g = new THREE.OctahedronGeometry(s, 0);
      g.scale(1, h, 1);
      g.rotateY(rot);
      g.rotateZ(tilt);
      g.translate(x, s * h * 0.42, z);
      shards.push(g);
    };
    mk(0, 0.02, 0.18, 1.9, 0.4, 0.08);
    mk(-0.18, 0.1, 0.14, 1.35, 1.9, -0.18);
    mk(0.17, 0.12, 0.12, 1.15, 3.6, 0.22);
    mk(0.05, -0.16, 0.11, 0.95, 5.1, -0.12);
    mk(-0.11, -0.13, 0.09, 0.8, 2.7, 0.16);
    const geo = mergeGeometries(shards)!;
    shards.forEach((g) => g.dispose());
    const mat = new THREE.MeshStandardMaterial({
      color: 0xb87c18,
      emissive: 0xff9f1a,
      emissiveIntensity: 0.72,
      roughness: 0.26,
      metalness: 0.35,
    });
    this.oreGeo = geo;
    this.oreMat = mat;
    this.oreMax = this.mapW * this.mapH;
    this.oreCols = Math.max(1, Math.ceil(this.mapW / 16));
  }

  private oreRegionAt(x: number, y: number): number {
    return (y >> 4) * this.oreCols + (x >> 4);
  }

  private ensureOreRegion(r: number): THREE.InstancedMesh {
    let im = this.oreRegions[r];
    if (!im) {
      im = new THREE.InstancedMesh(this.oreGeo, this.oreMat, 256);
      im.count = 0;
      im.castShadow = false;
      // static bounding sphere over the whole 16-tile region → frustum culls it
      const rx = r % this.oreCols, ry = (r / this.oreCols) | 0;
      im.boundingSphere = new THREE.Sphere(new THREE.Vector3(rx * 16 + 8, 0.4, ry * 16 + 8), 13);
      im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      this.oreRegions[r] = im;
      this.scene.add(im);
      if (!this.oreRegionFree[r]) this.oreRegionFree[r] = [];
      if (this.oreRegionPeak[r] === undefined) this.oreRegionPeak[r] = 0;
    }
    return im;
  }

  clearOre() {
    this.oreSlots.clear();
    // oreRegions is sparse (indexed by 16x16 region number) — holes iterate as
    // undefined with for..of and must be skipped, otherwise the second match's
    // init handler dies here mid-reset.
    for (const im of this.oreRegions) {
      if (!im) continue;
      this.scene.remove(im);
      im.dispose();
    }
    this.oreRegions.length = 0;
    this.oreRegionFree.length = 0;
    this.oreRegionPeak.length = 0;
  }

  setOreCells(cells: [number, number, number][]) {
    const W = this.mapW;
    const touched = new Set<number>();
    for (const [x, y, amt] of cells) {
      const key = y * W + x;
      let slot = this.oreSlots.get(key);
      if (amt <= 0) {
        if (slot !== undefined) {
          const im = this.oreRegions[slot.r];
          if (im) {
            this.dummy.position.set(x + 0.5, -10, y + 0.5);
            this.dummy.scale.setScalar(0.001);
            this.dummy.updateMatrix();
            im.setMatrixAt(slot.i, this.dummy.matrix);
            touched.add(slot.r);
          }
          this.oreSlots.delete(key);
          this.oreRegionFree[slot.r].push(slot.i);
        }
        continue;
      }
      const r = this.oreRegionAt(x, y);
      const im = this.ensureOreRegion(r);
      if (slot === undefined) {
        const i = this.oreRegionFree[r].length ? this.oreRegionFree[r].pop()! : this.oreRegionPeak[r]++;
        if (i >= 256) continue;
        slot = { r, i };
        this.oreSlots.set(key, slot);
      }
      const s = 0.45 + Math.min(1, amt / 60) * 0.55;
      this.dummy.position.set(x + 0.5, 0.02, y + 0.5);
      this.dummy.rotation.set(0, ((key * 2654435761) % 628) / 100, 0);
      this.dummy.scale.set(s, s * (0.8 + Math.min(1, amt / 60) * 0.4), s);
      this.dummy.updateMatrix();
      im.setMatrixAt(slot.i, this.dummy.matrix);
      touched.add(r);
    }
    for (const r of touched) {
      const im = this.oreRegions[r];
      im.count = this.oreRegionPeak[r];
      im.instanceMatrix.needsUpdate = true;
    }
  }

  // ---------- picking ----------

  private ndc() {
    const w = this.canvas.clientWidth || 1;
    const h = this.canvas.clientHeight || 1;
    return {
      x: (this.pointerX / w) * 2 - 1,
      y: -(this.pointerY / h) * 2 + 1,
    };
  }

  // screen -> ground plane point (returns THREE.Vector3: x=map x, z=map y)
  pickGround(): THREE.Vector3 | null {
    const p = this.ndc();
    this.raycaster.setFromCamera(new THREE.Vector2(p.x, p.y), this.camera);
    const out = new THREE.Vector3();
    return this.raycaster.ray.intersectPlane(this.groundPlane, out) ? out : null;
  }

  // screen -> visible entity pick (ignores fog-hidden roots, health bars, and selection rings; allows air ground shadows)
  pickEntity(): number | null {
    const p = this.ndc();
    this.raycaster.setFromCamera(new THREE.Vector2(p.x, p.y), this.camera);
    const visibleRoots = this.pickables.filter((r) => r.visible);
    const hits = this.raycaster.intersectObjects(visibleRoots, true);
    for (const h of hits) {
      if (h.object.userData?.isBar && !h.object.userData?.isAirShadow) continue;
      let o: THREE.Object3D | null = h.object;
      let hidden = false;
      let foundId: number | undefined;
      while (o) {
        if (!o.visible || (o.userData?.isBar && !o.userData?.isAirShadow)) {
          hidden = true;
          break;
        }
        if (foundId === undefined && o.userData?.entityId !== undefined) {
          foundId = o.userData.entityId as number;
        }
        o = o.parent;
      }
      if (!hidden && foundId !== undefined) return foundId;
    }
    return null;
  }

  // ---------- camera / shake / loop ----------

  shake(intensity: number): void {
    this.shakeAmp = Math.min(2.4, Math.max(this.shakeAmp, intensity));
  }

  // Standard North-Up isometric RTS camera (camYaw === 0: -Z is UP/North, +X is RIGHT/East),
  // supporting smooth orbital yaw rotation around camTarget.
  updateCamera() {
    if (this.fpvActive) return;
    const h = this.camHeight;
    const dist = h * 0.68;
    const offX = this.camYaw === 0 ? 0 : Math.sin(this.camYaw) * dist;
    const offZ = this.camYaw === 0 ? dist : Math.cos(this.camYaw) * dist;
    this.camera.position.set(
      this.camTarget.x + offX + this.shakeOffset.x,
      h + this.shakeOffset.y,
      this.camTarget.z + offZ + this.shakeOffset.z,
    );
    this.lookVec.set(
      this.camTarget.x + this.shakeOffset.x * 0.35,
      this.camTarget.y,
      this.camTarget.z + this.shakeOffset.z * 0.35,
    );
    this.camera.lookAt(this.lookVec);
  }

  // First-person 3D camera placement: map yaw=0 faces +X (East), yaw=+PI/2 faces +Z (South),
  // pitch>0 tilts up toward +Y; Three.js camera looks down -Z, so rotation.y = -PI/2 - yaw.
  setFpvCamera(pos: THREE.Vector3, yaw: number, pitch: number, fov = 68): void {
    this.fpvActive = true;
    if (Math.abs(this.camera.fov - fov) > 0.01 || this.camera.near !== 0.08) {
      this.camera.fov = fov;
      this.camera.near = 0.08;
      this.camera.updateProjectionMatrix();
    }
    this.camera.position.set(
      pos.x + this.shakeOffset.x * 0.18,
      Math.max(0.18, pos.y + this.shakeOffset.y * 0.14),
      pos.z + this.shakeOffset.z * 0.18,
    );
    this.camera.rotation.order = "YXZ";
    this.camera.rotation.y = -Math.PI / 2 - yaw;
    this.camera.rotation.x = pitch;
    this.camera.rotation.z = 0;

    // 2x sharper dynamic 1P shadows: track forward frustum in front of camera and tighten shadow bounds ±45 -> ±24
    const shadowTargetX = pos.x + Math.cos(yaw) * 10;
    const shadowTargetZ = pos.z + Math.sin(yaw) * 10;
    const [sx, sy, sz] = this.curSunOffset;
    this.sunLight.target.position.set(shadowTargetX, 0, shadowTargetZ);
    this.sunLight.position.set(shadowTargetX + sx, sy, shadowTargetZ + sz);
    this.sunLight.target.updateMatrixWorld();
    if (!this.shadowFpvTight) {
      this.shadowFpvTight = true;
      const sc = this.sunLight.shadow.camera;
      sc.left = -24;
      sc.right = 24;
      sc.top = 24;
      sc.bottom = -24;
      sc.updateProjectionMatrix();
      this.sunLight.shadow.normalBias = 0.016;
    }
    // FPV uses a continuously player-following tight frustum; preserve its existing
    // full-rate update semantics rather than adapting it to the RTS texel cache.
    this.invalidateSunShadows(true);
  }

  restoreRtsCamera(targetX?: number, targetZ?: number): void {
    this.fpvActive = false;
    this.camera.fov = 48;
    this.camera.near = 0.5;
    this.camera.rotation.order = "XYZ";
    this.camera.updateProjectionMatrix();
    if (targetX !== undefined && targetZ !== undefined) {
      this.camTarget.x = Math.max(-2, Math.min(this.mapW + 2, targetX));
      this.camTarget.z = Math.max(-2, Math.min(this.mapH + 2, targetZ));
    }

    // Restore map-wide RTS shadow frustum & center sun light target back to map center
    const [sx, sy, sz] = this.curSunOffset;
    const sunScale = this.getSunScale();
    this.sunLight.target.position.set(this.mapW / 2, 0, this.mapH / 2);
    this.sunLight.position.set(this.mapW / 2 + sx * sunScale, sy * sunScale, this.mapH / 2 + sz * sunScale);
    this.sunLight.target.updateMatrixWorld();
    if (this.shadowFpvTight) {
      this.shadowFpvTight = false;
      this.updateSunShadowFrustum();
      this.sunLight.shadow.normalBias = 0.024;
    }
    this.invalidateSunShadows(true);

    this.updateCamera();
  }

  private getMaxCamHeight(): number {
    return this.mapW >= 120 ? 74 : this.mapW >= 90 ? 60 : 48;
  }

  rotateYaw(deltaRad: number): void {
    let next = this.camYaw + deltaRad;
    next = ((((next + Math.PI) % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2)) - Math.PI;
    if (next <= -Math.PI) next += Math.PI * 2;
    this.camYaw = next;
    this.updateCamera();
  }

  resetYaw(): void {
    this.camYaw = 0;
    this.updateCamera();
  }

  pan(dx: number, dz: number) {
    const s = this.camHeight / 26;
    let wx = dx;
    let wz = dz;
    if (this.camYaw !== 0) {
      const cosY = Math.cos(this.camYaw);
      const sinY = Math.sin(this.camYaw);
      // Screen-right (+dx) = (cosY, -sinY), Screen-down (+dz) = (sinY, cosY)
      wx = dx * cosY + dz * sinY;
      wz = -dx * sinY + dz * cosY;
    }
    this.camTarget.x = Math.max(-2, Math.min(this.mapW + 2, this.camTarget.x + wx * s));
    this.camTarget.z = Math.max(-2, Math.min(this.mapH + 2, this.camTarget.z + wz * s));
    this.updateCamera();
  }

  zoom(delta: number) {
    const maxH = this.getMaxCamHeight();
    this.camHeight = Math.max(11, Math.min(maxH, this.camHeight + delta));
    this.updateCamera();
  }

  resize() {
    const w = this.canvas.clientWidth || innerWidth;
    const h = this.canvas.clientHeight || innerHeight;
    const dpr = this.renderer.getPixelRatio();
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.composer.setPixelRatio(dpr);
    this.composer.setSize(w, h);
    const bScale = this.graphics.getBloomScale();
    this.bloomPass.setSize(Math.max(1, Math.floor(w * dpr * bScale)), Math.max(1, Math.floor(h * dpr * bScale)));
  }

  setLoop(cb: () => void) {
    let last = performance.now();
    const tick = (now: number) => {
      // Schedule next frame first so a transient error can never halt the render loop
      requestAnimationFrame(tick);
      this.dtMs = Math.min(100, Math.max(1, now - last));
      last = now;
      try {
        cb();
      } catch (err) {
        console.error("render loop error:", err);
      }
    };
    requestAnimationFrame(tick);
  }

  render() {
    if (this.contextLost) return;

    const dt = Math.min(0.05, this.dtMs / 1000);
    this.waterTime += dt;
    const t = this.waterTime;

    if (this.waterMat) {
      const waveMap = this.waterMat.normalMap ?? this.waterMat.bumpMap;
      if (waveMap) {
        waveMap.offset.set(t * 0.036 + Math.sin(t * 0.48) * 0.018, t * 0.025 + Math.cos(t * 0.37) * 0.016);
      }
      this.waterMat.emissiveIntensity = this.waterBaseEmissive + Math.sin(t * 1.85) * 0.06;
      if (this.foamMat) {
        this.foamMat.opacity = 0.36 + 0.16 * Math.sin(t * 2.3);
      }
    }

    for (let i = 0; i < this.artifactAnims.length; i++) {
      this.artifactAnims[i](t, dt);
    }

    if (this.shakeAmp > 0.004) {
      this.shakePhase += dt * 48;
      this.shakeAmp *= Math.exp(-dt * 6.2);
      this.shakeOffset.set(
        Math.sin(this.shakePhase * 1.13) * this.shakeAmp,
        Math.cos(this.shakePhase * 1.67) * this.shakeAmp * 0.42,
        Math.sin(this.shakePhase * 1.37 + 1.4) * this.shakeAmp * 0.85,
      );
      this.updateCamera();
    } else if (this.shakeAmp > 0) {
      this.shakeAmp = 0;
      this.shakeOffset.set(0, 0, 0);
      this.updateCamera();
    }

    // Dynamic resolution governor & accurate full-frame GPU telemetry (accumulated across all passes)
    this.renderer.info.autoReset = false;
    const { scaleChanged, targetDpr } = this.graphics.sampleFrame(this.dtMs, this.renderer);
    this.renderer.info.reset();
    if (scaleChanged) {
      this.renderer.setPixelRatio(targetDpr);
      this.resize();
    }

    // Camera-fitted shadow frustum: re-fit around the current RTS view each frame.
    // Safe on non-shadow-update frames because sampling uses the matrix captured at
    // the last shadowmap render, which stays consistent with the stored depth texture.
    if (!this.fpvActive) this.updateSunShadowFrustum();

    // Dirty-keyed shadow refresh. The quality-system stride is still the cadence
    // cap for genuinely changing casters, but unchanged texel-snapped shadowmaps
    // are reused indefinitely instead of being re-rasterized on a blind timer.
    this.frameCount++;
    this.scheduleSunShadowUpdate();

    // Zero-Composer fast path: bypass post-processing render targets whenever the
    // EFFECTIVE settings have all post-FX off (Low preset, manual toggles, or the
    // adaptive governor shedding to tier 3 under load)
    const s = this.graphics.getEffectiveSettings();
    if (!s.raytracing && !s.contactShadows && !s.bloom) {
      this.renderer.render(this.scene, this.camera);
    } else {
      if (this.composer.readBuffer.depthTexture) {
        this.raytracePass.setDepthTexture(this.composer.readBuffer.depthTexture);
      }
      this.composer.render();
    }
  }
}
