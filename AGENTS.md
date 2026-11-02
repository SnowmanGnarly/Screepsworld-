# Screepsworld Agent Guide

## Project overview

This repository contains **Screepsworld**, published in `package.json` as `screeps-ras-bot`: an autonomous AI for the game Screeps. It manages base economy, creep spawning, resource logistics, construction, roads, links, defense, and flag-driven expansion from RCL 1 through RCL 8. Reliability, availability, scalability, and bounded CPU/memory use are explicit design goals.

The production code is plain JavaScript in a flat, root-level module tree. It runs inside the Screeps engine against globals such as `Game`, `Memory`, `RoomPosition`, and Screeps constants. Node.js is used for local development and testing, not as the production server.

Use the source code as the authority for current behavior:

- `README.md` gives a high-level architecture summary and common in-game commands.
- `TODO.md` is a roadmap, not a list of completed features. Phase 2A remote outposts, Phase 2B terminal/market behavior, Phase 2C goal-driven factory chains, RCL 6 mineral harvesting, lab reactions, and opt-in spawn boosts are implemented. Deposit harvesting, observer/power, and offensive-warfare systems remain planned or backlog items.

## Technology and configuration

- **Runtime:** Screeps JavaScript runtime; CommonJS `require()` / `module.exports`; local modules only in production code.
- **Language level:** `jsconfig.json` targets ES2022 with CommonJS modules. This is an editor/type-check setting, not a transpilation step.
- **Development tools:** Mocha, Node's built-in `assert/strict`, TypeScript, `@types/screeps`, and `@types/node`.
- **Dependencies:** all npm dependencies are development dependencies. There is no bundler or runtime npm dependency support configured.

Key files:

| File | Purpose |
| --- | --- |
| `package.json` | Package metadata and the complete npm command surface: unit tests and type checking. |
| `jsconfig.json` | Includes all JavaScript except `node_modules`; enables JavaScript input but sets `checkJs: false` and `noEmit: true`. |
| `test/helpers/screeps.js` | Local Screeps globals, mocks, factories, and reset helpers. |
| `package-lock.json` | Pins the development dependencies, so `npm ci` installs the same tools locally and in CI. |
| `.github/workflows/ci.yml` | Runs `npm ci` and `npm test` on pushes to `master` and on pull requests. It validates only and uploads nothing. |
| `.gitignore` | Ignores dependencies, editor workspaces, Screeps temporary files, and logs. |

No Node or npm version is pinned by an `engines` field; CI uses Node 22.

## Install, test, and build commands

```bash
npm install
npm test
npm run test:unit
npm run test:e2e
npm run typecheck
```

- `npm test` is the full local validation: `npm run test:unit && npm run typecheck`.
- `npm run test:unit` runs `mocha "test/**/*.test.js"`, which includes the E2E stress test.
- `npm run test:e2e` runs only `test/stress.e2e.test.js` and prints how each scenario did.
- `npm run typecheck` runs `tsc --noEmit -p jsconfig.json`; it emits no production files.
- Run a focused suite with, for example, `npx mocha "test/logistics.regression.test.js"`, or select cases with Mocha's `--grep` option.

There is **no compile, bundle, lint, format, watch, upload, or deployment script**. Root JavaScript files are the Screeps source files themselves; `test/syntax.test.js` also runs `node --check` on each of them.

Although `checkJs` is disabled globally, `logistics.runner.js`, `main.scheduler.js`, `main.config.js`, and `main.constants.js` opt in with `// @ts-check` and use JSDoc types. Preserve that directive and keep their annotations valid.

## Main-loop architecture

`main.js` exports the Screeps entry point, `module.exports.loop`, which runs the `JOBS` table through `main.scheduler.js`. A job that throws is logged (at most once per 50 ticks) and the next job still runs. Each tick proceeds in this order:

