# Screepsworld Agent Guide

## Project overview

This repository contains **Screepsworld**, published in `package.json` as `screeps-ras-bot`: an autonomous AI for the game Screeps. It manages base economy, creep spawning, resource logistics, construction, roads, links, defense, and flag-driven expansion from RCL 1 through RCL 8. Reliability, availability, scalability, and bounded CPU/memory use are explicit design goals.

The production code is plain JavaScript in a flat, root-level module tree. It runs inside the Screeps engine against globals such as `Game`, `Memory`, `RoomPosition`, and Screeps constants. Node.js is used for local development and testing, not as the production server.

Use the source code as the authority for current behavior:

- `README.md` gives a high-level architecture summary and common in-game commands.
- `TODO.md` is a roadmap, not a list of completed features. Phase 2A remote outposts, Phase 2B terminal/market behavior, and Phase 2C goal-driven factory chains are implemented. Lab-reaction, observer/power, and offensive-warfare systems remain planned or backlog items.

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
| `.gitignore` | Ignores dependencies, editor workspaces, Screeps temporary files, logs, and `package-lock.json`. |
| `423.code-workspace` / `default.code-workspace` | Minimal VS Code folder workspaces; neither defines build, upload, or Screeps connection settings. |

A local `package-lock.json` is present, but it is ignored and not tracked. Do not assume a fresh checkout has it. No Node or npm version is pinned by an `engines` field.

## Install, test, and build commands

```bash
npm install
npm test
npm run test:unit
npm run typecheck
```

- `npm test` is the full local validation: `npm run test:unit && npm run typecheck`.
- `npm run test:unit` runs `mocha "test/**/*.test.js"`.
- `npm run typecheck` runs `tsc --noEmit -p jsconfig.json`; it emits no production files.
- Run a focused suite with, for example, `npx mocha "test/logistics.regression.test.js"`, or select cases with Mocha's `--grep` option.

There is **no compile, bundle, lint, format, watch, upload, or deployment script**. Root JavaScript files are the Screeps source files themselves; `test/syntax.test.js` also runs `node --check` on each of them.

Although most files have `checkJs` disabled globally, `logistics.runner.js` opts in with `// @ts-check` and uses JSDoc types. Preserve that directive and keep its annotations valid.

## Main-loop architecture

`main.js` exports the Screeps entry point, `module.exports.loop`. Each tick proceeds in this order:

1. Instantiate and prioritize all roles through `BaseManager.fetchAllRoles()`.
2. Initialize CPU tracking, persistent memory/role information, and the per-tick `MainCache`.
3. Observe intel, plan remote missions, run defense, run factory production goals, plan terminal transfers, run opt-in market work when CPU permits, then run centralized logistics.
4. Run base spawning and creep behavior, then towers and links.
5. If deferred work is allowed, update road heatmaps, run the Mayor planner, and draw informational/CPU visuals.

`manager.cpu.js` enters degraded mode when `Game.cpu.bucket < 1000` and leaves it when the bucket is `> 1500`. The separate thresholds provide hysteresis. Remote construction, market order scanning, road watching, Mayor work, and visuals are deferred in degraded mode; memory setup, intel, remote spawn planning, defense, factory production, terminal planning, logistics, spawning, creep execution, towers, and links continue. Factories are intentionally engineered to keep planning and producing in degraded mode rather than waiting for bucket recovery.

### Core and manager modules

| Module | Responsibility |
| --- | --- |
| `main.js` | Tick orchestration plus global in-game administration/debugging helpers. |
| `main.cache.js` | Per-tick snapshots of rooms, spawns, creeps, flags, role/home counts, spawn reservations, and `room.find` results. |
| `main.util.js` | Cached global collection accessors, display names, and persistent structure-memory adapter. |
| `main.info.js` | Console logging and per-room visual displays; stores room names, not live room objects, in log history. |
| `main.constants.js` | Link labels, wall/rampart repair targets, and tower reserve/repair thresholds. |
| `manager.base.js` | Defines the role registry, spawn priority and quotas, emergency Harvester recovery, Miner replacement, declarative mission spawn providers, outsourced spawning, and creep dispatch. |
| `manager.memory.js` | Initializes base/spawn/role and empire memory, removes dead-creep and stale visible-structure memory, and samples `RawMemory` size every 100 ticks. |
| `manager.intel.js` | Normalizes bounded, versioned `Memory.empire` observations; expires stale intel while preserving active offscreen missions. |
| `manager.remote.js` | Plans explicit remote missions, bounded route demand and ROI, exact spawn requests, suspension/blacklist metadata, and remote sites. |
| `manager.factory.js` | Plans bounded goal-driven factory chains, recursive component imports, battery compression, cancellation, local logistics, and energy-reserve protection. |
| `manager.logistics.js` | Persistent per-room task queue, request generation, endpoint refresh, claims, partial-delivery reconciliation, and dynamic hauler demand. |
| `manager.terminal.js` | Bounded cross-room resource requests, owned-room balancing, reserve/fee accounting, cooldown-safe sends, and terminal stock positioning. |
| `manager.market.js` | Explicitly enabled existing-order buying/selling with price/credit/fee limits, deal caps, failure backoff, and bounded history. |
| `logistics.runner.js` | Executes a claimed task for Storekeepers and Couriers: pickup, delivery, retry backoff, and foreign-resource recovery. |
| `manager.defense.js` | Scores hostile bodies and proximity, selects a primary target, requests defenders, rate-limits notifications, and evaluates last-resort safe mode. |
| `manager.tower.js` | Executes the shared tower attack plan; otherwise heals friendly creeps or performs emergency repairs while respecting energy reserves. |
| `manager.mayor.js` | Validates base problems and, in automatic mode, fixes them; places roads and RCL-gated structures using smart placement and layout fallbacks. |
| `manager.room.js` | Owns structure characters, compact room layouts, RCL slot accounting, and extension placement. |
| `manager.link.js` | Applies planned/manual link roles and transfers energy from source links to target links. |
| `manager.road.js` | Extends `TileWatcher` to accumulate sparse creep-movement heatmaps and expose tiles over the road threshold. |
| `manager.cpu.js` | Measures manager CPU usage, controls degraded mode, and draws metrics. |
| `tile.watcher.js` | Generic periodic sparse-tile watcher; snapshots `tiles` into `lastTiles` after `watchTime`. |
| `tile.array.js` | Two-dimensional tile storage and fixed-width, row-major compact-string serialization used by room layouts and legacy road data. |

