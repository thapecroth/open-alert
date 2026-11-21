import * as THREE from "three";
import { makeEntVis } from "./meshes";
import { GameScene } from "./scene";
import { EntKind } from "./util";

const ICON_SIZE = 96;

/**
 * Renders each entity model to a PNG data-URL using a small offscreen scene
 * with matching lighting, so sidebar icons look like the units in-game.
 */
export async function generateIcons(
  gs: GameScene,
  kinds: EntKind[],
  colorHex: string,
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const r = gs.renderer;

  const scene = new THREE.Scene();
  scene.add(new THREE.HemisphereLight(0x9fb8dd, 0x1c1a16, 1.4));
  const key = new THREE.DirectionalLight(0xffe6c0, 2.4);
  key.position.set(3, 5, 2.5);
  scene.add(key);
  const rim = new THREE.DirectionalLight(0x3fb8e8, 0.9);
  rim.position.set(-3, 2, -4);
  scene.add(rim);
  if (gs.scene.environment) scene.environment = gs.scene.environment;

  const cam = new THREE.PerspectiveCamera(38, 1, 0.1, 60);
  const viewDir = new THREE.Vector3(3.1, 2.9, 3.9).normalize();
  const bbox = new THREE.Box3();
  const sphere = new THREE.Sphere();

  const rt = new THREE.WebGLRenderTarget(ICON_SIZE, ICON_SIZE, {
    colorSpace: THREE.SRGBColorSpace,
    samples: 4,
  });
  const pixels = new Uint8Array(ICON_SIZE * ICON_SIZE * 4);

  const prevTarget = r.getRenderTarget();
  for (const kind of kinds) {
    const vis = makeEntVis(kind, colorHex, scene);
    // hide health bars + selection ring from the thumbnail
    vis.barBg.visible = false;
    vis.barFg.visible = false;
    vis.ring.visible = false;
    scene.add(vis.root);
    try {
      // fit the icon camera to the model so small units fill the frame too
      bbox.setFromObject(vis.root);
      bbox.getBoundingSphere(sphere);
      const dist = (sphere.radius * 1.55) / Math.tan((cam.fov * Math.PI) / 360);
      cam.position.copy(sphere.center).addScaledVector(viewDir, dist);
      cam.lookAt(sphere.center);
      r.setRenderTarget(rt);
      r.setClearColor(0x0a1018, 0.55);
      r.clear();
      r.render(scene, cam);
      r.readRenderTargetPixels(rt, 0, 0, ICON_SIZE, ICON_SIZE, pixels);
      out.set(kind, pixelsToDataUrl(pixels));
    } catch {
      // icon generation is best-effort; buttons fall back to text only
    } finally {
      scene.remove(vis.root);
    }
  }
  r.setRenderTarget(prevTarget);
  rt.dispose();
  return out;
}

function pixelsToDataUrl(pixels: Uint8Array): string {
  const c = document.createElement("canvas");
  c.width = c.height = ICON_SIZE;
  const ctx = c.getContext("2d")!;
  const img = ctx.createImageData(ICON_SIZE, ICON_SIZE);
  // GL rows are bottom-up — flip
  for (let y = 0; y < ICON_SIZE; y++) {
    const s = (ICON_SIZE - 1 - y) * ICON_SIZE * 4;
    img.data.set(pixels.subarray(s, s + ICON_SIZE * 4), y * ICON_SIZE * 4);
  }
  ctx.putImageData(img, 0, 0);
  return c.toDataURL("image/png");
}
