import * as THREE from "three";
import { CSS2DObject } from "three/addons/renderers/CSS2DRenderer.js";

/** Half the width of an island's square top. */
export const ISLAND_HALF = 7;
const CORNER_RADIUS = 1.8;

type PropKind = "bookshelf" | "workbench" | "terminal";

/** Which prop a roaming character walks to for each tool. */
const TOOL_PROPS: Record<string, PropKind> = {
  Read: "bookshelf",
  Grep: "bookshelf",
  Glob: "bookshelf",
  Edit: "workbench",
  MultiEdit: "workbench",
  Write: "workbench",
  Bash: "terminal",
};

// Layout (island-local, +z faces the camera):
//   z = -5.2  props row:   bookshelf (-4)   terminal (0)   workbench (4)
//   z = -1.6  desks:              (-2)             (2)
//   z =  1.6  desks:       (-4)            (0)            (4)
//   z =  4.2…5.8           leads roam here
// Desk columns are staggered against the props and each other so clouds don't stack on screen.
const DESK_POSITIONS: [number, number][] = [
  [0, 1.6],
  [-2, -1.6],
  [2, -1.6],
  [-4, 1.6],
  [4, 1.6],
];

export interface Desk {
  /** Where the character stands, behind the desk and facing the camera. */
  spot: THREE.Vector3;
  screen: THREE.MeshStandardMaterial;
  occupant: string | null;
  lastUse: number;
}

const std = (color: number, extra: THREE.MeshStandardMaterialParameters = {}) =>
  new THREE.MeshStandardMaterial({ color, roughness: 0.7, ...extra });

function box(w: number, h: number, d: number, material: THREE.Material) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), material);
  m.castShadow = true;
  m.receiveShadow = true;
  return m;
}

function place<T extends THREE.Object3D>(obj: T, x: number, y: number, z: number): T {
  obj.position.set(x, y, z);
  return obj;
}

function roundedSquare(half: number, r: number) {
  const s = new THREE.Shape();
  s.moveTo(-half + r, -half);
  s.lineTo(half - r, -half);
  s.absarc(half - r, -half + r, r, -Math.PI / 2, 0, false);
  s.lineTo(half, half - r);
  s.absarc(half - r, half - r, r, 0, Math.PI / 2, false);
  s.lineTo(-half + r, half);
  s.absarc(-half + r, half - r, r, Math.PI / 2, Math.PI, false);
  s.lineTo(-half, -half + r);
  s.absarc(-half + r, -half + r, r, Math.PI, Math.PI * 1.5, false);
  return s;
}

/** A rounded-square slab lying flat, spanning y = 0…depth (plus bevel). */
function slab(half: number, depth: number, bevel: number) {
  const geo = new THREE.ExtrudeGeometry(roundedSquare(half, CORNER_RADIUS), {
    depth,
    bevelEnabled: bevel > 0,
    bevelThickness: bevel,
    bevelSize: bevel,
    bevelSegments: 4,
    curveSegments: 12,
  });
  geo.rotateX(-Math.PI / 2);
  return geo;
}

/** A floating island representing one repository. Characters live inside `group`. */
export class Island {
  readonly group = new THREE.Group();
  private readonly baseY: number;
  private readonly phase = Math.random() * Math.PI * 2;
  private readonly props = new Map<PropKind, { spot: THREE.Vector3 }>();
  private readonly desks: Desk[] = [];
  private readonly terminalScreen: THREE.MeshStandardMaterial;
  private lastTerminalUse = -Infinity;

