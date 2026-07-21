// Props — importable set dressing for the stage (a tree, a throne, anything).
// Any .glb/.gltf drops in, gets a transform gizmo, and renders in the raw take
// alongside the actors. Props are geometry, not characters: the AI enhance pass
// keeps them as scene structure, so they give the video model real 3D anchors
// (occlusion, scale, contact) instead of an empty grid.
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { DRACOLoader } from "three/examples/jsm/loaders/DRACOLoader.js";
import { KTX2Loader } from "three/examples/jsm/loaders/KTX2Loader.js";
import { MeshoptDecoder } from "three/examples/jsm/libs/meshopt_decoder.module.js";

export type PropInfo = { id: number; name: string; visible: boolean };

// Every GLTFLoader ultimately uses Three's global FileLoader. Its in-flight map
// already deduplicates concurrent requests; enabling Cache keeps the fetched
// ArrayBuffer for the rest of the session too, across the separate Head,
// Animation, and prop loader instances. Parsed VRM cloning remains M3 work,
// but the same 8.9 MB character URL is now fetched only once per session.
THREE.Cache.enabled = true;

/** Build a GLTFLoader that can actually read production assets.
 *
 *  Real exports are compressed and a bare GLTFLoader rejects them outright —
 *  the throne we tested with *requires* EXT_meshopt_compression, and the game
 *  packs also ship Draco geometry and KTX2/basis textures. Draco and KTX2 fetch
 *  their decoders at runtime, so `bun run setup` copies them from the locked
 *  three package into public/decoders; meshopt is a plain module import.
 *  `renderer` is only needed so KTX2 can pick a transcode target for this GPU. */
export function makeGltfLoader(renderer?: THREE.WebGLRenderer): GLTFLoader {
  const loader = new GLTFLoader();

  const draco = new DRACOLoader().setDecoderPath("/decoders/draco/");
  loader.setDRACOLoader(draco);

  loader.setMeshoptDecoder(MeshoptDecoder);

  if (renderer) {
    const ktx2 = new KTX2Loader().setTranscoderPath("/decoders/basis/").detectSupport(renderer);
    loader.setKTX2Loader(ktx2);
  }
  return loader;
}

export class Prop {
  root = new THREE.Group();
  id: number;
  name: string;
  url: string; // source url, for persistence (http only; blob: can't be restored)

  constructor(id: number, name: string, obj: THREE.Object3D, url = "") {
    this.id = id;
    this.name = name;
    this.url = url;
    this.root.add(obj);
    this.normalize(obj);
  }

  /** Sit the prop on the ground, and undo a centimetre export.
   *
   *  glTF is metres by spec, so a prop measuring >40 units is almost always a
   *  centimetre export (a 2m throne exported as 200). Correct it by dividing by
   *  100 — NOT by normalising to a fixed height: doing that made a 90cm chair and
   *  a 6m tree both exactly 10 units, destroying the relative scale between props
   *  and against the 1.68m actors, which is the whole point of staging in 3D.
   *  A prop that is genuinely >40m survives as >0.4m and can be scaled by hand.
   *
   *  (There is deliberately no millimetre case: a mm export of a 2m prop is 2000
   *  units, which the cm branch already catches. A prop measuring <0.05 units is
   *  simply small and authored correctly — rescaling it would be the bug.)
   *  Pivots also vary, so re-seat the base on the ground afterwards. */
  private normalize(obj: THREE.Object3D) {
    const box = new THREE.Box3().setFromObject(obj);
    if (box.isEmpty()) return;
    const size = box.getSize(new THREE.Vector3());
    const tallest = Math.max(size.x, size.y, size.z);
    if (tallest > 40) obj.scale.multiplyScalar(0.01); // centimetre export

    const b2 = new THREE.Box3().setFromObject(obj);
    const c = b2.getCenter(new THREE.Vector3());
    obj.position.x -= c.x;
    obj.position.z -= c.z;
    obj.position.y -= b2.min.y; // base on the ground
  }

  dispose() {
    // THREE.Material.dispose() only fires an event — it does NOT free the textures
    // it references, so a prop's glTF maps stay resident on the GPU unless we walk
    // them ourselves. Import/remove a few textured props without this and VRAM
    // climbs until the context is lost.
    const killTextures = (mat: THREE.Material) => {
      for (const v of Object.values(mat as unknown as Record<string, unknown>)) {
        if (v && (v as THREE.Texture).isTexture) (v as THREE.Texture).dispose();
      }
      mat.dispose();
    };
    this.root.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.geometry) m.geometry.dispose();
      const mat = m.material as THREE.Material | THREE.Material[] | undefined;
      if (Array.isArray(mat)) mat.forEach(killTextures);
      else if (mat) killTextures(mat);
    });
  }
}

let loader: GLTFLoader | null = null;
/** Configure the shared prop loader once the renderer exists (KTX2 needs it). */
export function initPropLoader(renderer: THREE.WebGLRenderer) {
  loader = makeGltfLoader(renderer);
}

/** Load a .glb/.gltf from a URL or object URL. Throws with a usable message. */
export async function loadProp(id: number, name: string, url: string): Promise<Prop> {
  const l = loader ?? (loader = makeGltfLoader());
  const gltf = await l.loadAsync(url);
  const scene = gltf.scene || gltf.scenes?.[0];
  if (!scene) throw new Error("no scene in file");
  scene.traverse((o) => {
    o.frustumCulled = false;
    const m = o as THREE.Mesh;
    if (m.isMesh) {
      m.castShadow = true;
      m.receiveShadow = true;
    }
  });
  return new Prop(id, name, scene, /^https?:\/\//.test(url) ? url : "");
}

export const isPropFile = (n: string) => /\.(glb|gltf)$/i.test(n);
