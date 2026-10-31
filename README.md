# Screepsworld

An autonomous AI for the game [Screeps](https://screeps.com). Given one spawn, it runs a room from RCL 1 through RCL 8 without console commands: mining, hauling, spawning, building, defense, and upgrading. Labs, factories, remote mining, trading, and expansion are there when you switch them on.

It is plain JavaScript that runs directly in the Screeps engine, with no build step and no runtime dependencies. The goals are reliability and bounded CPU and memory use: one failing subsystem must not stop the rest of the tick.

Repository: [SnowmanGnarly/Screepsworld-](https://github.com/SnowmanGnarly/Screepsworld-)

## Getting started

1. Copy the root-level `.js` files into a Screeps script branch, using the game client or any upload tool. `test/` and `node_modules/` stay behind. `main.js` is the entry point.
2. Place your first spawn. The bot creates the base and its memory on the next tick.
3. In the in-game console, run `version()` to confirm which code is live, and `cpuReport()` once it has run for a while to see CPU use.

If your scripts folder syncs to the game, saving a file there deploys it, broken or not. Do development somewhere else.

**Your room keeps an energy reserve.** Builders, Upgraders, Handymen, labs, and factories won't spend storage and terminal energy below `ENERGY_RESERVE_MINIMUM` in `main.config.js`: 50,000 from RCL 6, and less below that so young rooms can still grow. They stand idle at the line, which is normal. Set `room.memory.terminal.emergencyReserve` to override it for one room. Haulers still feed the spawn, extensions, and towers from the reserve, and an Upgrader can draw on it if the controller is close to downgrading.

**Don't edit Memory in the client's Memory panel.** The bot keeps `Memory` on the heap to save parsing, so panel edits and `RawMemory.set()` get overwritten on the next tick. Change it from the console instead, for example `Memory.rooms.W1N1.mayor.mode = 'warn'`.

## What runs on its own

- **Creep counts and bodies**, worked out from source output, route length, stored energy, and open construction.
- **Economy:** bootstrap Harvesters, then static Miners with Storekeepers hauling from a central task queue, plus Upgraders and Builders.
- **Construction:** a planned layout built as each RCL unlocks it, and roads where creeps walk most.
- **Defense:** threat scoring, coordinated towers, Defenders on demand, email alerts, and safe mode as a last resort.
- **Links**, and **mineral mining** at RCL 6 and above.
- **Terminal balancing** between your rooms, when they have terminals.

## What you switch on

Everything below is off until you configure it, per room. Run these in the console or add them to your own setup.

**Remote mining.** Set `room.memory.base.remoteRooms` to a list of room names, or place a flag named `Remote`, `Remote:<target>`, or `Remote:<home>:<target>`.

**Factories.** Set target stocks, a battery target, or both:

```javascript
room.memory.factory = {
    enabled: true,
    goals: { composite: 5000, oxidant: 1000 },
    batteryTarget: 10000,
    batchSize: 1000
};
```

**Lab reactions and boosts.** Goals are stock targets. A boost policy applies to every creep of that role at spawn time:

```javascript
room.memory.lab = {
    enabled: true,
    goals: { [RESOURCE_UTRIUM_ALKALIDE]: 1000 },
    reserves: { [RESOURCE_UTRIUM]: 200, [RESOURCE_OXYGEN]: 200 },
    boosts: {
        Upgrader: { work: RESOURCE_CATALYZED_GHODIUM_ACID, required: false },
        Defender: { attack: RESOURCE_CATALYZED_UTRIUM_ACID, required: false }
    }
};
```

With `required: false`, a creep spawns unboosted if the compound isn't ready. With `required: true`, the spawn waits while haulers load the lab, so keep it off roles you need urgently. Add `autoProfit: true` to also make products your market sell rules allow.

**Market.** Fills existing orders only; it never creates public orders. Limits on price, credits, and deals are enforced:

```javascript
room.memory.market = {
    enabled: true,
    sell: true,
    resources: {
        energy: { sell: true, min: 20000, target: 50000, max: 100000, minSellPrice: 1.5 }
    }
};
```

**Walls and optional structures.** Set these on `room.memory.mayor`:

| Setting | Effect |
| --- | --- |
| `enableFortification: true` | Plans and builds one minimum-cut rampart line at RCL 4 and above, then keeps walls repaired. |
| `enableNuker: true` | Builds the nuker. |
| `enablePowerSpawn: true`, `enableObserver: true` | Builds these structures, though no code uses them yet. |
| `mode: 'warn'` or `'off'` | Mayor stops building (default `'auto'`). This also turns off derived creep counts for the room, so it needs manual quotas. |

**Expansion.** This is manual. Place a flag on the tile where the new spawn should go, naming it anything except `Remote` or `Remote:…`, then run `spawnExplorer('Spawn1', 'MyFlag')`. The Explorer claims the room, builds the spawn, and removes the flag. You need enough GCL for another room, and the flag name becomes the new base's name.

## Console commands

Installed as globals by `main.js`. Role names and object IDs are case-sensitive, and these commands act on your live base immediately.

```javascript
// Creeps
spawnCreepForRoom('W1N1', 'Harvester');
spawnMiner('Spawn1', 'sourceId');
spawnExplorer('Spawn1', 'flagName');
fetchOldestCreep('Spawn1');
moveCreepTo('creepName', 'gameObjectId');
selfdestruct('creepName');               // walks to a spawn and recycles

// Quotas: a count above zero is a floor over what the room derives; zero turns the role off
setCreepCount('W1N1', 'Upgrader', 3);
setMultipleCreepCounts('W1N1', ['Builder', 'Handyman'], 2);

// Links
makeLinkSource('linkId');
makeLinkTarget('linkId');

// Layout and display
generateLayoutForRoom('W1N1');           // replaces the room's previous layout
setSetting('visuals', false);            // also: pathVisuals, creepIcons
clearConsole();

// Status
version();
cpuReport();                             // average CPU, bucket trend, most expensive jobs
```

To turn derived creep counts off, set `room.memory.base.autoDemand = false` for a room, or `roleConfig[role].auto = false` for one role.

## How a tick works

`main.js` runs a table of jobs through `main.scheduler.js`. A job that throws is reported, at a limited rate and by email, and the next job still runs. Each tick runs in this order:

1. Restore `Memory` from the heap, then set up memory, roles, and the per-tick cache.
2. Observe intel and plan remote missions.
3. Run defense, then towers and links, so an economy problem can't cost you your defense.
4. Run factories and labs, plan terminal transfers and market deals, then generate logistics tasks.
5. Run the spawn queue and all creeps.
6. Watch roads, run the Mayor planner (every 10 ticks, on a different tick per room), and draw visuals.
7. Record CPU history in `Memory.stats`.

When the CPU bucket runs low, work drops away in tiers:

| Bucket | What stops |
| --- | --- |
| Below 1000, until it recovers above 1500 | Factories, lab reactions, terminal planning, the market, remote construction, road watching, the Mayor, and visuals |
| Below 200 | Also intel, remote planning, and labs entirely |
| Any level | Defense, towers, links, logistics, spawning, and creeps always run |

A job that can wait is also skipped once a tick has used 90% of `Game.cpu.tickLimit`, because a tick that hits the limit is thrown away whole.

## Code layout

The modules sit flat in the root, because that's how they reach the game.

| Files | Purpose |
| --- | --- |
| `main.js`, `main.scheduler.js`, `main.memhack.js` | Entry point, job table, console commands, and the heap copy of `Memory` |
| `main.config.js`, `main.constants.js` | Tunable policy values and stored labels |
| `main.cache.js`, `main.heap.js`, `main.util.js` | Per-tick cache, data kept until a global reset, and shared helpers |
| `main.move.js`, `main.mincut.js`, `main.info.js` | Movement, rampart line search, and logging and visuals |
| `manager.base.js`, `manager.economy.js`, `manager.memory.js`, `manager.cpu.js` | Spawn queue, derived demand, memory upkeep, and CPU tiers |
| `manager.logistics.js`, `logistics.runner.js` | The hauling task queue and the code that carries tasks out |
| `manager.mayor.js`, `manager.room.js`, `manager.road.js`, `tile.*.js` | Construction, room layouts, and road heatmaps |
| `manager.defense.js`, `manager.tower.js`, `manager.link.js` | Threat assessment, towers, and links |
| `manager.factory.js`, `manager.lab.js`, `lab.matrix.js`, `manager.mineral.js` | Production chains, reactions, boosts, and minerals |
| `manager.terminal.js`, `manager.market.js` | Cross-room transfers and trading |
| `manager.intel.js`, `manager.remote.js` | Bounded empire memory and outposts |
| `manager.director.js` | Per-room strategic goals. **Not connected yet, so it has no effect in game.** |
| `role.*.js` | One file per creep role, all extending `role.prototype.js` |

[AGENTS.md](./AGENTS.md) covers each module, the memory layout, and the conventions to follow when changing code.

## Development

Node.js is only for local tests. All npm packages are dev dependencies, and nothing from them reaches the game.

```bash
npm install
npm test            # all tests, then the type check
npm run test:unit   # all tests, including the E2E stress test
npm run test:e2e    # only the stress test, with its report
npm run typecheck
npx mocha "test/logistics.regression.test.js"   # one suite
```

- **Unit and regression tests** use the mocks in `test/helpers/screeps.js`. They load the engine's real constants and rebuild game objects between ticks, so code that keeps one across ticks fails loudly.
- **The E2E stress test** uses `test/helpers/simulator.js` to run the real main loop for 2,000 ticks with a factory crash at tick 500 and a global reset at tick 1200. It checks the economy, CPU, and an exact energy balance. Its CPU figures show trends only: terrain is flat, creeps don't collide, and path costs are estimated.
- **Tests can't prove live behavior.** No test connects to a Screeps server, so confirm changes on a shard.

## Deployment

The repository has no upload script or CI, and the npm commands don't upload anything. Deploy with your own client or tool, then check with `version()`.

## Known limitations

- **Expansion needs a person:** something has to choose the room, place the flag, and spawn the Explorer. The Explorer path also has no test coverage.
- **The Director isn't connected:** rooms don't yet switch strategy on their own.
- **Not built yet:** deposit harvesting, observer and power systems, and offensive warfare. See [TODO.md](./TODO.md) for the roadmap.