1. Restore the heap copy of `Memory`, then initialize CPU tracking, persistent memory/role information, and the per-tick `MainCache`.
2. Observe intel and plan remote missions.
3. Run defense, then towers and links. These run ahead of spawning so that an economy problem can never cost us our defense.
4. Run factory production goals and lab reactions, plan terminal transfers, run opt-in market work when CPU permits, then run centralized logistics.
5. Run the spawn queue, boost preflight, post-spawn boosting, and creep behavior.
6. If deferred work is allowed, update road heatmaps, run the Mayor planner (every 10 ticks, on a tick of its own for each room), and draw informational/CPU visuals when the `visuals` setting is on.
7. Add the tick to the CPU history in `Memory.stats`, which is written every 10 ticks.

`manager.cpu.js` sets the CPU tier. It enters degraded mode when `Game.cpu.bucket < 1000` and leaves it when the bucket is `> 1500`; the separate thresholds provide hysteresis. Factories, lab reactions, terminal planning, the market, remote construction, road watching, Mayor work, and visuals are deferred in degraded mode; memory setup, intel, remote spawn planning, defense, lab boost upkeep and post-spawn boosting, logistics, mineral harvesting, other spawning, creep execution, towers, and links keep running. Below a bucket of 200 the critical tier also skips intel, remote planning, and labs. In any tier, a job that can wait is skipped once the tick has used 90% of `Game.cpu.tickLimit`, because a tick that hits the limit is thrown away whole. A paused lab goal keeps its place and its stall clock stands still, so it resumes when the bucket recovers.

### Where a value belongs

- **Game rules:** use the engine constant (`CREEP_SPAWN_TIME`, `HEAL_POWER`, `CONTROLLER_STRUCTURES`). Never restate one as a literal.
- **Values that follow from game state:** derive them in `manager.economy.js`, such as creep counts from source output and distance.
- **Energy the room may spend:** `EconomyManager.getSpendableEnergy(room)`, the one definition. Workers, labs and factories stop at `getEnergyReserve(room)`; hauling to the spawn, extensions and towers, recovery Harvesters, a controller close to downgrading, rebuilding the only spawn, and a Handyman while the room is at `DEFENDER_THREAT_LEVEL` do not.
- **Tunable policy:** a named entry in `main.config.js`. Console settings (`setSetting`) are listed there too.
- **Per-room overrides:** `room.memory`. Manual quotas raise what a room derives; `roleConfig[role].auto = false` or `base.autoDemand = false` turns derived demand off.

### Where state belongs

- **Heap copy of Memory:** `main.memhack.js` means `Memory` is not re-parsed each tick, so a value JSON cannot hold (`undefined`, `Infinity`, an object with a prototype) keeps working until the next global reset and then changes. Store only what JSON can hold. Console commands are kept, but edits from the client's Memory panel are overwritten at the end of the tick.
- **Per tick:** `MainCache`, including `MainCache.memo()` for derived values, which can be cleared and worked out again, and `MainCache.tickRecord()` for running totals, which cannot. A memo read from a room's objects passes that room, so `invalidateRoom` clears only that room's memos; a spawn clears them all.
- **Until a global reset:** `main.heap.js`, for plain data that can be rebuilt. Keep IDs, never game objects.
- **Across resets:** `Memory`, only for what cannot be rebuilt. Avoid writing to it on every tick.

### Core and manager modules

