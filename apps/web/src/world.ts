import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { CSS2DRenderer } from "three/addons/renderers/CSS2DRenderer.js";
import type { AgentEvent } from "@village/events";
import { Character, toolEmoji } from "./character";
import { Island, ISLAND_HALF } from "./island";

const COLS = 3;
const SPACING = ISLAND_HALF * 2 + 7;
const OVERVIEW_OFFSET = new THREE.Vector3(0, 46, 56);
const FOCUS_OFFSET = new THREE.Vector3(0, 11, 18);
/** Roaming characters closer than this get pushed apart (about one cloud width when zoomed in). */
const PERSONAL_SPACE = 3.2;
/** Beyond this camera distance, clouds switch to a compact one-line style. */
const FAR_DISTANCE = 34;

interface Agent {
  character: Character;
  island: Island;
  parentId?: string;
  link?: THREE.Line;
  hasDesk: boolean;
}

export class World {
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(45, 1, 0.1, 500);
  private readonly renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  private readonly labels = new CSS2DRenderer();
  private readonly controls: OrbitControls;
  private readonly clock = new THREE.Clock();
  private readonly islands = new Map<string, Island>();
  private readonly agents = new Map<string, Agent>();
  private readonly skyClouds: THREE.Group[] = [];
  private readonly linkMaterial = new THREE.LineDashedMaterial({
    color: 0xffffff,
    dashSize: 0.25,
    gapSize: 0.18,
    transparent: true,
    opacity: 0.85,
  });
  private focus: { target: THREE.Vector3; offset: THREE.Vector3 } | null = null;

