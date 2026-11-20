import * as THREE from "three";
import { registerSceneParts } from "./scene-bus";

export interface Pick {
  /** "system": an orbit landmark (tool yard, lifecycle station, machine…); `id` is its hover label.
   *  The hub treats it like an unknown object (tooltip = id); features/orbit-system opens its card. */
  kind: "agent" | "object" | "jev" | "city" | "system";
  id: string;
}

type Resolver = (instanceId: number | undefined) => Pick | null;

/** Maps pickable meshes (often instanced) back to world entities. */
export class PickRegistry {
  private resolvers = new Map<THREE.Object3D, Resolver>();
  private dynamic = new Set<THREE.InstancedMesh>();
  private raycaster = new THREE.Raycaster();

  constructor() {
    registerSceneParts({ pick: this });
  }

  register(obj: THREE.Object3D, resolve: Resolver, opts: { dynamic?: boolean } = {}): void {
    this.resolvers.set(obj, resolve);
    if (opts.dynamic && obj instanceof THREE.InstancedMesh) this.dynamic.add(obj);
  }

  unregister(obj: THREE.Object3D): void {
    this.resolvers.delete(obj);
    if (obj instanceof THREE.InstancedMesh) this.dynamic.delete(obj);
  }

  /** `groundRadius`: an analytic sphere that hides anything behind the planet (cheaper than raycasting terrain). */
  pick(ndc: THREE.Vector2, camera: THREE.Camera, groundRadius: number): Pick | null {
    for (const m of this.dynamic) m.computeBoundingSphere();
    this.raycaster.setFromCamera(ndc, camera);
    const ground = this.raycaster.ray.intersectSphere(new THREE.Sphere(new THREE.Vector3(), groundRadius), new THREE.Vector3());
    const groundDist = ground ? ground.distanceTo(this.raycaster.ray.origin) : Infinity;
    const hits = this.raycaster.intersectObjects([...this.resolvers.keys()], true);
    for (const hit of hits) {
      if (hit.distance > groundDist) return null;
      let cur: THREE.Object3D | null = hit.object;
      while (cur) {
        const resolve = this.resolvers.get(cur);
        if (resolve) {
          const result = resolve(hit.instanceId);
          if (result) return result;
          break;
        }
        cur = cur.parent;
      }
    }
    return null;
  }
}