| Module | Responsibility |
| --- | --- |
| `main.js` | The job table plus global in-game administration/debugging helpers. |
| `main.scheduler.js` | Runs the job table: per-job error isolation, CPU tiers, and cadence on fixed ticks (`every` and `phase`). |
| `main.memhack.js` | Keeps the parsed `Memory` on the heap between ticks, and goes back to the stored copy after a reset or a tick that never finished. |
| `main.config.js` | Named policy values grouped by subsystem, and console settings. |
| `main.heap.js` | Bounded storage for plain data that lives until a global reset. |
| `main.move.js` | The one place creeps get move orders: a stored path per walk on the heap, stuck detection, and optional path visuals. |
| `main.mincut.js` | Finds the fewest tiles that close a protected area off from the exits. Terrain only, no game state. |
| `manager.economy.js` | Derives creep counts and body sizes from source output, route length, stored energy and open construction, decides when a room sustains itself, and works out where a Miner stands and whether a link can deliver. |
| `main.cache.js` | Per-tick snapshots of rooms, spawns, creeps, flags, role/home counts, spawn reservations, `room.find` results, and per-tick memos. |
| `main.util.js` | Cached global collection accessors, display names, and persistent structure-memory adapter. |
| `main.info.js` | Console logging and per-room visual displays; stores room names, not live room objects, in log history. |
| `main.constants.js` | Labels stored in Memory, such as link types. Tunable values are in `main.config.js`. |
| `manager.base.js` | Defines the role registry, emergency recovery, adoption of creeps from lost bases, the per-tick CPU budget, the single spawn queue (local roles above missions, energy reservation, generic pre-spawn), declarative mission spawn providers, outsourced spawning, and boost-aware creep dispatch. Roles state their own demand through `getDemand()`. |
| `manager.memory.js` | Initializes base/spawn/role and empire memory, removes dead-creep and stale visible-structure memory, drops bases lost for a whole prune interval (out of sight with no creep or spawn calling them home) and memory of spawns that no longer exist, and samples `RawMemory` size every 100 ticks. |
| `manager.intel.js` | Normalizes bounded, versioned `Memory.empire` observations; expires stale intel while preserving active offscreen missions. |
| `manager.remote.js` | Plans explicit remote missions, bounded route demand and ROI, exact spawn requests, suspension/blacklist metadata, and remote sites. |
| `manager.factory.js` | Plans bounded goal-driven factory chains, recursive component imports, battery compression, cancellation, local logistics, and energy-reserve protection. A goal with no progress for `config.FACTORY` ticks is cancelled and skipped for a while, so the next goal can run. |
| `manager.mineral.js` | Checks RCL 6+ mineral/extractor readiness, regeneration, cooldown, and storage/terminal capacity for automatic capped mining demand. |
| `manager.director.js` | The strategic layer: one Goal per room, Missions it starts, and a frozen per-room Plan of overrides on the heap. Only the goal is in Memory. **Not in the job table yet, and no manager reads its plan**, so it has no effect on the game. |
| `manager.lab.js` | Dynamically assigns source/output labs, runs the idle/select/acquire/react goal lifecycle, plans bounded reaction chains and terminal imports, and coordinates opt-in spawn boost reservations, pre-loading, and post-spawn boosting. |
| `lab.matrix.js` | Ranks what a room's labs should make next: boost demand seen at the spawn preflight, manual goals, then opt-in market profit. Reads and ranks only; `manager.lab.js` issues every order. |
| `manager.logistics.js` | Persistent per-room task queue, request generation, endpoint refresh, claims, partial-delivery reconciliation, exact lab transport, boost-reserve protection, and dynamic hauler demand. |
| `manager.terminal.js` | Bounded cross-room resource requests, owned-room balancing, reserve/fee accounting, cooldown-safe sends, and terminal stock positioning. |
| `manager.market.js` | Explicitly enabled existing-order buying/selling with price/credit/fee limits, deal caps, failure backoff, and bounded history. A sell rule without both `max` and `minSellPrice` does not sell. |
| `logistics.runner.js` | Executes a claimed task for Storekeepers and Couriers: pickup, delivery, retry backoff, and foreign-resource recovery. |
| `manager.defense.js` | Scores hostile bodies and proximity, selects a primary target, requests defenders, rate-limits notifications, and evaluates last-resort safe mode. |
| `manager.tower.js` | Executes the shared tower attack plan; otherwise heals friendly creeps or performs emergency repairs while respecting energy reserves. |
| `manager.mayor.js` | Validates base problems and, in automatic mode, fixes them; places roads, source containers, and RCL-gated structures from the stored plan, with placement rules for what the plan does not cover. |
| `manager.room.js` | Owns structure characters, compact room layouts, RCL slot accounting, and the full RCL 8 plan: a distance-transform core, a lab cluster, and extensions. Saved layouts are topped up rather than replaced. |
| `manager.link.js` | Applies planned/manual link roles and transfers energy from source links to target links. |
| `manager.road.js` | Extends `TileWatcher` to accumulate sparse creep-movement heatmaps and expose tiles over the road threshold. |
| `manager.cpu.js` | Measures manager CPU usage, controls degraded mode, and draws metrics. |
| `tile.watcher.js` | Generic periodic sparse-tile watcher; snapshots `tiles` into `lastTiles` after `watchTime`. |
| `tile.array.js` | Two-dimensional tile storage and fixed-width, row-major compact-string serialization used by room layouts and legacy road data. |

