# Screepsworld

Autonomous Screeps AI bot designed with Reliability, Availability, Scalability (RAS), Quality Assurance (QA), and clean modular architecture.

GitHub Repository: [https://github.com/SnowmanGnarly/Screepsworld-](https://github.com/SnowmanGnarly/Screepsworld-)

---

## 🏛️ Architecture Overview

The codebase is structured around decentralized role prototypes coordinated by centralized room and base managers:

- **Managers**:
  - `manager.base.js`: Base lifecycle, creep spawning queue, emergency recovery, and creep execution.
  - `manager.logistics.js`: Universal task queue and priority scheduler for moving energy, minerals, and compounds.
  - `manager.defense.js`: Threat assessment, coordinated tower focus fire, rate-limited alerts, on-demand defender dispatch, and safe mode protection.
  - `manager.mayor.js`: Automated base diagnostics, problem fixing, and RCL-aware construction site creation.
  - `manager.room.js`: Room layout generation, structure character encoding, and building slot calculations across RCL 1–8.
  - `manager.link.js`: Automated energy transfer from source links to storage and controller destination links.
  - `manager.tower.js`: Coordinated tower combat and emergency structural repairs.
  - `manager.memory.js`: Memory initialization, garbage collection of dead creeps, and structure memory cleaning.
  - `manager.cpu.js`: Real-time CPU profiling and on-screen metrics visualization.
  - `manager.road.js` / `tile.watcher.js`: Heatmap-based road creation over frequently traversed tiles.

- **Creep Roles**:
  - `role.harvester.js`: Early-game bootstrapping and core energy collection.
  - `role.miner.js`: Static container mining at energy sources ($5 \times \text{WORK}$).
  - `role.storekeeper.js`: Fast base hauler delivering energy from containers/storage to spawns, extensions, towers, and links via the logistics queue.
  - `role.courier.js`: Multi-resource logistics runner moving minerals, lab reagents, and surplus materials across the base.
  - `role.builder.js`: Construction site builder prioritized by distance and completion progress.
  - `role.upgrader.js`: Dedicated room controller upgrader fed by storage, containers, or links.
  - `role.handyman.js`: Structural maintenance, road repairs, and rampart/wall health leveling.
  - `role.defender.js`: On-demand combat creep spawned dynamically during invasions.
  - `role.explorer.js`: Remote room exploration, controller claiming, and base bootstrapping.

---

## 🚀 Key Subsystems (Phase 1)

### 1. General Resource Logistics (`manager.logistics.js`)
Decouples resource producers (miners, containers, labs, dropped piles) from consumers (spawns, extensions, towers, labs, storage). Tasks are prioritized and assigned to haulers based on urgency and travel distance.

### 2. RCL-Aware Construction Planner (`manager.mayor.js` & `manager.room.js`)
Automatically manages building queues as the Room Controller Level progresses from RCL 1 to RCL 8, enforcing placement rules:
- **RCL 3**: Tower
- **RCL 4**: Storage
- **RCL 5**: Source and Destination Links
- **RCL 6**: Extractor, 3-Lab Matrix, Terminal
- **RCL 7**: Factory, Spawn 2
- **RCL 8**: Observer, Power Spawn, Spawn 3, Nuker

### 3. Coordinated Defense Manager (`manager.defense.js`)
Replaces uncoordinated single-tower logic with room-wide threat assessment:
- Evaluates hostile body parts (healers, dismantlers, attackers, boosts).
- Coordinated focus fire targeting the most dangerous penetrable enemy.
- Dispatches defenders on-demand during invasions (0 maintained during peace).
- Throttles `Game.notify()` alerts to prevent inbox flooding.
- Emergency safe mode triggering as a last resort.

---

## 📋 Comprehensive Roadmap

For the complete 9-phase architectural roadmap, see [TODO.md](./TODO.md).

---

## 🎮 Useful In-Game Console Commands

```javascript
// Check oldest creep in a base
fetchOldestCreep('Spawn1');

// Spawn a specific role manually
spawnCreepForRoom('W1N1', 'Harvester');

// Adjust creep quotas dynamically
setCreepCount('W1N1', 'Upgrader', 3);
setMultipleCreepCounts('W1N1', ['Builder', 'Handyman'], 2);

// Configure links
makeLinkSource('linkId123');
makeLinkTarget('linkId456');

// Clear visual console
clearConsole();
```

