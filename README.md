# Swarmer

A multiplayer real-time swarm strategy game for the browser, inspired by [nohope.io](https://nohope.io) (and the older *Eufloria*). Play at **https://swarm.lein-enterprises.lol**.

**One endless arena.** Like nohope.io, there are no matches: everyone drops into the same persistent map, fights, and leaves whenever. Up to 8 swarms share it; bots keep at least 5 alive so it never goes quiet, and a player who joins a full map replaces the smallest bot. Asteroids regrow, raids stop escalating after wave 8, and if you get wiped out you redeploy somewhere quiet. When you leave, your swarm fights on as a bot. The arena is saved every 30 seconds and resumes where it left off when the next pilot arrives.

**Talk to your swarm.** Press `Enter`, type an order like *"split into three, harvest the closest rocks, then hunt Ember with strikers"*, and an LLM (Cloudflare Workers AI) writes a small JavaScript program that commands your swarm live. The code runs in a sandboxed Web Worker with no DOM or network access, gets killed if it hangs, and can only issue validated game orders. Click **Show code** to read what it wrote. nohope.io pioneered the prompt-to-code idea; Swarmer's take adds the sandbox, live code view, persistent standing orders (`memory`), and four ready-made programs that work offline.

**Research unlocks particle types only.** Morphing a swarm into a Striker, Tank, Harvester or Artillery is always available; the research tree (`Y`) holds only construct particles. **Design constructs.** Research particle parts: Armor Plate, Spike, Thruster, Mender, Cannon, Lance, Shield Node, Reactor. Then open the dock's **Design a construct** tab and describe what you want ("a tank: armored front, two cannons, a mender, thrusters at the back"). The LLM lays the parts out on a grid and can trade stats per cell (2x HP for 1/2 damage, and so on). Select a swarm and press **Build**: units fly into their slots and bond into a soft body that turns with inertia, and each cell fights with its own stats. Cells that get cut off from the main body break away as loose particles, and merging a swarm into a construct repairs it. Swarm programs can build constructs too (`api.build`). Reassembly (block ships under a point budget) is the closest prior art; building them out of the swarm's own particles is Swarmer's twist.

```bash
npm install
npm run dev      # http://localhost:5173
npm test         # simulation tests
npm run build    # static build in dist/
```

Requires a browser with WebGL2 (any recent Chrome, Edge, Firefox or Safari). Desktop, mouse and keyboard.

## What's different from nohope.io

| | nohope.io | Swarmer |
|---|---|---|
| Movement | particles drift to a click target | **shape-field formations**: each unit projects itself into its formation's shape and steers there, with separation, momentum and a velocity streak. Formation changes animate themselves and nobody shuffles when units die. Long trips build cruise speed. |
| Fighting | swarms trade damage | **counter triangle** (Striker > Artillery > Tank > Striker, Drones as generalists), **4 formations** with real trade-offs, **3 abilities** (Dash ram, Hex Shield, Nova self-detonation), artillery shells with splash, knockback |
| Feedback | | bloom, tracers, death sparks, shockwaves, screen shake, hit-stop on big kills, chromatic aberration, procedural sound |
| Opponents | ships + arena | up to 3 AI rival swarms that harvest, replicate, research, split, retreat, morph and launch armies, plus escalating raider waves (Scout, Bomber, Bulwark, Siege) that leave rich wrecks |
| Onboarding | | 8-step contextual tutorial, tooltips on every command, live AI battle behind the menu |

## Controls

| Input | Action |
|---|---|
| LMB click | Move / attack / harvest with the selection; click your own swarm to select it |
| LMB drag | Box select (Shift adds, double-click = all on screen) |
| RMB on your swarm | Order menu: replicate, research, split, merge, hold, morph, formation, abilities, fabricate, research tree |
| RMB elsewhere | Move, attack enemy, harvest rock; drag to draw a route, Shift queues waypoints |
| Wheel, MMB drag, arrows, screen edge | Zoom to cursor, pan |
| `S` / `G` / `H` | Split toward cursor / merge / hold |
| `B` / `T` / `Y` | Replicate (20+ units) / research / research panel |
| `Q` / `E` / `R` | Dash toward cursor / shield / nova |
| `Z` `X` `C` `V` | Swarm / Wedge / Ring / Line formation |
| `1`–`5` | Morph: Drone, Striker, Tank, Harvester, Artillery (always available) |
| `Tab` / `Space` / `` ` `` | Cycle groups / center camera / select all |
| `Esc` | Menu (the arena keeps running) · `Space` redeploys after a wipe |

## How multiplayer works

Deterministic lockstep. Every client runs the same 60 Hz simulation; one Durable Object (`worker/arena.ts`) only relays orders. Ten times a second it broadcasts a numbered *turn* with every order received since the last one, tagged with the sender's player id; the simulation maps player ids to swarms, so nobody can order someone else's. Everything a player does, including mouse orders, research, blueprints from the AI designer and the output of LLM-written programs, goes through this path. The simulation avoids engine-specific floating point (`Math.hypot` is replaced with `sqrt`, which IEEE 754 defines exactly).

Joining a running arena: the oldest connected client (the host) sends a gzipped snapshot (`World.serialize`); the newcomer loads it, replays the turns since, and a `join` order gives them a swarm. The host also uploads a snapshot every 30 seconds, which the Durable Object stores; the first pilot into an empty arena resumes from it. Every 2 seconds each client reports a state hash; on a mismatch the host's snapshot repairs the others. A newer build arriving makes older clients reload, so everyone always runs the same simulation.

Bandwidth is tiny (orders only), so thousands of units cost nothing on the wire. The price is input latency of about one round trip plus up to 100 ms.

## Deploying (Cloudflare Worker + Workers AI + Durable Objects)

`npm run deploy` publishes a Worker that serves `dist/`, the AI endpoints and the arena Durable Object (`wrangler.worker.toml`). Multiplayer needs the Worker; the Pages target (`npm run deploy:pages`) only serves the AI endpoints.

```bash
export CLOUDFLARE_API_TOKEN=...   # token with Pages: Edit and Workers AI: Read
export CLOUDFLARE_ACCOUNT_ID=...
npx wrangler pages project create swarmer --production-branch main   # first time only
npm run deploy
```

`wrangler.toml` binds Workers AI as `AI` for `functions/api/swarm.ts`, so no key ships to players. Models are tried in order (orders: `llama-4-scout-17b-16e-instruct`, then `gpt-oss-120b`; designs: the reverse); override with a `SWARM_MODELS` environment variable.

## Architecture

```
src/sim/      deterministic 60 Hz simulation (no DOM): world, AI, raiders, config, snapshots
src/net/      lockstep link: arena connection, turn buffer, hash checks, resync
worker/       Cloudflare Worker: static assets, AI endpoints, the Arena Durable Object
src/render/   WebGL2 renderer: one instanced SDF sprite shader, bloom chain, particles
src/ai/       prompt protocol, sandboxed program runner, example programs
functions/    Cloudflare Pages Function that turns prompts into programs
src/ui/       HUD, right-click order menu, prompt dock (DOM), procedural WebAudio
src/game.ts   loop, camera, input, selection, overlay
```

- Units live in typed arrays (structure of arrays) with a counting-sort spatial hash, about 2.7 ms per tick at 6000 units.
- Growth is logistic (it slows as a team grows), so splitting into many small groups isn't an exploit.
- All balance numbers live in `src/sim/config.ts`.