### Creep roles

All ordinary roles extend `role.prototype.js` and are registered in `BaseManager.fetchAllRoles()`. Exact role names stored in creep memory are `Harvester`, `Defender`, `Builder`, `Upgrader`, `Handyman`, `Explorer`, `Miner`, `MineralMiner`, `Storekeeper`, `Courier`, `Scout`, `Reserver`, `RemoteMiner`, and `RemoteHauler`.

| Role | Behavior |
| --- | --- |
| `role.harvester.js` | Bootstrap and recovery economy; fills core structures and can upgrade the controller, and falls back on stored energy when Miners hold every source. Not replaced once Miners and a Storekeeper run the room. Highest normal spawn priority. |
| `role.miner.js` | Source-assigned static mining: stands on the container or beside the link, harvests and unloads in one tick, and is replaced through the spawn queue using the walk it measured. |
| `role.miner.mineral.js` | Harvests an assigned RCL 6+ mineral when its built extractor, regeneration, and hub capacity permit; keeps mining across extractor cooldowns and delivers when full or once the mineral is depleted or unavailable. |
| `role.storekeeper.js` | WORK-less, energy-only logistics worker using `LogisticsRunner`. |
| `role.courier.js` | Multi-resource logistics worker; retains WORK for legacy harvesting routes. |
| `role.builder.js` | Builds construction sites, balancing distance bands against remaining progress; can fall back to upgrading. |
| `role.upgrader.js` | Dedicated controller upgrading from stored energy or eligible active sources. |
| `role.handyman.js` | Repairs roads/containers and levels walls/ramparts; can fall back to building. |
| `role.defender.js` | On-demand melee, ranged, or healing response; marks itself for recycling when the threat ends. |
| `role.explorer.js` | Moves to an expansion flag, claims the controller, creates/builds a spawn, then becomes a local Harvester. |
| `role.scout.js` | Travels by persisted coordinates, refreshes intel, and returns home. |
| `role.reserver.js` | Reserves neutral controllers and rejects hostile ownership/reservations. |
| `role.remoteMiner.js` | Mines an assigned outpost source, builds nearby sites, and delivers or drops energy. |
| `role.remoteHauler.js` | Carries remote energy to home storage/terminal and recovers foreign cargo. |

`RolePrototype` supplies target/source selection, commuting, persisted-coordinate room travel, nearby looting for rooms without haulers, manual move/recycle overrides, error handling, exact mission bodies, body generation, and shared spawn-time boost preflight. Body generation respects available energy, role multipliers, and the 50-part creep limit. Boost policies are opt-in; required policies wait for a fully stocked lab plan and pre-load it from the hub through the logistics queue, optional policies spawn unboosted, and emergency Harvester recovery bypasses boost requirements. Roles commonly override `isNecessary()`, `spawnCreep()`, `_findTargets()`, `_findSources()`, and `_work()`.

Role instances are created once per global reset and shared across creeps and ticks. Do not add per-creep or per-tick state to role instance fields beyond what `run()` resets; pass per-call data through the `options` object, as spawning does. Durable state belongs in Screeps `Memory`.

## Persistent state and invariants

### Base identity and memory

A base is a logical construct keyed by `room.memory.base.name`, not simply every object physically in one room. Spawns and creeps use `memory.home` to identify their base; creeps also use `memory.role`. `outsourceSpawn` permits a base to use another eligible free spawn.

Important persistent locations include:

