import * as THREE from "three";
import { CSS2DObject } from "three/addons/renderers/CSS2DRenderer.js";

export const ROLE_COLORS: Record<string, number> = {
  lead: 0xff8fab,
  investigator: 0x7ec8e3,
  "test-writer": 0x9bdb8f,
  fixer: 0xffc46b,
  reviewer: 0xc3a6ff,
};

export function toolEmoji(tool: string) {
  switch (tool) {
    case "Read":
      return "📖";
    case "Grep":
    case "Glob":
      return "🔍";
    case "Edit":
    case "MultiEdit":
      return "✏️";
    case "Write":
      return "📝";
    case "Bash":
      return "💻";
    default:
      return "🔧";
  }
}

// Shared geometry: every character reuses these, so nothing needs disposing per character.
const GEO = {
  body: new THREE.CapsuleGeometry(0.45, 0.45, 8, 20),
  head: new THREE.SphereGeometry(0.42, 24, 18),
  eye: new THREE.SphereGeometry(0.065, 12, 8),
  shine: new THREE.SphereGeometry(0.022, 8, 6),
  blush: new THREE.SphereGeometry(0.075, 12, 8),
  smile: new THREE.TorusGeometry(0.075, 0.018, 6, 16, Math.PI),
  arm: new THREE.CapsuleGeometry(0.11, 0.3, 4, 10),
  foot: new THREE.SphereGeometry(0.16, 12, 8),
  hat: new THREE.ConeGeometry(0.22, 0.45, 16),
  pom: new THREE.SphereGeometry(0.07, 10, 8),
};

const materialCache = new Map<number, THREE.MeshStandardMaterial>();
function mat(color: number) {
  let m = materialCache.get(color);
  if (!m) {
    m = new THREE.MeshStandardMaterial({ color, roughness: 0.55 });
    materialCache.set(color, m);
  }
  return m;
}

const SKIN = 0xffe1c7;
const INK = 0x2b2233;

type State = "spawning" | "idle" | "thinking" | "walking" | "working" | "celebrating" | "sad" | "leaving" | "gone";
type CloudKind = "thought" | "tool" | "success" | "error";

const elasticOut = (k: number) => (k >= 1 ? 1 : 1 - Math.pow(2, -10 * k) * Math.cos(k * Math.PI * 3.3));

interface Options {
  label: string;
  lead: boolean;
  /** Returns a random point for idle wandering (island-local coordinates). */
  roamPoint: () => THREE.Vector3;
}

export class Character {
  readonly group = new THREE.Group();
  private readonly rig = new THREE.Group();
  private readonly head = new THREE.Group();
  private readonly armL = new THREE.Group();
  private readonly armR = new THREE.Group();
  private readonly footL: THREE.Mesh;
  private readonly footR: THREE.Mesh;
  private readonly bubble: CSS2DObject;
  private readonly cloudEl: HTMLDivElement;

  private state: State = "spawning";
  private stateTime = 0;
  private target: THREE.Vector3 | null = null;
  /** Set for sub-agents: they walk here after spawning and work in place. */
  private desk: THREE.Vector3 | null = null;
  /** What to do after the current walk (or after popping in). */
  private afterWalk: State = "thinking";
  private wanderIn = 2 + Math.random() * 3;
  private readonly phase = Math.random() * 10;
  private typer?: number;

