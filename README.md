# Swarmer

A real-time swarm strategy game for the browser, inspired by [nohope.io](https://nohope.io) (and the older *Eufloria*). You command thousands of glowing units: harvest asteroids into new units, split and merge groups, morph them into specialised roles, switch formations, and fire off abilities to wipe out rival swarms while raider fleets hunt everyone.

**Talk to your swarm.** Press `Enter`, type an order like *"split into three, harvest the closest rocks, then hunt Ember with strikers"*, and an LLM (Cloudflare Workers AI) writes a small JavaScript program that commands your swarm live. The code runs in a sandboxed Web Worker with no DOM or network access, gets killed if it hangs, and can only issue validated game orders. Click **Show code** to read what it wrote. nohope.io pioneered the prompt-to-code idea; Swarmer's take adds the sandbox, live code view, persistent standing orders (`memory`), and four ready-made programs that work offline.

**Design constructs.** Research particle parts in the tree (`Y`): Armor Plate, Spike, Thruster, Mender, Cannon, Lance, Shield Node, Reactor. Then open the dock's **Design a construct** tab and describe what you want ("a tank: armored front, two cannons, a mender, thrusters at the back"). The LLM lays the parts out on a grid and can trade stats per cell (2x HP for 1/2 damage, and so on). Select a swarm and press **Build**: units fly into their slots and bond into a soft body that turns with inertia, and each cell fights with its own stats. Cells that get cut off from the main body break away as loose particles, and merging a swarm into a construct repairs it. Swarm programs can build constructs too (`api.build`). Reassembly (block ships under a point budget) is the closest prior art; building them out of the swarm's own particles is Swarmer's twist.

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
| LMB click / drag | Select groups (Shift adds, double-click = all on screen) |
| RMB | Context command: move, attack enemy, harvest rock, or fly over and join a friendly group |
| Wheel, MMB drag, arrows, screen edge | Zoom to cursor, pan |
| `S` / `G` / `H` | Split toward cursor / merge / hold |
| `B` / `T` / `Y` | Replicate (20+ units) / research / research panel |
| `Q` / `E` / `R` | Dash toward cursor / shield / nova |
| `Z` `X` `C` `V` | Swarm / Wedge / Ring / Line formation |
| `1`–`5` | Morph: Drone, Striker, Tank, Harvester, Artillery |
| `Tab` / `Space` / `` ` `` | Cycle groups / center camera / select all |
| `P` / `Esc` | Pause |

## Deploying (Cloudflare Pages + Workers AI)

```bash
export CLOUDFLARE_API_TOKEN=...   # token with Pages: Edit and Workers AI: Read
export CLOUDFLARE_ACCOUNT_ID=...
npx wrangler pages project create swarmer --production-branch main   # first time only
npm run deploy
```

`wrangler.toml` binds Workers AI as `AI` for `functions/api/swarm.ts`, so no key ships to players. Models are tried in order (`glm-4.7-flash`, `gpt-oss-120b`, `kimi-k2.7-code`); override with a `SWARM_MODELS` environment variable.

## Architecture

```
src/sim/      deterministic 60 Hz simulation (no DOM): world, AI, raiders, config
src/render/   WebGL2 renderer: one instanced SDF sprite shader, bloom chain, particles
src/ai/       prompt protocol, sandboxed program runner, example programs
functions/    Cloudflare Pages Function that turns prompts into programs
src/ui/       HUD and prompt dock (DOM), procedural WebAudio
src/game.ts   loop, camera, input, selection, overlay
```

- Units live in typed arrays (structure of arrays) with a counting-sort spatial hash, about 2.7 ms per tick at 6000 units.
- Growth is logistic (it slows as a team grows), so splitting into many small groups isn't an exploit.
- All balance numbers live in `src/sim/config.ts`.