- `room.memory.base.roleConfig`: quotas, an optional `partsMaxMultiplier` limit over derived body sizes, source policy, and display options. The Mayor no longer writes quotas into automatic rooms; `quotaVersion` and `bodyVersion` mark the one-time removal of the old stored defaults.
- `room.memory.logistics`: task queue, queue version, overflow count, and optional stock policy.
- `room.memory.defense`, `room.memory.mayor`, `room.memory.roomManager`, `room.memory.roadManager`, `room.memory.console`, and `room.memory.cpu`.
- `Memory.structures`: persistent structure metadata with `_roomName`.
- `Memory.empire`: versioned bounded `intel`, `missions`, `squads`, `resourceRequests`, and reserved `alliances` maps; records contain primitives only. Remote missions are configured by `room.memory.base.remoteRooms` or `Remote...` flags. Cross-room resource requests use `TerminalManager.requestResource()` / `requestTransfer()`.

Use `MainUtil.fetchMemoryOfStructure()` for persistent structure settings such as link roles and lab/factory resource metadata. It connects the structure to `Memory.structures` and supports later cleanup. Be conservative when changing memory shapes: normalize older data and preserve standing work rather than deleting it wholesale.

### Cache discipline

`MainCache` resets by `Game.time`. `MainCache.find(room, findType, options)` caches the unfiltered result by room and find type, then applies `options.filter` to the cached values. When a mutation changes membership of a cached result, follow the existing invalidation patterns, such as after construction-site creation or resource pickup. Spawning goes through `MainCache.recordSpawn()` to reserve the spawn and update counts.

Do not retain `Game` objects or cached arrays as cross-tick state. Avoid accidentally sorting or otherwise mutating a shared cached result when a local copy is needed.

### Logistics contracts

Tasks have stable IDs derived from room, source, target, and resource type, and kinds `supply`, `collect`, or `route`. The queue is capped at 100 tasks. Claims connect `task.assignedCreep` with `creep.memory.taskId` and `creep.memory.logistics`; `remaining` is reconciled from cargo changes, including partial deliveries.

Storekeepers accept only energy tasks; Couriers accept any resource. A hauler loads for every waiting energy delivery rather than one target per trip, except lab and factory energy, which stay exact to respect the emergency reserve. Source containers belong to the haulers: workers skip them while anything else in the room holds `ECONOMY.WORKER_STORE_MIN` energy. Preserve offscreen/standing-task behavior, retry backoff, and stable IDs when editing this subsystem. The legacy `room.memory.source` / `room.memory.target` route is imported as a standing oxygen route. Terminal-generated storage positioning uses `room.memory.logistics.terminalStockPolicy`; manual `stockPolicy` rules take precedence and standing tasks must not be replaced.

### Construction and defense safeguards

Mayor defaults to automatic operation but supports `off`, `warn`, and `auto` modes. With `enableFortification` on, RCL 4 or higher, and a healthy bucket, the room plans one minimum-cut rampart line around its buildings (`roomManager.rampartPlanVersion`) and builds it after everything else. Nuker construction and wall/rampart fortification are explicitly opt-in through `room.memory.mayor`. Layout generation overwrites the existing editable layout. A saved layout follows what stands: buildings and sites claim their tiles, and unbuilt tiles over the RCL 8 limit, or a terminal or factory planned away from every storage, are planned again. A power spawn and observer are only built with `enablePowerSpawn` and `enableObserver`, because no code uses them yet.

Defense and towers share `DefenseManager.getPriorityTarget()` / `getTowerPlan()`. Keep target selection, healing estimates, per-room notification throttling, tower energy reserves, and safe-mode vulnerability checks coordinated rather than reimplementing them independently.

## Code style and change conventions

- Match the surrounding file. The codebase mixes older tab-indented/`var` modules with newer four-space/`const` code; there is no configured formatter or linter to impose a new style.
- Keep the existing flat naming scheme: `manager.<name>.js`, `role.<name>.js`, and root-level support modules. Use extensionless local CommonJS imports as the current files do.
- Managers commonly expose static `runAll()` methods and create per-room instances. Add new roles through `BaseManager.fetchAllRoles()` rather than creating a parallel dispatch path.
- Follow existing Screeps result-code handling (`OK`, `ERR_NOT_IN_RANGE`, and related constants) and debug logging. Exception boundaries report through `MainInfo.failure()`, which limits how often one problem logs and emails and never throws itself. Send any other email through `MainInfo.sendEmail()`, never `Game.notify` directly: the game drops calls past 20 in a tick, and the rest wait for the next tick.
- Use `MainCache`/`MainUtil` collection helpers where their per-tick behavior is intended, and keep CPU/memory bounds in mind for room-wide scans and serialized data.
- Do not add production imports from `node_modules` without also establishing how those modules would reach the Screeps runtime; no bundling mechanism currently exists.
- Update comments, `README.md`, or `TODO.md` when a change makes their behavior or implementation status stale. Do not mark roadmap items implemented merely because a structure can be placed or hauled.

