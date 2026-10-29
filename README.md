# Screepsworld

Autonomous Screeps AI bot (`screeps-ras-bot`) designed with Reliability, Availability, Scalability (RAS), bounded CPU/memory use, and clean modular architecture. It runs a base from RCL 1 through RCL 8: economy, creep spawning, resource logistics, construction, roads, links, defense, and flag-driven expansion.

GitHub Repository: [https://github.com/SnowmanGnarly/Screepsworld-](https://github.com/SnowmanGnarly/Screepsworld-)

The production code is plain CommonJS JavaScript in a flat, root-level module tree that runs directly inside the Screeps engine — there is no build, bundle, or transpile step.

---

## 🏛️ Architecture Overview

Each tick, `module.exports.loop` in `main.js` runs a table of jobs through `main.scheduler.js`. A job that throws is logged and the next job still runs. The order is:

1. Initialize CPU tracking, persistent memory/role information, and the per-tick `MainCache`.
2. Observe intel and plan remote missions.
3. Run defense, then towers and links, ahead of spawning.
4. Run factory production goals and lab reactions, plan terminal transfers, run opt-in market work when CPU permits, and then run centralized logistics.
5. Run the spawn queue, boost preflight, post-spawn boosting, and creep behavior.
6. If CPU allows (degraded mode off), update road heatmaps, run the Mayor planner every 10 ticks, and draw informational/CPU visuals.
7. Add the tick to the CPU history in `Memory.stats`.

Decentralized creep roles are coordinated by centralized per-room managers. Roles are created once per global reset and shared across creeps; durable state lives in Screeps `Memory`, not in role instances.

Creep counts are derived from the room: Miners from sources with a container or link, Storekeepers from output and route length, Upgraders from stored surplus, and Builders from remaining construction. `setCreepCount` still works and sets a floor. Use `roleConfig[role].auto = false` or `base.autoDemand = false` to turn derived demand off.

### Entry point and core modules

| File | Responsibility |
| --- | --- |
| `main.js` | The job table plus global in-game console helpers. |
| `main.scheduler.js` | Runs the job table: per-job error isolation, CPU tiers, and cadence. |
| `main.config.js` | Named policy values grouped by subsystem, and console settings. |
| `main.heap.js` | Bounded storage for plain data that lives until a global reset. |
| `main.move.js` | The one place creeps get move orders: path reuse, stuck detection, and optional path visuals. |
| `main.cache.js` | Per-tick snapshots of rooms, spawns, creeps, flags, role/home counts, spawn reservations, and cached `room.find` results. |
| `main.util.js` | Cached global collection accessors, display names, and the persistent structure-memory adapter (`Memory.structures`). |
| `main.info.js` | Console logging and per-room visual displays. |
| `main.constants.js` | Link labels, wall/rampart repair targets, and tower reserve/repair thresholds. |

### Manager modules

| File | Responsibility |
| --- | --- |
| `manager.base.js` | Role registry, recovery, Miner replacement, the single spawn queue (local roles above missions, energy reservation, generic pre-spawn), declarative mission spawn providers, outsourced spawning, and boost-aware dispatch. |
| `manager.economy.js` | Derives creep counts from source output, route length, stored energy, and open construction. |
| `manager.memory.js` | Initializes base/spawn/role and empire memory, removes dead-creep and stale visible-structure memory, samples `RawMemory` size. |
| `manager.intel.js` | Bounded, versioned `Memory.empire` with normalized intel, missions, squads, and reserved alliance storage. |
| `manager.remote.js` | Explicit outpost configuration, route demand/ROI, suspension/blacklist metadata, mission spawning, and capped construction. |
| `manager.factory.js` | Goal-driven factory chains with recursive component imports, battery compression, cancellation, local logistics, and energy-reserve protection. |
| `manager.mineral.js` | RCL 6+ extractor, mineral regeneration, cooldown, and storage/terminal capacity checks for automatic mining demand. |
| `manager.lab.js` | Dynamic lab assignments, ordered reaction chains, component imports, exact transport metadata, and opt-in spawn boost requests. |
| `manager.logistics.js` | Persistent per-room task queue, request generation, endpoint refresh, claims, partial-delivery reconciliation, exact lab transport, and dynamic hauler demand. |
| `manager.terminal.js` | Reusable resource requests, owned-room balancing, reserve/fee accounting, cooldown-safe sends, and terminal positioning. |
| `manager.market.js` | Opt-in existing-order trades with price/credit/fee limits, deal caps, failure backoff, and bounded history. |
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

All roles extend `RolePrototype` and are registered in `BaseManager.fetchAllRoles()`. Role names in creep memory are `Harvester`, `Defender`, `Builder`, `Upgrader`, `Handyman`, `Explorer`, `Miner`, `MineralMiner`, `Storekeeper`, `Courier`, `Scout`, `Reserver`, `RemoteMiner`, and `RemoteHauler`.

| File | Behavior |
| --- | --- |
| `role.harvester.js` | Early-game energy bootstrap; fills core structures and can upgrade the controller. Highest normal spawn priority. |
| `role.miner.js` | Source-assigned static mining with nearby container/storage/link delivery and timed replacement requests. |
| `role.miner.mineral.js` | Automatically dispatched RCL 6+ mineral harvesting with extractor/regeneration/capacity checks and storage/terminal delivery. |
| `role.storekeeper.js` | WORK-less, energy-only logistics worker running `LogisticsRunner` tasks. |
| `role.courier.js` | Multi-resource logistics worker; retains WORK for legacy harvesting routes. |
| `role.builder.js` | Builds construction sites, balancing distance bands against remaining progress; can fall back to upgrading. |
| `role.upgrader.js` | Dedicated controller upgrading from stored energy or eligible active sources. |
| `role.handyman.js` | Repairs roads/containers and levels walls/ramparts; can fall back to building. |
| `role.defender.js` | On-demand melee, ranged, or healing response; recycles itself when the threat ends. |
| `role.explorer.js` | Moves to an expansion flag, claims the controller, creates/builds a spawn, then becomes a local Harvester. |
| `role.scout.js` | Refreshes outpost intel using persisted-coordinate travel. |
| `role.reserver.js` | Reserves neutral controllers and rejects hostile ownership/reservations. |
| `role.remoteMiner.js` | Mines, builds nearby outpost sites, and delivers or drops energy. |
| `role.remoteHauler.js` | Returns remote energy to home storage/terminal and recovers foreign cargo. |

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

### 4. Phase 2A Remote Outposts (`manager.intel.js` + `manager.remote.js`)
Remote operations are opt-in through `room.memory.base.remoteRooms` (room names or configuration objects) or `Remote`, `Remote:<target>`, and `Remote:<home>:<target>` flags. Distance defaults to one room. Missions use bounded intel, exact-body spawn requests, source/output-based hauling demand, ROI and suspension metadata, neutral container/road sites, and defensive outpost response without safe mode.

### 5. Phase 2B Terminal & Market (`manager.terminal.js` + `manager.market.js`)
Owned terminals balance per-resource stock with hysteresis, deterministic batches, emergency reserves, exact transaction-fee accounting, and cooldown checks. Later managers can call `TerminalManager.requestResource(homeRoomOrBase, resourceType, amount, options)` or `requestTransfer()` with a target, priority, reason, and expiry; requests live in bounded `Memory.empire.resourceRequests`. Local storage/terminal movement uses existing logistics tasks, with manual stock rules taking precedence.

Market trading is disabled by default and uses existing orders only. Enable it explicitly per room and resource, for example:

```javascript
room.memory.market = {
    enabled: true,
    sell: true,
    resources: {
        energy: { sell: true, min: 20000, target: 50000, max: 100000, minSellPrice: 1.5 }
    }
};
```

Buy/sell thresholds, batch/cooldown/deal limits, price/credit limits, fee profitability, failure backoff, and bounded history are enforced. Public order creation is not implemented.

### 6. Phase 2C Goal-Driven Factories (`manager.factory.js`)
Factories implement recursive production goals, request missing components through terminal resource requests, move inputs and outputs through centralized logistics, compress energy into batteries, support explicit cancellation, and protect emergency energy reserves. Factory planning and production intentionally continue in degraded CPU mode.

Factories have no work by default: `goals` is empty and `batteryTarget` is `0`. Configure target stocks and/or a battery target explicitly per room:

```javascript
room.memory.factory = {
    enabled: true,
    goals: { composite: 5000, oxidant: 1000 },
    batteryTarget: 10000,
    batchSize: 1000
};
```

### 7. Mineral, Lab Reactions & Spawn Boosts (`manager.mineral.js` + `manager.lab.js`)
At RCL 6+, a built extractor on a regenerated mineral supports one automatically dispatched `MineralMiner` by default when storage or terminal has free capacity. Set `room.memory.base.roleConfig.MineralMiner.maxNumber` to `0` to disable automatic demand; explicit quotas remain supported.

Labs dynamically choose two source labs and all output labs within range 2 of both. Goal-driven planning derives ordered base/T1/T2/T3 reactions from `REACTIONS`, uses storage/terminal/lab inventory and strategic reserves, imports missing components, and generates exact logistics tasks. Reaction goals and boost policies are empty by default:

```javascript
room.memory.lab = {
    enabled: true,
    goals: { utrium_alkalide: 1000, catalyzed_utrium_alkalide: 500 },
    reserves: { utrium: 200, oxygen: 200 },
    boosts: {
        Upgrader: { work: 'catalyzed_ghodium_acid', required: false },
        Defender: { attack: 'catalyzed_utrium_acid', work: 'catalyzed_zynthium_alkalide', required: false }
    }
};
```

Boost policies are opt-in and all-or-unboosted per spawn. Required policies wait for sufficient stocked lab compounds and energy; optional policies spawn unboosted when unavailable. Emergency Harvester recovery bypasses boosts. To keep a boost lab stocked, set `inputResourceType` (and optionally `targetAmount`, default 1000) in its structure memory via `MainUtil.fetchMemoryOfStructure(lab)`; logistics keeps it filled, boosting never clears that setting or drains the lab, and such labs are excluded from reaction assignments and reaction stock counts. After spawning, creeps move to their reserved labs and finish boosting before ordinary role work. Mineral harvesting, lab reactions, and boost processing continue in degraded CPU mode.

### 8. RAS & CPU Degradation (`manager.cpu.js`)
`manager.cpu.js` enters degraded mode when `Game.cpu.bucket < 1000` and leaves it when the bucket is `> 1500` (hysteresis). Remote construction, market order scanning, road watching, Mayor work, and visuals are deferred in degraded mode; memory setup, intel, remote spawn planning, defense, factory production, lab reactions and boost processing, terminal planning, logistics, mineral harvesting, other spawning, creep execution, towers, and links keep running. Below a bucket of 200 the critical tier also skips intel, remote planning, factories, labs, terminal, and market. `main.scheduler.js` isolates every job, and `cpuReport()` prints the CPU history kept in `Memory.stats`.

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
| `test/main.loop.test.js` | Full-loop bootstrap integration and multi-tick scenarios: CPU deferral, creep replacement, logistics task lifecycle, and invasion response. |
| `test/logistics.regression.test.js` | Queue bounds, stable IDs, claims, partial loads, legacy routes, worker demand. |
| `test/defense.regression.test.js` | Safe mode, target validation, alerts, tower decisions, defender behavior. |
| `test/planner.regression.test.js` | RCL placement, slots, link roles, layout performance, occupied construction positions. |
| `test/reliability.regression.test.js` | CPU hysteresis, memory measurement, recovery, spawning, shared role behavior. |
| `test/remote.regression.test.js` | Empire bounds, reservation, remote economy, demand/ROI, construction, defense, and mission spawning. |
| `test/economy.regression.test.js` | Requests, terminal reserves/fees, balancing, stock policies, market orders, limits, and retries. |
| `test/factory.regression.test.js` | Recursive factory goals, component requests, logistics, cancellation, reserve protection, and multi-room chains. |
| `test/mineral.regression.test.js` | Extractor/mineral readiness, automatic spawning, correct mineral harvesting, capacity, and delivery. |
| `test/lab.regression.test.js` | Lab topology, recursive reactions, terminal imports, cooldowns, exact logistics, reassignment, and reserves. |
| `test/boost.regression.test.js` | Boost preflight, costs, reservations, multi-lab movement, cleanup, emergency bypass, and outsourced spawning. |
| `test/hardening.regression.test.js` | Healing estimates, recovery reserve, layout top-up, job isolation and tiers, CPU history, heap and Memory rules, movement, work claims, and the base planner. |
| `test/demand.regression.test.js` | Derived demand, the spawn queue, energy reservation, pre-spawn, and a new room reaching RCL 4 with no console commands. |
| `test/syntax.test.js` | `node --check` on every root-level `.js` file. |

Tests use the local mocks in `test/helpers/screeps.js` (`resetScreeps`, `makeRoom`, `makeStructure`, `makeCreep`, `makeSpawn`, `makeStore`, `makeLab`, `setFind`, `registerObject`); they do not connect to a Screeps server. Note that `logistics.runner.js` uses `// @ts-check` with JSDoc types — keep those annotations valid.

## 🚢 Deployment

No automated deployment process or CI exists in this repository. Deployment to a live shard is handled externally by the user's own Screeps client/sync setup; the npm commands above validate code only and do not upload anything.

---

## 📋 Roadmap

For the full phased architectural roadmap and implementation tracker, see [TODO.md](./TODO.md). Phase 2A remote outposts, Phase 2B terminal/market behavior, Phase 2C goal-driven factory chains, mineral harvesting, lab reactions, and opt-in spawn boosts are implemented. Deposit harvesting, observer/power, and offensive warfare systems remain planned or backlog items.

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

// Settings / CPU
setSetting('visuals', false);    // also: pathVisuals, creepIcons
cpuReport();                     // average CPU, bucket trend, most expensive jobs
```

Role names and object IDs are case-sensitive. Spawning, construction, safe mode, and recycle commands affect a live base immediately.