  constructor(
    readonly id: string,
    readonly role: string,
    private readonly opts: Options,
  ) {
    const color = ROLE_COLORS[role] ?? 0xd0d0d0;
    const mesh = (geo: THREE.BufferGeometry, c: number) => {
      const m = new THREE.Mesh(geo, mat(c));
      m.castShadow = true;
      return m;
    };

    // Body
    const body = mesh(GEO.body, color);
    body.position.y = 0.85;
    this.rig.add(body);

    // Head + face (character faces +z)
    this.head.position.y = 1.8;
    this.head.add(mesh(GEO.head, SKIN));
    for (const side of [-1, 1]) {
      const eye = mesh(GEO.eye, INK);
      eye.position.set(side * 0.14, 0.04, 0.37);
      const shine = mesh(GEO.shine, 0xffffff);
      shine.position.set(0.02, 0.03, 0.055);
      eye.add(shine);
      const blush = mesh(GEO.blush, 0xff9aa8);
      blush.position.set(side * 0.25, -0.08, 0.31);
      blush.scale.set(1, 0.6, 0.5);
      this.head.add(eye, blush);
    }
    const smile = mesh(GEO.smile, INK);
    smile.position.set(0, -0.1, 0.4);
    smile.rotation.z = Math.PI;
    this.head.add(smile);

    if (opts.lead) {
      const hat = mesh(GEO.hat, 0xffd166);
      hat.position.set(0.05, 0.5, 0);
      hat.rotation.z = -0.2;
      const pom = mesh(GEO.pom, 0xffffff);
      pom.position.y = 0.25;
      hat.add(pom);
      this.head.add(hat);
    }
    this.rig.add(this.head);

    // Arms pivot at the shoulder
    for (const [pivot, side] of [
      [this.armL, 1],
      [this.armR, -1],
    ] as const) {
      pivot.position.set(side * 0.5, 1.2, 0);
      const arm = mesh(GEO.arm, color);
      arm.position.y = -0.25;
      pivot.add(arm);
      this.rig.add(pivot);
    }

    // Feet
    this.footL = mesh(GEO.foot, 0x5a4a42);
    this.footR = mesh(GEO.foot, 0x5a4a42);
    for (const [foot, side] of [
      [this.footL, 1],
      [this.footR, -1],
    ] as const) {
      foot.position.set(side * 0.2, 0.1, 0.08);
      foot.scale.set(1, 0.55, 1.3);
      this.rig.add(foot);
    }

    this.group.add(this.rig);
    this.group.scale.setScalar(0.001);

    // Thought cloud + name tag, stacked in one overlay anchored above the head.
    const wrap = document.createElement("div");
    wrap.className = "bubble";
    this.cloudEl = document.createElement("div");
    this.cloudEl.className = "cloud empty";
    this.cloudEl.append(document.createElement("span"));
    const tag = document.createElement("div");
    tag.className = "tag";
    tag.style.setProperty("--role", `#${color.toString(16).padStart(6, "0")}`);
    tag.textContent = opts.label;
    wrap.append(this.cloudEl, tag);
    this.bubble = new CSS2DObject(wrap);
    this.bubble.center.set(0.5, 1);
    this.bubble.position.y = 2.75;
    this.group.add(this.bubble);
  }

  get position() {
    return this.group.position;
  }

  get isGone() {
    return this.state === "gone";
  }

  /** Free-moving characters that should keep some distance from each other. */
  get isRoaming() {
    return !this.desk && (this.state === "idle" || this.state === "thinking" || this.state === "walking" || this.state === "working");
  }

  private get isMoving() {
    return this.state === "spawning" || this.state === "walking";
  }

  get isFinished() {
    return this.state === "celebrating" || this.state === "sad" || this.state === "leaving" || this.state === "gone";
  }

  say(text: string, kind: CloudKind) {
    window.clearInterval(this.typer);
    this.cloudEl.className = `cloud ${kind}`;
    this.cloudEl.title = text;
    const span = this.cloudEl.firstElementChild!;
    span.textContent = "";
    let i = 0;
    const chars = [...text];
    this.typer = window.setInterval(() => {
      span.textContent = chars.slice(0, ++i).join("");
      if (i >= chars.length) window.clearInterval(this.typer);
    }, 22);
  }

  think(text: string) {
    this.say(text, "thought");
    if (this.isFinished || this.isMoving) return; // keep going; they'll think once they arrive
    this.setState("thinking");
  }

  /** Walk to a spot (e.g. a prop) and start working; null means work in place. */
  work(text: string, spot: THREE.Vector3 | null) {
    this.say(text, "tool");
    if (this.isFinished) return;
    if (this.state === "spawning") {
      // Don't cut the pop-in short; remember where to go next.
      if (spot) this.target = spot.clone();
      this.afterWalk = "working";
    } else if (spot) this.walkTo(spot, "working");
    else if (this.state === "walking") this.afterWalk = "working"; // e.g. still heading to the desk
    else this.setState("working");
  }

  /** Give this character a desk to walk to once it has popped in. */
  sitAt(spot: THREE.Vector3) {
    this.desk = spot.clone();
  }

  /** Push a roaming character aside (used to keep characters from overlapping). */
  nudge(dx: number, dz: number) {
    this.group.position.x += dx;
    this.group.position.z += dz;
  }

  finish(result: "success" | "error", summary?: string) {
    this.say(summary ?? (result === "success" ? "Done!" : "Oops…"), result);
    this.target = null;
    this.setState(result === "success" ? "celebrating" : "sad");
  }

  /** Remove immediately (used when resyncing). */
  dispose() {
    window.clearInterval(this.typer);
    this.bubble.removeFromParent(); // triggers CSS2DObject cleanup of its DOM element
    this.group.removeFromParent();
  }

  private walkTo(point: THREE.Vector3, then: State) {
    this.target = point.clone();
    this.afterWalk = then;
    this.setState("walking");
  }