## Testing strategy

Tests are local Mocha tests using Node assertions; they do not connect to a Screeps server or run a real game simulation.

- `test/main.loop.test.js`: full-loop bootstrap integration plus multi-tick scenarios for CPU deferral, creep replacement, the logistics task lifecycle, and invasion response. Its `nextTick()` helper finishes spawning and completes requested moves instantly between ticks.
- `test/logistics.regression.test.js`: queue bounds, stable IDs, claims, partial loads, legacy routes, and worker demand.
- `test/defense.regression.test.js`: safe mode, target validation, alerts, tower decisions, and defender behavior.
- `test/planner.regression.test.js`: RCL placement, slots, link roles, layout performance, and occupied construction positions.
- `test/reliability.regression.test.js`: CPU hysteresis, memory measurement, recovery, spawning, and shared role behavior.
- `test/remote.regression.test.js`: empire bounds, remote configuration, reservation, travel, economy, ROI, construction, defense, and mission spawning.
- `test/economy.regression.test.js`: resource requests, terminal reserves/fees/cooldowns, balancing, logistics policies, market orders, credits, deal caps, and retries.
- `test/factory.regression.test.js`: recursive production goals, component requests, factory logistics, cancellation, reserve protection, and multi-room chains.
- `test/mineral.regression.test.js`: extractor/mineral readiness, automatic spawning, harvesting, capacity, and delivery.
- `test/lab.regression.test.js`: dynamic lab topology, recursive reactions, imports, cooldowns, exact logistics, reassignment, and reserves.
- `test/boost.regression.test.js`: boost preflight, resource costs, reservations, multi-lab movement, cleanup, emergency bypass, and outsourced spawning.
- `test/matrix.regression.test.js`: the goal lifecycle, stall backoff, boost demand, batch shrinking, profit ranking, and the per-tick cost of the topology search and metadata writes.
- `test/preload.regression.test.js`: the pre-load queue, lab designation, hauler tasks, the spawn unblock, release, and the whole path with a real Courier.
- `test/pipeline.regression.test.js`: hauler load sizes, onward delivery, exact lab energy, and workers leaving source containers to the haulers.
- `test/hardening.regression.test.js`: healing estimates, recovery reserve, layout top-up, job isolation and tiers, CPU history, heap and Memory rules, movement, work claims, and the base planner.
- `test/demand.regression.test.js`: derived demand, the spawn queue, energy reservation, pre-spawn, and a new room reaching RCL 4 with no console commands.
- `test/lifetime.regression.test.js`: runs a growing room with every game object rebuilt between ticks, so anything kept across ticks throws.
- `test/movement.regression.test.js`: the heap path cache, its fallbacks, and stuck handling.
- `test/assignment.regression.test.js`: Harvesters only during bootstrap, looting through the queue, and derived bodies.
- `test/mincut.regression.test.js`: the minimum cut itself, checked by walking out of the result, and rampart planning.
- `test/energy.regression.test.js`: which links can deliver, Harvester fallback, spending what is mined, and Miners at their post.
- `test/loop.regression.test.js`: the heap copy of Memory against the engine's tick sequence, error boundaries and their reporting, the per-tick CPU budget, paused lab goals, and staggering.
- `test/stress.e2e.test.js`: W1N1 through the real main loop for 2000 ticks on `test/helpers/simulator.js`, with the factory crashing at tick 500 and a global reset at 1200: economy, CPU, an exact energy balance, and a bucket held low. Run it alone with `npm run test:e2e`.
- `test/director.regression.test.js`: goal triggers and their hysteresis, the defense check in every CPU tier, mission lifecycles, plan merging, and what survives a reset.
- `test/reserve.regression.test.js`: the energy reserve: who stops at it, who does not, what workers leave to the haulers, creep demand, and the one definition shared with the terminal and Director.
- `test/recovery.regression.test.js`: destroyed sources, stale hauler claims, outsourced spawning, lost bases, the per-tick CPU budget, emails, and remote accounting.
- `test/priority.regression.test.js`: threat scoring, tower reserves, task order, spawn timing and placement limits.
- `test/liveroom.regression.test.js`: the real managers on a snapshot of the live room (`test/fixtures/W13S14.json`, loaded by `test/helpers/liveroom.js`): Miner posts against where the live Miners stand, derived demand, the layout on real terrain, ramparts, logistics, and Memory pruning. Refresh the snapshot with `SCREEPS_TOKEN=<token> node test/fixtures/fetch-live-room.js`; never commit a token.
- `test/syntax.test.js`: syntax-checks every root-level `.js` file.