### Creep roles

All ordinary roles extend `role.prototype.js` and are registered in `BaseManager.fetchAllRoles()`. Exact role names stored in creep memory are `Harvester`, `Defender`, `Builder`, `Upgrader`, `Handyman`, `Explorer`, `Miner`, `Storekeeper`, `Courier`, `Scout`, `Reserver`, `RemoteMiner`, and `RemoteHauler`.

| Role | Behavior |
| --- | --- |
| `role.harvester.js` | Early-game energy bootstrap; fills core structures and can upgrade the controller. Highest normal spawn priority. |
| `role.miner.js` | Source-assigned static mining, nearby container/storage/link delivery, and timed replacement requests. |
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

`RolePrototype` supplies target/source selection, commuting, persisted-coordinate room travel, automatic nearby looting, manual move/recycle overrides, error handling, exact mission bodies, and body generation. Body generation respects available energy, role multipliers, and the 50-part creep limit. Roles commonly override `isNecessary()`, `spawnCreep()`, `_findTargets()`, `_findSources()`, and `_work()`.

Role instances are created once per tick and shared across creeps. Do not add persistent per-creep state to role instance fields; durable state belongs in Screeps `Memory`.

## Persistent state and invariants

### Base identity and memory

A base is a logical construct keyed by `room.memory.base.name`, not simply every object physically in one room. Spawns and creeps use `memory.home` to identify their base; creeps also use `memory.role`. `outsourceSpawn` permits a base to use another eligible free spawn.

Important persistent locations include:

- `room.memory.base.roleConfig`: quotas, body multipliers, source policy, and display options.
- `room.memory.logistics`: task queue, queue version, overflow count, and optional stock policy.
- `room.memory.defense`, `room.memory.mayor`, `room.memory.roomManager`, `room.memory.roadManager`, `room.memory.console`, and `room.memory.cpu`.
- `Memory.structures`: persistent structure metadata with `_roomName` and `_lastSeen`.
- `Memory.minerReplacements`: pending timed Miner replacements.
- `Memory.empire`: versioned bounded `intel`, `missions`, `squads`, `resourceRequests`, and reserved `alliances` maps; records contain primitives only. Remote missions are configured by `room.memory.base.remoteRooms` or `Remote...` flags. Cross-room resource requests use `TerminalManager.requestResource()` / `requestTransfer()`.

Use `MainUtil.fetchMemoryOfStructure()` for persistent structure settings such as link roles and lab/factory resource metadata. It connects the structure to `Memory.structures` and supports later cleanup. Be conservative when changing memory shapes: normalize older data and preserve standing work rather than deleting it wholesale.

### Cache discipline

`MainCache` resets by `Game.time`. `MainCache.find(room, findType, options)` caches the unfiltered result by room and find type, then applies `options.filter` to the cached values. When a mutation changes membership of a cached result, follow the existing invalidation patterns, such as after construction-site creation or resource pickup. Spawning goes through `MainCache.recordSpawn()` to reserve the spawn and update counts.

Do not retain `Game` objects or cached arrays as cross-tick state. Avoid accidentally sorting or otherwise mutating a shared cached result when a local copy is needed.

### Logistics contracts

Tasks have stable IDs derived from room, source, target, and resource type, and kinds `supply`, `collect`, or `route`. The queue is capped at 100 tasks. Claims connect `task.assignedCreep` with `creep.memory.taskId` and `creep.memory.logistics`; `remaining` is reconciled from cargo changes, including partial deliveries.

Storekeepers accept only energy tasks; Couriers accept any resource. Preserve offscreen/standing-task behavior, retry backoff, and stable IDs when editing this subsystem. The legacy `room.memory.source` / `room.memory.target` route is imported as a standing oxygen route. Terminal-generated storage positioning uses `room.memory.logistics.terminalStockPolicy`; manual `stockPolicy` rules take precedence and standing tasks must not be replaced.

