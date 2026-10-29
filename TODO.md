# Screepsworld Architectural Roadmap & TODO Tracker

> **Repository**: [SnowmanGnarly/Screepsworld-](https://github.com/SnowmanGnarly/Screepsworld-)  
> **Status**: Production Refactor & RAS/QA Hardening  
> **Target**: Scalable autonomous Screeps engine from RCL 1 to RCL 8 with multi-room logistics, coordinated defense, and market automation.

---

## 📊 System Maturity & Implementation Matrix

| Phase | System Component | Status | Focus / Highlights |
| :---: | :--- | :---: | :--- |
| **P1** | **General Resource Logistics** | ✅ **Implemented** | Universal task queue (`manager.logistics.js`), multi-resource courier/storekeeper bus. |
| **P1** | **RCL-Aware Construction Planner** | ✅ **Implemented** | Automated RCL 3–8 structure unlocking & intelligent placement in `manager.room.js` & `manager.mayor.js`. |
| **P1** | **Defense Manager & Invasion Response** | ✅ **Implemented** | Threat assessment, coordinated tower focus fire, rate-limited notifications, on-demand defenders (`manager.defense.js`). |
| **P1** | **RAS & Memory Optimization** | ✅ **Implemented** | Fixed 2,500-cell serialization bottleneck in `tile.watcher.js`, defensive `roleInfo` handling in `manager.base.js`. |
| **P2A** | **Remote Mining & Reservation** | ✅ **Implemented** | Scouts, reservers, remote miners/haulers, bounded missions, construction, and net ROI profitability modeling (`manager.remote.js`). |
| **P2** | **Mineral Mining, Labs & Boosts (RCL 6)** | ✅ **Implemented** | Automatic capped extractor harvesting, dynamic 3-lab & 10-lab reaction pipelines, exact lab logistics, and opt-in spawn boosts (`manager.mineral.js`, `manager.lab.js`). |
| **P2B** | **Terminal & Market Automation (RCL 6)** | ✅ **Implemented** | Configurable inter-room balancing, existing-order trading, reserves, and exact fee accounting (`manager.terminal.js`, `manager.market.js`). |
| **P2C** | **Goal-Driven Factory Chains (RCL 7)** | ✅ **Implemented** | Recursive production goals, component imports, battery compression, cancellation, and reserve protection (`manager.factory.js`). |
| **P3** | **Deposit Harvesting (RCL 7)** | 📋 **Backlog** | Highway deposit scouting and harvesting with cooldown decay tracking. |
| **P3** | **Observer & Power Automation (RCL 8)** | 📋 **Backlog** | Radar room scanning, Power Bank 50% damage reflection squads, Operator Power Creep automation. |
| **P3** | **Stronghold Raids & Offensive Warfare** | 📋 **Backlog** | Late-game automated NPC stronghold destruction, squad coordination, and treasury looting. |

---

## 🛠️ Detailed Implementation Breakdown

### 1. General Resource Logistics — Foundation Layer
- [x] Create `manager.logistics.js` featuring an in-memory & memory-backed task queue:
  ```javascript
  {
      id: string,
      sourceId: string,
      targetId: string,
      resourceType: ResourceConstant,
      amount: number,
      priority: number,
      assignedCreep: string | null
  }
  ```
- [x] Auto-generate high-priority delivery requests:
  - [x] Spawn & Extension refills (`priority: 100`)
  - [x] Towers under invasion or below 500 energy (`priority: 90 - 95`)
  - [x] Labs needing energy or reaction reagents (`priority: 60 - 70`)
- [x] Auto-generate supply collection requests:
  - [x] Dropped resource piles $> 100$ amount (`priority: 80`)
  - [x] Source containers $> 400$ energy (`priority: 75`)
  - [x] Full mineral containers, factory output, or lab products (`priority: 65`)
- [x] Migrate `role.courier.js` to handle any resource type dynamically from `LogisticsManager`.
- [x] Migrate `role.storekeeper.js` to execute prioritized energy logistics tasks.
- [ ] Implement multi-room hauler dispatching when storage holds $> 100,000$ surplus energy.

---

### 2. RCL-Aware Construction Planner
- [x] Extend `manager.room.js` with comprehensive structure character codes:
  - [x] RCL 3: Tower (`T`)
  - [x] RCL 4: Storage (`U`)
  - [x] RCL 5: Links (`L`)
  - [x] RCL 6: Extractor (`X`), Labs (`B`), Terminal (`M`)
  - [x] RCL 7: Factory (`F`), Second Spawn (`S`)
  - [x] RCL 8: Observer (`V`), Power Spawn (`P`), Third Spawn (`S`), Nuker (`N`)
- [x] Implement placement rules in `manager.mayor.js`:
  - [x] Place `STRUCTURE_EXTRACTOR` directly on mineral position (`FIND_MINERALS`).
  - [x] Place `STRUCTURE_STORAGE` centrally near main spawn.
  - [x] Place `STRUCTURE_TOWER` in protective radius near core structures.
  - [x] Place `STRUCTURE_TERMINAL` adjacent to storage.
  - [x] Cluster `STRUCTURE_LAB` within reaction range ($\le 2$ tiles).
  - [x] Position `STRUCTURE_LINK` adjacent to sources, controller, and storage.
- [ ] Add dynamic distance transform matrix to optimize bunker layouts.

---

### 3. Defense Manager & Invasion Response
- [x] Implement `manager.defense.js`:
  - [x] Room-wide threat assessment: scan `FIND_HOSTILE_CREEPS` and compute threat scores based on body parts (`HEAL`, `ATTACK`, `RANGED_ATTACK`, `WORK`) and active boosts.
  - [x] Coordinated tower focus fire: all towers fire simultaneously on the single highest-value hostile (healers first, then dismantlers/attackers).
  - [x] Rate-limited alerts: `Game.notify()` throttled to at most once per 100 ticks per room.
  - [x] On-demand defenders: dynamically spawn `role.defender.js` during peacetime ($0$ creeps maintained; auto-spawns upon hostile detection).
  - [x] Tower energy reserves: preserve $\ge 200$ energy for combat; prevent non-essential repairs during battle.
  - [x] Safe Mode safeguard: activate safe mode as a last resort if hostiles breach within 3 tiles of spawn/storage and ramparts fail.
- [ ] Add rampart defense matrix with progressive hit leveling ($10\text{k} \rightarrow 100\text{k} \rightarrow 1\text{M} \rightarrow 10\text{M}$).

---

### 4. Remote Mining & Controller Reservation
- [x] Create `role.scout.js` for lightweight room scouting and intel gathering.
- [x] Create `role.reserver.js` with `[CLAIM, MOVE]` parts to reserve neutral rooms (restoring source output to 3000 energy / 300 ticks).
- [x] Create `role.remoteMiner.js` with mission-sized bodies for mining near remote source containers.
- [x] Create `role.remoteHauler.js` with demand-sized bodies for routes between remote containers and home storage.
- [x] Implement `manager.remote.js` to compute bounded Net ROI:
  $$\Delta E = E_{\text{harvested}} - (E_{\text{miner}} + E_{\text{hauler}} + E_{\text{reserver}} + E_{\text{repairs}} + E_{\text{defense}})$$
  Automatically suspend or blacklist rooms with sustained losses, active invader cores, or player harassment.
- [x] Plan bounded remote construction and exact mission spawns, with coverage in `test/remote.regression.test.js`.

---

### 5. Mineral Mining, Lab Reactions & Boosts — RCL 6
- [x] Create `role.miner.mineral.js` and `manager.mineral.js`:
  - [x] Harvest room mineral deposits at RCL 6+ through built Extractors when storage/terminal capacity permits.
  - [x] Obey extractor cooldown and mineral regeneration timing, with automatic demand capped at one miner by default.
- [x] Create `manager.lab.js`:
  - [x] Dynamically designate 2 supply reagent labs and up to 8 production labs within range 2.
  - [x] Implement bounded ordered base/T1/T2/T3 reaction chains driven by storage/terminal/lab inventory and strategic reserves.
  - [x] Integrate with `manager.logistics.js` for exact energy/reagent loading, product collection, and drain-before-reassignment.
- [x] Implement opt-in boost requests with stocked-lab preflight, resource reservations, post-spawn boosting, cleanup, and emergency recovery bypass.
- [x] Cover mineral harvesting in `test/mineral.regression.test.js`, reactions/logistics in `test/lab.regression.test.js`, and boosts in `test/boost.regression.test.js`.

---

### 6. Terminal & Market Automation — RCL 6
- [x] Create `manager.terminal.js`:
  - [x] Balance owned rooms with configurable per-resource thresholds and hysteresis; energy defaults to $10\text{k}$ minimum, $20\text{k}$ target, and $50\text{k}$ maximum.
  - [x] Calculate transfer energy cost: $\lceil \text{amount} \times (1 - e^{-\text{distance} / 30}) \rceil$.
  - [x] Provide bounded reusable resource requests, exact fee accounting, cooldown-safe sends, and terminal stock positioning.
- [x] Create `manager.market.js`:
  - [x] Sell surplus configured resources through the best net eligible existing buy orders via `Game.market.deal()`.
  - [x] Buy configured resources, including lab reagents, when stockpiles drop below threshold.
  - [x] Use existing orders only; public order creation remains disabled and unimplemented.
  - [x] Enforce a configurable emergency energy reserve ($50\text{k}$ by default).
- [x] Cover requests, reserves, fees, balancing, stock policies, order limits, and retries in `test/economy.regression.test.js`.

---

### 7. Goal-Driven Factory Chains — RCL 7 (Phase 2C)
- [x] Create `manager.factory.js`:
  - [x] Produce configured commodity targets through bounded recursive dependency chains.
  - [x] Request missing components through terminal transfers and move factory inputs/outputs through logistics.
  - [x] Compress raw energy into batteries without spending emergency reserves.
  - [x] Support partial batches, explicit cancellation, goal cleanup, and multi-room chains.
- [x] Cover production planning, logistics, cancellation, reserves, and cross-room requests in `test/factory.regression.test.js`.

---

### 8. Deposit Harvesting — RCL 7 (Backlog)
- [ ] Create `role.depositMiner.js`:
  - [ ] Scout highway rooms for metal, silicon, biomass, and mist.
  - [ ] Track increasing harvest cooldown; retire miners when cooldown $> 100$ ticks.

---

### 9. Observer Intelligence & Power Automation — RCL 8
- [ ] Create `manager.observer.js`:
  - [ ] Scan radar rooms sequentially (1 tick delay) for power banks, highway deposits, and player threats.
- [ ] Form Power Bank hunting squads:
  - [ ] Dual-creep squad: 1 Attacker ($20\text{A}, 20\text{M}$) + 1 Healer ($25\text{H}, 25\text{M}$) to counter the 50% damage reflection.
  - [ ] Timed hauler arrival to collect power before decay.
- [ ] Power Spawn & Power Creep (Operator):
  - [ ] Automate Power Spawn processing ($1 \text{ power} + 50 \text{ energy} \rightarrow 1 \text{ GPL}$).
  - [ ] Automate Operator powers: `GENERATE_OPS`, `OPERATE_SPAWN`, `OPERATE_EXTENSION`, `OPERATE_TOWER`.

---

### 10. Stronghold Raids & Offensive Warfare — Late Game
- [ ] Detect NPC Invader Strongholds and assess difficulty levels (Core Level 1–5).
- [ ] Coordinated dismantler and ranged attack assault squads.
- [ ] Full-resource ruin collection and loot hauling back to terminal.
- [ ] Optional Nuker automated targeting and countdown synchronization.

---

## 🛡️ Reliability, Availability & Scalability (RAS) Guarantees

1. **CPU Throttling**:
   - If `Game.cpu.bucket < 1000`, non-essential subsystems (visuals, road heatmaps, construction planning) sleep while factory production, terminal/logistics work, spawning, towers, and defense continue.
2. **Memory Safety**:
   - Serialized memory is sampled every 100 ticks through `RawMemory`; warnings above 1.5 MB are rate-limited rather than enforcing a hard 1 MB limit.
   - Eliminated synchronous 2,500-cell array serializations in `tile.watcher.js`.
   - Display data and transient creep state stay out of `Memory`; memory for unused rooms is pruned.
3. **Fault-Tolerant Spawning**:
   - Every job in `main.js` is isolated by `main.scheduler.js`; a spawning error cannot stop towers, links, or creeps.
   - Emergency Harvester recovery triggers automatically if all creeps die and energy $\ge 200$.
4. **Defensive Programming**:
   - All room and structure lookups guarded against visionless rooms (`Game.getObjectById` null checks).
   - Safe role iteration preventing uncaught `TypeError` propagation.