Use `test/helpers/screeps.js` for new tests. For multi-tick tests, call `rebuildGameObjects()` between ticks and fetch objects from `Game` again afterwards; it does what the engine does, and old instances throw when read. Call `resetScreeps()` before each case, normally in `beforeEach`, to install globals and reset `Game`, `Memory`, and `MainCache`. Build rooms/objects with `makeRoom`, `makeStructure`, `makeCreep`, `makeSpawn`, `makeStore`, and `makeLab`; populate `room.find` results with `setFind`; and call `registerObject` for anything that must be reachable through `Game.getObjectById`. The helper loads the engine's real constants from `test/helpers/engine-constants.js`, so tests cannot agree with a wrong idea of the game. The mocks still apply actions at once instead of at the end of the tick, have flat terrain, and never move creeps on their own. `test/helpers/simulator.js` builds on them for long runs: walking under fatigue, spawning and dying, source regeneration, and the engine's lazy `Memory`. Its header lists what it leaves out; its CPU figures show trends and cannot stand in for a live shard.

The mocks implement only the Screeps behavior currently needed by the suite. Extend them deliberately when testing a new API, and clean up any additional global state a test installs. For behavior fixes, add a regression test that exercises the real manager/role method, not just an import or syntax check. Finish with `npm test`.

## Deployment and in-game operation

No automated deployment process is present in this repository. The npm commands and CI validate code only; they do not upload it. Deployment is handled outside the repository by the user's Screeps script/client setup, so do not invent an upload command or assume that running tests changed a live shard. Live verification requires the external Screeps environment.

`main.js` installs global helpers for the in-game console:

- Creep operations: `fetchOldestCreep`, `spawnCreepForRoom`, `spawnMiner`, `spawnExplorer`, `selfdestruct`, and `moveCreepTo`.
- Quotas: `setCreepCount` and `setMultipleCreepCounts`. These set a floor over the demand the room derives.
- Settings and CPU: `setSetting` (`visuals`, `pathVisuals`, `creepIcons`), `cpuReport`, and `version`.
- Links: `makeLinkSource` and `makeLinkTarget`.
- Layout/UI: `generateLayoutForRoom` and `clearConsole`.

Role names and object IDs are case-sensitive/value-sensitive inputs. `generateLayoutForRoom` replaces the previous room layout, and spawning, construction, safe mode, and recycle commands can affect a live base immediately.

## Security and operational safety

- No credentials, API tokens, or deployment secrets are part of the source or npm configuration. Keep such values out of the repository and logs.
- Treat changes to memory cleanup, task claims, spawning recovery, construction, tower targeting, and safe mode as live-game operational changes, not merely utility refactors.
- Preserve bounded queues, sparse road data, CPU deferral, notification rate limits, and opt-in destructive/expensive behavior. Avoid unbounded growth in `Memory` and avoid retaining live game objects in serialized state.
- The local tests cannot prove live-shard compatibility or performance. State that limitation when those properties matter, and leave live deployment/verification to the configured external workflow.