  constructor(private readonly container: HTMLElement) {
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    container.append(this.renderer.domElement);

    this.labels.domElement.className = "labels";
    container.append(this.labels.domElement);

    this.camera.position.copy(OVERVIEW_OFFSET);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.maxPolarAngle = Math.PI * 0.45;
    this.controls.minDistance = 6;
    this.controls.maxDistance = 120;
    this.controls.addEventListener("start", () => (this.focus = null));

    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x9ec48a, 1.3));
    const sun = new THREE.DirectionalLight(0xfff4e0, 1.8);
    sun.position.set(20, 40, 25);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    Object.assign(sun.shadow.camera, { left: -60, right: 60, top: 60, bottom: -60, far: 150 });
    sun.shadow.bias = -0.0005;
    this.scene.add(sun);

    this.addSkyClouds();

    this.renderer.domElement.addEventListener("dblclick", (e) => this.focusAt(e));
    addEventListener("resize", () => this.resize());
    this.resize();
  }

  start() {
    this.renderer.setAnimationLoop(() => this.frame());
  }

  handle(e: AgentEvent) {
    switch (e.type) {
      case "repo.added":
        this.ensureIsland(e.repo);
        break;

      case "agent.spawned": {
        if (this.agents.has(e.id)) return;
        const island = this.ensureIsland(e.repo);
        const parent = e.parentId ? this.agents.get(e.parentId) : undefined;
        const label = e.issue ? `${e.role} · #${e.issue.number}` : e.role;
        const character = new Character(e.id, e.role, {
          label,
          lead: !e.parentId,
          roamPoint: () => island.roamPoint(),
        });
        // Sub-agents get a desk; leads (and helpers when desks run out) roam.
        const desk = parent ? island.claimDesk(e.id) : null;
        if (desk) character.sitAt(desk.spot);

        if (parent) {
          // Pop out right next to the parent
          const a = Math.random() * Math.PI * 2;
          character.position.copy(parent.character.position).add(new THREE.Vector3(Math.cos(a) * 1.3, 0, Math.sin(a) * 1.3));
        } else {
          character.position.copy(island.roamPoint());
        }
        island.group.add(character.group);

        const agent: Agent = { character, island, parentId: e.parentId, hasDesk: !!desk };
        if (parent) {
          agent.link = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]), this.linkMaterial);
          island.group.add(agent.link);
        }
        this.agents.set(e.id, agent);
        if (e.issue) character.say(`🐣 #${e.issue.number}: ${e.issue.title}`, "thought");
        break;
      }

      case "agent.thought":
        this.agents.get(e.id)?.character.think(e.text);
        break;

      case "agent.tool": {
        const agent = this.agents.get(e.id);
        if (!agent) break;
        let spot: THREE.Vector3 | null = null;
        if (agent.hasDesk) agent.island.touchDesk(e.id);
        else spot = agent.island.spotFor(e.tool);
        agent.character.work(`${toolEmoji(e.tool)} ${shortenPaths(e.summary)}`, spot);
        break;
      }

      case "agent.done":
        this.agents.get(e.id)?.character.finish(e.result, e.summary);
        break;
    }
  }

  clearAgents() {
    for (const id of [...this.agents.keys()]) this.removeAgent(id);
  }

  overview() {
    this.focus = { target: this.villageCenter(), offset: OVERVIEW_OFFSET };
  }

  private ensureIsland(repo: string) {
    let island = this.islands.get(repo);
    if (!island) {
      const i = this.islands.size;
      const col = i % COLS;
      const row = Math.floor(i / COLS);
      const pos = new THREE.Vector3((col - (COLS - 1) / 2) * SPACING, (i % 2) * 1.2, row * SPACING);
      island = new Island(repo, pos);
      this.islands.set(repo, island);
      this.scene.add(island.group);
      this.overview();
    }
    return island;
  }

  private villageCenter() {
    const box = new THREE.Box3();
    for (const island of this.islands.values()) box.expandByPoint(island.group.position);
    return this.islands.size ? box.getCenter(new THREE.Vector3()).setY(0) : new THREE.Vector3();
  }

  private removeAgent(id: string) {
    const agent = this.agents.get(id);
    if (!agent) return;
    agent.character.dispose();
    agent.island.releaseDesk(id);
    this.removeLink(agent);
    this.agents.delete(id);
  }

  private removeLink(agent: Agent) {
    if (!agent.link) return;
    agent.link.removeFromParent();
    agent.link.geometry.dispose();
    agent.link = undefined;
  }

  private focusAt(e: MouseEvent) {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
    const ray = new THREE.Raycaster();
    ray.setFromCamera(ndc, this.camera);
    const hit = ray
      .intersectObjects([...this.islands.values()].map((i) => i.group), true)
      .find((h) => findIsland(h.object));
    const island = hit && findIsland(hit.object);
    if (island) this.focus = { target: island.group.position.clone().setY(0), offset: FOCUS_OFFSET };
  }

  private frame() {
    const dt = Math.min(this.clock.getDelta(), 0.1);
    const t = this.clock.elapsedTime;

    for (const island of this.islands.values()) island.update(t);

    for (const [id, agent] of this.agents) {
      agent.character.update(dt, t);
      if (agent.character.isGone) {
        this.removeAgent(id);
        continue;
      }
      if (agent.link) {
        const parent = agent.parentId ? this.agents.get(agent.parentId) : undefined;
        if (!parent || agent.character.isFinished) {
          this.removeLink(agent);
        } else {
          const pos = agent.link.geometry.attributes.position as THREE.BufferAttribute;
          const a = parent.character.position;
          const b = agent.character.position;
          pos.setXYZ(0, a.x, 1.0, a.z);
          pos.setXYZ(1, b.x, 1.0, b.z);
          pos.needsUpdate = true;
          agent.link.computeLineDistances();
        }
      }
    }

    this.separateRoamers();

    for (const cloud of this.skyClouds) {
      cloud.position.x += dt * (cloud.userData.speed as number);
      if (cloud.position.x > 90) cloud.position.x = -90;
    }

    if (this.focus) {
      const k = 1 - Math.pow(0.02, dt);
      const desired = this.focus.target.clone().add(this.focus.offset);
      this.controls.target.lerp(this.focus.target, k);
      this.camera.position.lerp(desired, k);
      if (this.camera.position.distanceTo(desired) < 0.05) this.focus = null;
    }

    this.controls.update();
    this.labels.domElement.classList.toggle("far", this.camera.position.distanceTo(this.controls.target) > FAR_DISTANCE);
    this.renderer.render(this.scene, this.camera);
    this.labels.render(this.scene, this.camera);
  }

  /** Gently push apart roaming characters on the same island so their clouds stay readable. */
  private separateRoamers() {
    const byIsland = new Map<Island, Character[]>();
    for (const { island, character } of this.agents.values()) {
      if (!character.isRoaming) continue;
      const list = byIsland.get(island) ?? [];
      list.push(character);
      byIsland.set(island, list);
    }
    for (const list of byIsland.values()) {
      for (let i = 0; i < list.length; i++) {
        for (let j = i + 1; j < list.length; j++) {
          const a = list[i].position;
          const b = list[j].position;
          let dx = b.x - a.x;
          let dz = b.z - a.z;
          const dist = Math.hypot(dx, dz);
          if (dist >= PERSONAL_SPACE) continue;
          if (dist < 1e-3) [dx, dz] = [1, 0];
          const push = ((PERSONAL_SPACE - dist) / 2) * 0.2; // ease apart over a few frames
          const nx = dx / (dist || 1);
          const nz = dz / (dist || 1);
          list[i].nudge(-nx * push, -nz * push);
          list[j].nudge(nx * push, nz * push);
        }
      }
    }
  }

  private resize() {
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
    this.labels.setSize(w, h);
  }

  private addSkyClouds() {
    const material = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 1, transparent: true, opacity: 0.9 });
    const puff = new THREE.SphereGeometry(1, 16, 12);
    for (let i = 0; i < 10; i++) {
      const cloud = new THREE.Group();
      for (let j = 0; j < 4; j++) {
        const p = new THREE.Mesh(puff, material);
        p.position.set(j * 1.4 - 2, Math.random() * 0.6, Math.random() * 0.8);
        p.scale.setScalar(1 + Math.random() * 0.8);
        cloud.add(p);
      }
      cloud.position.set(-90 + Math.random() * 180, -14 - Math.random() * 10, -50 + Math.random() * 50);
      cloud.userData.speed = 0.6 + Math.random() * 0.8;
      this.skyClouds.push(cloud);
      this.scene.add(cloud);
    }
  }
}

/** "reading src/api/client.ts" → "reading client.ts", to keep clouds narrow (the log keeps full paths). */
function shortenPaths(text: string) {
  return text.replace(/(?:[\w.-]+\/)+([\w.-]+)/g, "$1");
}

function findIsland(obj: THREE.Object3D | null): Island | undefined {
  // Only the grass/dirt carry the island tag; props and characters are skipped.
  return obj?.userData.island as Island | undefined;
}