  private setState(state: State) {
    if (this.state === "spawning" && state !== "spawning") this.group.scale.setScalar(1);
    this.state = state;
    this.stateTime = 0;
  }

  update(dt: number, t: number) {
    this.stateTime += dt;
    const tt = t + this.phase;

    let bob = 0;
    let sway = 0;
    let squash = 1;
    let armSwing = 0;
    let armRaise = 0;
    let headTilt = 0;
    let step = 0;
    let face: number | null = 0; // face the camera by default

    switch (this.state) {
      case "spawning": {
        const k = Math.min(this.stateTime / 0.7, 1);
        this.group.scale.setScalar(Math.max(elasticOut(k), 0.001));
        armRaise = 1.2 * (1 - k);
        if (k >= 1) {
          const next = this.afterWalk;
          if (this.target) this.walkTo(this.target, next);
          else if (this.desk) this.walkTo(this.desk, next);
          else this.setState(next);
        }
        break;
      }
      case "idle": {
        squash = 1 + Math.sin(tt * 2.2) * 0.03;
        this.wanderIn -= dt;
        if (this.wanderIn <= 0) {
          this.wanderIn = 3 + Math.random() * 4;
          this.walkTo(this.opts.roamPoint(), "idle");
        }
        break;
      }
      case "thinking": {
        squash = 1 + Math.sin(tt * 2.2) * 0.03;
        headTilt = 0.12 + Math.sin(tt * 1.4) * 0.1;
        armRaise = 0.5 + Math.sin(tt * 1.4) * 0.15;
        // Roamers pace around while they think; desk-bound helpers stay put.
        if (!this.desk) {
          this.wanderIn -= dt;
          if (this.wanderIn <= 0) {
            this.wanderIn = 3 + Math.random() * 4;
            this.walkTo(this.opts.roamPoint(), "thinking");
          }
        }
        break;
      }
      case "walking": {
        face = null;
        const w = tt * 13;
        bob = Math.abs(Math.sin(w)) * 0.1;
        sway = Math.sin(w) * 0.1;
        armSwing = Math.sin(w) * 0.7;
        step = Math.sin(w) * 0.12;
        if (this.target) {
          const d = this.target.clone().sub(this.group.position);
          d.y = 0;
          const dist = d.length();
          if (dist < 0.08) {
            this.target = null;
            this.setState(this.afterWalk);
          } else {
            this.group.position.addScaledVector(d.normalize(), Math.min(dist, 2.4 * dt));
            turnToward(this.group, Math.atan2(d.x, d.z), dt * 10);
          }
        } else {
          this.setState("idle");
        }
        break;
      }
      case "working": {
        if (!this.desk) face = null; // keep facing the prop they walked up to
        const w = tt * 14;
        squash = 1 + Math.sin(w) * 0.05;
        armSwing = Math.sin(w) * 0.9;
        break;
      }
      case "celebrating": {
        bob = Math.abs(Math.sin(this.stateTime * 7)) * 0.55;
        squash = 1 + Math.sin(this.stateTime * 14) * 0.06;
        armRaise = 2.4 + Math.sin(this.stateTime * 14) * 0.2;
        if (this.stateTime > 3) this.setState("leaving");
        break;
      }
      case "sad": {
        headTilt = 0.35;
        squash = 0.92;
        armRaise = -0.15;
        if (this.stateTime > 3.5) this.setState("leaving");
        break;
      }
      case "leaving": {
        const k = Math.min(this.stateTime / 0.6, 1);
        this.group.scale.setScalar(Math.max(1 - k * k, 0.001));
        this.group.rotation.y += dt * 12;
        face = null;
        if (k >= 1) this.setState("gone");
        break;
      }
      case "gone":
        return;
    }

    if (face !== null) turnToward(this.group, face, dt * 4);

    const inv = 1 / Math.sqrt(squash);
    this.rig.position.y = bob;
    this.rig.rotation.z = sway;
    this.rig.scale.set(inv, squash, inv);
    this.armL.rotation.set(armSwing, 0, 0.2 + armRaise);
    this.armR.rotation.set(-armSwing, 0, -0.2 - armRaise);
    this.head.rotation.z = headTilt;
    this.footL.position.z = 0.08 + step;
    this.footR.position.z = 0.08 - step;
  }
}

function turnToward(obj: THREE.Object3D, angle: number, k: number) {
  let diff = angle - obj.rotation.y;
  diff = Math.atan2(Math.sin(diff), Math.cos(diff));
  obj.rotation.y += diff * Math.min(k, 1);
}