  constructor(
    readonly repo: string,
    position: THREE.Vector3,
  ) {
    this.group.position.copy(position);
    this.baseY = position.y;

    // Grass slab (soft beveled edges) → dirt slab → low-poly rock underneath
    const grass = new THREE.Mesh(slab(ISLAND_HALF, 0.35, 0.18), [std(0x9ad17a), std(0x86c068)]);
    grass.position.y = -0.53;
    grass.receiveShadow = true;
    const dirt = new THREE.Mesh(slab(ISLAND_HALF - 0.1, 1.2, 0), std(0xb98b62));
    dirt.position.y = -1.9;
    const rock = new THREE.Mesh(
      new THREE.ConeGeometry((ISLAND_HALF - 0.4) * Math.SQRT2, 4.5, 4, 2).rotateY(Math.PI / 4),
      std(0xa27752, { flatShading: true }),
    );
    rock.rotation.x = Math.PI;
    rock.position.y = -1.9 - 2.25;
    for (const m of [grass, dirt, rock]) m.userData.island = this;
    this.group.add(grass, dirt, rock);

    this.addBookshelf(new THREE.Vector3(-4, 0, -5.2));
    this.terminalScreen = this.addTerminal(new THREE.Vector3(0, 0, -5.2));
    this.addWorkbench(new THREE.Vector3(4, 0, -5.2));
    for (const [x, z] of DESK_POSITIONS) this.addDesk(x, z);

    for (const [x, z, s] of [
      [-6, -2.6, 0.9],
      [6, -2.2, 0.8],
      [-6, 6, 0.7],
      [6.1, 5.8, 0.6],
    ]) {
      this.addTree(new THREE.Vector3(x, 0, z), s);
    }

    const sign = document.createElement("div");
    sign.className = "island-sign";
    sign.textContent = repo;
    const signObj = new CSS2DObject(sign);
    signObj.center.set(0.5, 0);
    signObj.position.set(0, -1, ISLAND_HALF + 0.2);
    this.group.add(signObj);
  }

  /** Where a roaming character should stand to use `tool`, or null if there's no prop for it. */
  spotFor(tool: string): THREE.Vector3 | null {
    const kind = TOOL_PROPS[tool];
    if (!kind) return null;
    if (kind === "terminal") this.lastTerminalUse = performance.now();
    const spot = this.props.get(kind)!.spot.clone();
    spot.x += (Math.random() - 0.5) * 1.2;
    return spot;
  }

  /** A random spot in the roaming strip along the front of the island. */
  roamPoint(): THREE.Vector3 {
    return new THREE.Vector3((Math.random() * 2 - 1) * 4.8, 0, 4.2 + Math.random() * 1.6);
  }

  claimDesk(agentId: string): Desk | null {
    const desk = this.desks.find((d) => d.occupant === null);
    if (desk) desk.occupant = agentId;
    return desk ?? null;
  }

  releaseDesk(agentId: string) {
    for (const d of this.desks) if (d.occupant === agentId) d.occupant = null;
  }

  /** Make the occupant's laptop flicker, like the terminal does. */
  touchDesk(agentId: string) {
    const desk = this.desks.find((d) => d.occupant === agentId);
    if (desk) desk.lastUse = performance.now();
  }

  update(t: number) {
    this.group.position.y = this.baseY + Math.sin(t * 0.6 + this.phase) * 0.15;
    const now = performance.now();
    const flicker = 0.8 + Math.sin(t * 20) * 0.3;
    this.terminalScreen.emissiveIntensity = now - this.lastTerminalUse < 4000 ? flicker : 0.35;
    for (const d of this.desks) {
      d.screen.emissiveIntensity = !d.occupant ? 0.05 : now - d.lastUse < 3500 ? flicker : 0.45;
    }
  }

  private addDesk(x: number, z: number) {
    const g = place(new THREE.Group(), x, 0, z);
    const wood = std(0xd9a066);
    g.add(place(box(1.5, 0.1, 0.8, wood), 0, 0.75, 0));
    for (const [lx, lz] of [
      [-0.65, -0.3],
      [0.65, -0.3],
      [-0.65, 0.3],
      [0.65, 0.3],
    ]) {
      g.add(place(box(0.08, 0.7, 0.08, wood), lx, 0.35, lz));
    }
    // Laptop: base on the desk, screen tilted back, facing the character behind the desk
    const shell = std(0xcfd6de);
    g.add(place(box(0.55, 0.04, 0.38, shell), 0, 0.82, -0.05));
    const screen = std(0x1b2a3a, { emissive: 0x7ec8ff, emissiveIntensity: 0.05 });
    const lid = place(box(0.55, 0.38, 0.03, screen), 0, 1.0, 0.14);
    lid.rotation.x = 0.25;
    g.add(lid);
    this.group.add(g);
    this.desks.push({ spot: new THREE.Vector3(x, 0, z - 0.72), screen, occupant: null, lastUse: -Infinity });
  }