### Construction and defense safeguards

Mayor defaults to automatic operation but supports `off`, `warn`, and `auto` modes. Nuker construction and wall/rampart fortification are explicitly opt-in through `room.memory.mayor`. Layout generation overwrites the existing editable layout.

Defense and towers share `DefenseManager.getPriorityTarget()` / `getTowerPlan()`. Keep target selection, healing estimates, per-room notification throttling, tower energy reserves, and safe-mode vulnerability checks coordinated rather than reimplementing them independently.

## Code style and change conventions

- Match the surrounding file. The codebase mixes older tab-indented/`var` modules with newer four-space/`const` code; there is no configured formatter or linter to impose a new style.
- Keep the existing flat naming scheme: `manager.<name>.js`, `role.<name>.js`, and root-level support modules. Use extensionless local CommonJS imports as the current files do.
- Managers commonly expose static `runAll()` methods and create per-room instances. Add new roles through `BaseManager.fetchAllRoles()` rather than creating a parallel dispatch path.
- Follow existing Screeps result-code handling (`OK`, `ERR_NOT_IN_RANGE`, and related constants), debug logging, and room-level exception boundaries.
- Use `MainCache`/`MainUtil` collection helpers where their per-tick behavior is intended, and keep CPU/memory bounds in mind for room-wide scans and serialized data.
- Do not add production imports from `node_modules` without also establishing how those modules would reach the Screeps runtime; no bundling mechanism currently exists.
- Update comments, `README.md`, or `TODO.md` when a change makes their behavior or implementation status stale. Do not mark roadmap items implemented merely because a structure can be placed or hauled.

## Testing strategy

Tests are local Mocha tests using Node assertions; they do not connect to a Screeps server or run a real game simulation.

- `test/main.loop.test.js`: full-loop bootstrap integration.
- `test/logistics.regression.test.js`: queue bounds, stable IDs, claims, partial loads, legacy routes, and worker demand.
- `test/defense.regression.test.js`: safe mode, target validation, alerts, tower decisions, and defender behavior.
- `test/planner.regression.test.js`: RCL placement, slots, link roles, layout performance, and occupied construction positions.
- `test/reliability.regression.test.js`: CPU hysteresis, memory measurement, recovery, spawning, and shared role behavior.
- `test/remote.regression.test.js`: empire bounds, remote configuration, reservation, travel, economy, ROI, construction, defense, and mission spawning.
- `test/economy.regression.test.js`: resource requests, terminal reserves/fees/cooldowns, balancing, logistics policies, market orders, credits, deal caps, and retries.
- `test/factory.regression.test.js`: recursive production goals, component requests, factory logistics, cancellation, reserve protection, and multi-room chains.
- `test/syntax.test.js`: syntax-checks every root-level `.js` file.

Use `test/helpers/screeps.js` for new tests. Call `resetScreeps()` before each case, normally in `beforeEach`, to install globals and reset `Game`, `Memory`, and `MainCache`. Build rooms/objects with `makeRoom`, `makeStructure`, `makeCreep`, `makeSpawn`, and `makeStore`; populate `room.find` results with `setFind`; and call `registerObject` for anything that must be reachable through `Game.getObjectById`.

The mocks implement only the Screeps behavior currently needed by the suite. Extend them deliberately when testing a new API, and clean up any additional global state a test installs. For behavior fixes, add a regression test that exercises the real manager/role method, not just an import or syntax check. Finish with `npm test`.

## Deployment and in-game operation

No automated deployment process or CI configuration is present in this repository. The npm commands validate code only; they do not upload it. Deployment is handled outside the repository by the user's Screeps script/client setup, so do not invent an upload command or assume that running tests changed a live shard. Live verification requires the external Screeps environment.

`main.js` installs global helpers for the in-game console:

- Creep operations: `fetchOldestCreep`, `spawnCreepForRoom`, `spawnMiner`, `spawnExplorer`, `selfdestruct`, and `moveCreepTo`.
- Quotas: `setCreepCount` and `setMultipleCreepCounts`.
- Links: `makeLinkSource` and `makeLinkTarget`.
- Layout/UI: `generateLayoutForRoom` and `clearConsole`.

Role names and object IDs are case-sensitive/value-sensitive inputs. `generateLayoutForRoom` replaces the previous room layout, and spawning, construction, safe mode, and recycle commands can affect a live base immediately.

## Security and operational safety

- No credentials, API tokens, or deployment secrets are part of the source or npm configuration. Keep such values out of the repository and logs.
- Treat changes to memory cleanup, task claims, spawning recovery, construction, tower targeting, and safe mode as live-game operational changes, not merely utility refactors.
- Preserve bounded queues, sparse road data, CPU deferral, notification rate limits, and opt-in destructive/expensive behavior. Avoid unbounded growth in `Memory` and avoid retaining live game objects in serialized state.
- The local tests cannot prove live-shard compatibility or performance. State that limitation when those properties matter, and leave live deployment/verification to the configured external workflow.
