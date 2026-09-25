import "./style.css";
import { World } from "./world";
import { Hud } from "./hud";
import { connect } from "./socket";

const world = new World(document.getElementById("app")!);
const hud = new Hud();

const wsUrl = import.meta.env.VITE_WS_URL ?? `ws://${location.hostname}:8787`;

const send = connect(wsUrl, {
  onOpen: () => world.clearAgents(), // the server replays live agents on connect
  onStatus: (s) => hud.setStatus(s),
  onEvent: (e) => {
    world.handle(e);
    hud.log(e);
  },
});

hud.onSpawn(() => send({ type: "mock.trigger" }));
hud.onOverview(() => world.overview());
world.start();

// Handy for poking at the scene from the devtools console.
if (import.meta.env.DEV) Object.assign(window, { village: world });