  private addBookshelf(at: THREE.Vector3) {
    const g = place(new THREE.Group(), at.x, at.y, at.z);
    g.add(place(box(1.5, 1.9, 0.5, std(0x8b5a3c)), 0, 0.95, 0));
    const colors = [0xef6f6c, 0x6cb4ee, 0xf7d060, 0x8fd694, 0xc3a6ff];
    for (let row = 0; row < 3; row++) {
      let x = -0.6;
      while (x < 0.55) {
        const w = 0.1 + Math.random() * 0.08;
        const h = 0.35 + Math.random() * 0.12;
        const book = box(w, h, 0.3, std(colors[Math.floor(Math.random() * colors.length)]));
        book.position.set(x + w / 2, 0.25 + row * 0.55 + h / 2, 0.14);
        g.add(book);
        x += w + 0.03;
      }
    }
    this.group.add(g);
    this.props.set("bookshelf", { spot: at.clone().add(new THREE.Vector3(0, 0, 1.1)) });
  }

  private addWorkbench(at: THREE.Vector3) {
    const g = place(new THREE.Group(), at.x, at.y, at.z);
    const wood = std(0xc08552);
    g.add(place(box(1.8, 0.15, 0.9, wood), 0, 0.85, 0));
    for (const [x, z] of [
      [-0.8, -0.35],
      [0.8, -0.35],
      [-0.8, 0.35],
      [0.8, 0.35],
    ]) {
      g.add(place(box(0.12, 0.8, 0.12, wood), x, 0.4, z));
    }
    g.add(place(box(0.6, 0.02, 0.45, std(0xffffff)), -0.2, 0.94, 0));
    const pencil = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.5, 8), std(0xf7d060));
    pencil.rotation.z = Math.PI / 2;
    pencil.rotation.y = 0.5;
    pencil.position.set(0.4, 0.97, 0.05);
    g.add(pencil);
    this.group.add(g);
    this.props.set("workbench", { spot: at.clone().add(new THREE.Vector3(0, 0, 1.3)) });
  }

  private addTerminal(at: THREE.Vector3) {
    const g = place(new THREE.Group(), at.x, at.y, at.z);
    g.add(place(box(1.4, 0.8, 0.7, std(0x9aa5b1)), 0, 0.4, 0));
    g.add(place(box(1.2, 0.85, 0.12, std(0x3a3f4b)), 0, 1.3, -0.1));
    const screen = std(0x113322, { emissive: 0x33ff99, emissiveIntensity: 0.35 });
    g.add(place(new THREE.Mesh(new THREE.PlaneGeometry(1.0, 0.65), screen), 0, 1.3, -0.035));
    this.group.add(g);
    this.props.set("terminal", { spot: at.clone().add(new THREE.Vector3(0, 0, 1.1)) });
    return screen;
  }

  private addTree(at: THREE.Vector3, scale: number) {
    const g = place(new THREE.Group(), at.x, at.y, at.z);
    g.scale.setScalar(scale);
    const trunk = place(new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.2, 1, 8), std(0x8b5a3c)), 0, 0.5, 0);
    const leaves = place(new THREE.Mesh(new THREE.IcosahedronGeometry(0.8, 0), std(0x6fbf5f, { flatShading: true })), 0, 1.5, 0);
    trunk.castShadow = leaves.castShadow = true;
    g.add(trunk, leaves);
    this.group.add(g);
  }
}
