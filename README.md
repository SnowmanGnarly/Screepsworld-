# Screepsworld

Autonomous Screeps AI bot (`screeps-ras-bot`) designed with Reliability, Availability, Scalability (RAS), bounded CPU/memory use, and clean modular architecture. It runs a base from RCL 1 through RCL 8: economy, creep spawning, resource logistics, construction, roads, links, defense, and flag-driven expansion.

GitHub Repository: [https://github.com/SnowmanGnarly/Screepsworld-](https://github.com/SnowmanGnarly/Screepsworld-)

The production code is plain CommonJS JavaScript in a flat, root-level module tree that runs directly inside the Screeps engine — there is no build, bundle, or transpile step.

---

## 🏛️ Architecture Overview

Each tick, `module.exports.loop` in `main.js` proceeds in this order:

1. Instantiate and prioritize all roles through `BaseManager.fetchAllRoles()`.
2. Initialize CPU tracking, persistent memory/role information, and the per-tick `MainCache`.
3. Run defense assessment and the centralized logistics manager.
4. Run base spawning and creep behavior, then towers and links.
5. If CPU allows (degraded mode off), update road heatmaps, run the Mayor planner, and draw informational/CPU visuals.

Decentralized creep roles are coordinated by centralized per-room managers. Roles are created once per tick and shared across creeps; durable state lives in Screeps `Memory`, not in role instances.

### Entry point and core modules

| File | Responsibility |
| --- | --- |
| `main.js` | Tick orchestration plus global in-game console helpers. |
| `main.cache.js` | Per-tick snapshots of rooms, spawns, creeps, flags, role/home counts, spawn reservations, and cached `room.find` results. |
| `main.util.js` | Cached global collection accessors, display names, and the persistent structure-memory adapter (`Memory.structures`). |
| `main.info.js` | Console logging and per-room visual displays. |
| `main.constants.js` | Link labels, wall/rampart repair targets, and tower reserve/repair thresholds. |

### Manager modules

| File | Responsibility |
| --- | --- |
| `manager.base.js` | Role registry, spawn priority and quotas, emergency Harvester recovery, Miner replacement, outsourced spawning, and creep dispatch. |
| `manager.memory.js` | Initializes base/spawn/role memory, removes dead-creep and stale visible-structure memory, samples `RawMemory` size. |
| `manager.logistics.js` | Persistent per-room task queue, request generation, endpoint refresh, claims, partial-delivery reconciliation, and dynamic hauler demand. |
| `logistics.runner.js` | Executes a claimed task for Storekeepers/Couriers: pickup, delivery, retry backoff, and foreign-resource recovery. |
| `manager.defense.js` | Hostile body scoring, target selection, defender requests, rate-limited notifications, and last-resort safe mode. |
| `manager.tower.js` | Executes the shared tower attack plan; otherwise heals creeps and performs emergency repairs within energy reserves. |
| `manager.mayor.js` | Validates base problems and fixes them in `auto` mode; places roads and RCL-gated structures with smart placement and layout fallbacks. |
| `manager.room.js` | Structure characters, compact room layouts, RCL slot accounting, and extension placement. |
| `manager.link.js` | Applies planned/manual link roles and transfers energy from source links to target links. |
| `manager.road.js` | Extends `TileWatcher` to accumulate sparse creep-movement heatmaps and pave tiles over the road threshold. |
| `manager.cpu.js` | Measures manager CPU usage, controls degraded mode (bucket `< 1000` on, `> 1500` off), and draws metrics. |

### Support modules

| File | Responsibility |
| --- | --- |
| `role.prototype.js` | Base class for all roles: target/source selection, commuting, movement, looting, overrides, error handling, and body generation. |
| `tile.watcher.js` | Generic periodic sparse-tile watcher; snapshots `tiles` into `lastTiles` after `watchTime`. |
| `tile.array.js` | Two-dimensional tile storage and fixed-width compact-string serialization used by room layouts. |

### Creep roles

All roles extend `RolePrototype` and are registered in `BaseManager.fetchAllRoles()`. Role names in creep memory are `Harvester`, `Defender`, `Builder`, `Upgrader`, `Handyman`, `Explorer`, `Miner`, `Storekeeper`, and `Courier`.

| File | Behavior |
| --- | --- |
| `role.harvester.js` | Early-game energy bootstrap; fills core structures and can upgrade the controller. Highest normal spawn priority. |
| `role.miner.js` | Source-assigned static mining with nearby container/storage/link delivery and timed replacement requests. |
| `role.storekeeper.js` | WORK-less, energy-only logistics worker running `LogisticsRunner` tasks. |
| `role.courier.js` | Multi-resource logistics worker; retains WORK for legacy harvesting routes. |
| `role.builder.js` | Builds construction sites, balancing distance bands against remaining progress; can fall back to upgrading. |
| `role.upgrader.js` | Dedicated controller upgrading from stored energy or eligible active sources. |
| `role.handyman.js` | Repairs roads/containers and levels walls/ramparts; can fall back to building. |
| `role.defender.js` | On-demand melee, ranged, or healing response; recycles itself when the threat ends. |
| `role.explorer.js` | Moves to an expansion flag, claims the controller, creates/builds a spawn, then becomes a local Harvester. |

---

## 🚀 Key Subsystems

### 1. General Resource Logistics (`manager.logistics.js` + `logistics.runner.js`)
Decouples resource producers (miners, containers, labs, dropped piles) from consumers (spawns, extensions, towers, labs, storage) through a persistent per-room task queue capped at 100 tasks. Tasks have stable IDs derived from room, source, target, and resource type, and kinds `supply`, `collect`, or `route`. Claims link `task.assignedCreep` with `creep.memory.taskId`/`creep.memory.logistics`, and `remaining` is reconciled from cargo changes, including partial deliveries. Storekeepers accept only energy tasks; Couriers accept any resource.

### 2. RCL-Aware Construction Planner (`manager.mayor.js` + `manager.room.js`)
Automatically manages building placement as the Room Controller Level progresses, enforcing RCL-gated unlocks and smart placement with layout fallbacks. Mayor defaults to automatic operation and supports `off`, `warn`, and `auto` modes; nuker construction and wall/rampart fortification are explicitly opt-in via `room.memory.mayor`.

### 3. Coordinated Defense (`manager.defense.js` + `manager.tower.js`)
Room-wide threat assessment replaces uncoordinated single-tower logic:
- Evaluates hostile body parts (healers, dismantlers, attackers, boosts) and proximity.
- Coordinated tower focus fire on the most dangerous penetrable enemy, via a shared tower plan.
- Dispatches defenders on demand during invasions (none maintained during peace).
- Throttles `Game.notify()` alerts to prevent inbox flooding.
- Emergency safe mode triggering as a last resort.

### 4. RAS & CPU Degradation (`manager.cpu.js`)
`manager.cpu.js` enters degraded mode when `Game.cpu.bucket < 1000` and leaves it when the bucket is `> 1500` (hysteresis). Road watching, Mayor work, and visuals are deferred in degraded mode; memory setup, defense, logistics, spawning, creep execution, towers, and links keep running.

---

## 🧪 Development & Testing

Node.js is used for local development and testing only; all dependencies are dev dependencies.

```bash
npm install
npm test            # test:unit + typecheck
npm run test:unit   # mocha "test/**/*.test.js"
npm run typecheck   # tsc --noEmit -p jsconfig.json
```

There is no compile, lint, format, watch, or upload script — the root `.js` files are the Screeps source files themselves. Run a focused suite with, for example, `npx mocha "test/logistics.regression.test.js"` or Mocha's `--grep`.

| Test file | Covers |
| --- | --- |
| `test/main.loop.test.js` | Full-loop bootstrap integration. |
| `test/logistics.regression.test.js` | Queue bounds, stable IDs, claims, partial loads, legacy routes, worker demand. |
| `test/defense.regression.test.js` | Safe mode, target validation, alerts, tower decisions, defender behavior. |
| `test/planner.regression.test.js` | RCL placement, slots, link roles, layout performance, occupied construction positions. |
| `test/reliability.regression.test.js` | CPU hysteresis, memory measurement, recovery, spawning, shared role behavior. |
| `test/syntax.test.js` | `node --check` on every root-level `.js` file. |

Tests use the local mocks in `test/helpers/screeps.js` (`resetScreeps`, `makeRoom`, `makeStructure`, `makeCreep`, `makeSpawn`, `makeStore`, `setFind`, `registerObject`); they do not connect to a Screeps server. Note that `logistics.runner.js` uses `// @ts-check` with JSDoc types — keep those annotations valid.

## 🚢 Deployment

No automated deployment process or CI exists in this repository. Deployment to a live shard is handled externally by the user's own Screeps client/sync setup; the npm commands above validate code only and do not upload anything.

---

## 📋 Roadmap

For the full phased architectural roadmap and implementation tracker, see [TODO.md](./TODO.md). Remote mining, labs, market, factory, observer/power, and offensive warfare systems are planned or backlog items — placing or hauling for those structures is not full automation.

---

## 🎮 In-Game Console Commands

Installed as globals by `main.js`:

```javascript
// Creep operations
fetchOldestCreep('Spawn1');
spawnCreepForRoom('W1N1', 'Harvester');
spawnMiner('spawnId', 'sourceId');
spawnExplorer('spawnId', 'flagName');
selfdestruct('creepName');
moveCreepTo('creepName', 'gameObjectId');

// Quotas
setCreepCount('W1N1', 'Upgrader', 3);
setMultipleCreepCounts('W1N1', ['Builder', 'Handyman'], 2);

// Links
makeLinkSource('linkId');
makeLinkTarget('linkId');

// Layout / UI
generateLayoutForRoom('W1N1');   // replaces the previous room layout
clearConsole();
```

Role names and object IDs are case-sensitive. Spawning, construction, safe mode, and recycle commands affect a live base immediately.
