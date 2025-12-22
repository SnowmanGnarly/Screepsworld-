// GUI Statistics Collection - Gathers and stores data for visualization
module.exports = {
    /**
     * Collect statistics for the room
     */
    collect: function (room) {
        if (!room.memory.stats) {
            room.memory.stats = {
                history: [],
                lastUpdate: Game.time
            };
        }

        // Collect stats every 20 ticks to save CPU
        if (Game.time % 20 !== 0) return;

        const stats = this.gatherCurrentStats(room);

        // Add to history
        room.memory.stats.history.push(stats);

        // Keep only last 100 ticks
        if (room.memory.stats.history.length > 100) {
            room.memory.stats.history.shift();
        }

        room.memory.stats.lastUpdate = Game.time;
        room.memory.stats.current = stats; // Store current for easy access
    },

    /**
     * Gather current tick statistics
     */
    gatherCurrentStats: function (room) {
        const stats = {
            tick: Game.time,
            energy: this.getEnergyStats(room),
            cpu: this.getCPUStats(),
            creeps: this.getCreepStats(room),
            sources: this.getSourceStats(room),
            towers: this.getTowerStats(room),
            construction: this.getConstructionStats(room),
            threats: this.getThreatStats(room)
        };

        return stats;
    },

    /**
     * Get energy statistics
     */
    getEnergyStats: function (room) {
        let totalEnergy = 0;
        let totalCapacity = 0;

        // Storage
        const storage = room.storage;
        if (storage) {
            totalEnergy += storage.store[RESOURCE_ENERGY] || 0;
            totalCapacity += storage.store.getCapacity(RESOURCE_ENERGY);
        }

        // Containers
        const containers = room.find(FIND_STRUCTURES, {
            filter: s => s.structureType === STRUCTURE_CONTAINER
        });
        containers.forEach(container => {
            totalEnergy += container.store[RESOURCE_ENERGY] || 0;
            totalCapacity += container.store.getCapacity(RESOURCE_ENERGY);
        });

        return {
            total: totalEnergy,
            capacity: totalCapacity,
            percentage: totalCapacity > 0 ? totalEnergy / totalCapacity : 0,
            roomEnergy: room.energyAvailable,
            roomEnergyCapacity: room.energyCapacityAvailable,
            storage: storage ? storage.store[RESOURCE_ENERGY] : 0,
            containers: totalEnergy - (storage ? storage.store[RESOURCE_ENERGY] : 0)
        };
    },

    /**
     * Get CPU statistics
     */
    getCPUStats: function () {
        return {
            used: Game.cpu.getUsed(),
            limit: Game.cpu.limit,
            bucket: Game.cpu.bucket,
            percentage: Game.cpu.getUsed() / Game.cpu.limit
        };
    },

    /**
     * Get creep statistics by role
     */
    getCreepStats: function (room) {
        const stats = {};
        const creeps = room.find(FIND_MY_CREEPS);

        creeps.forEach(creep => {
            const role = creep.memory.role;
            if (!stats[role]) {
                stats[role] = {
                    count: 0,
                    energy: 0,
                    capacity: 0,
                    idle: 0
                };
            }

            stats[role].count++;
            stats[role].energy += creep.store[RESOURCE_ENERGY] || 0;
            stats[role].capacity += creep.store.getCapacity(RESOURCE_ENERGY);

            // Check if idle (not moving and not working)
            if (!creep.memory.working && creep.store.getFreeCapacity() === 0) {
                stats[role].idle++;
            }
        });

        return stats;
    },

    /**
     * Get source mining statistics
     */
    getSourceStats: function (room) {
        const sources = room.find(FIND_SOURCES);
        const stats = [];

        sources.forEach(source => {
            const harvesters = room.find(FIND_MY_CREEPS, {
                filter: c => c.memory.role === 'harvester' && c.memory.sourceId === source.id
            });

            const workParts = harvesters.reduce((sum, creep) => {
                return sum + creep.body.filter(p => p.type === WORK).length;
            }, 0);

            // Max harvest rate is 10 energy per tick (5 WORK parts)
            const maxRate = Math.min(workParts * 2, 10);
            const efficiency = source.energy > 0 ? maxRate / 10 : 0;

            stats.push({
                id: source.id,
                energy: source.energy,
                energyCapacity: source.energyCapacity,
                harvesters: harvesters.length,
                workParts: workParts,
                efficiency: efficiency,
                ticksToRegen: source.ticksToRegeneration || 0
            });
        });

        return stats;
    },

    /**
     * Get tower statistics
     */
    getTowerStats: function (room) {
        const towers = room.find(FIND_MY_STRUCTURES, {
            filter: s => s.structureType === STRUCTURE_TOWER
        });

        return towers.map(tower => ({
            id: tower.id,
            energy: tower.store[RESOURCE_ENERGY],
            energyCapacity: tower.store.getCapacity(RESOURCE_ENERGY),
            percentage: tower.store[RESOURCE_ENERGY] / tower.store.getCapacity(RESOURCE_ENERGY)
        }));
    },

    /**
     * Get construction site statistics
     */
    getConstructionStats: function (room) {
        const sites = room.find(FIND_CONSTRUCTION_SITES);

        return sites.map(site => ({
            id: site.id,
            type: site.structureType,
            progress: site.progress,
            progressTotal: site.progressTotal,
            percentage: site.progress / site.progressTotal
        }));
    },

    /**
     * Get threat statistics
     */
    getThreatStats: function (room) {
        const hostiles = room.find(FIND_HOSTILE_CREEPS);

        // Helper: score a creep by "combat value" (not just body size)
        function scoreHostile(creep) {
            let score = 0;

            for (const part of creep.body) {
                switch (part.type) {
                    case ATTACK: score += 3; break;
                    case RANGED_ATTACK: score += 3; break;
                    case HEAL: score += 5; break;
                    case TOUGH: score += 1; break;
                    case WORK: score += 2; break; // dismantle threat
                    default: break; // MOVE, CARRY, CLAIM etc
                }
            }
            return score;
        }

        const towers = room.find(FIND_MY_STRUCTURES, {
            filter: s => s.structureType === STRUCTURE_TOWER
        });

        const totalTowerEnergy = towers.reduce((sum, t) => sum + (t.store[RESOURCE_ENERGY] || 0), 0);
        const hostileScore = hostiles.reduce((sum, h) => sum + scoreHostile(h), 0);

        // distance-to-core: closest hostile to spawn (or controller)
        const anchor = (room.find(FIND_MY_SPAWNS)[0]) || room.controller;
        let closestRange = null;
        if (anchor && hostiles.length > 0) {
            const closest = anchor.pos.findClosestByRange(hostiles);
            if (closest) closestRange = anchor.pos.getRangeTo(closest);
        }

        // Threat level (combat-based)
        let threatLevel = 'safe';
        if (hostiles.length > 0) {
            if (hostileScore >= 25 || (closestRange !== null && closestRange <= 6)) threatLevel = 'danger';
            else if (hostileScore >= 10) threatLevel = 'warning';
            else threatLevel = 'caution';
        }

        const hasInvader = hostiles.some(h => h.owner && h.owner.username === 'Invader');

        return {
            hostileCount: hostiles.length,
            threatLevel,
            hostileScore,
            hasInvader,
            closestRange, // null if no anchor / no hostiles
            towerCount: towers.length,
            totalTowerEnergy,
            hostiles: hostiles.map(h => ({
                owner: h.owner.username,
                bodySize: h.body.length,
                score: scoreHostile(h),
                pos: h.pos
            }))
        };
    },

    /**
     * Get historical data for graphs
     */
    getHistory: function (room, dataPath, maxTicks = 50) {
        if (!room.memory.stats || !room.memory.stats.history) return [];

        const history = room.memory.stats.history.slice(-maxTicks);
        return history.map(stat => {
            // Navigate nested path (e.g., 'energy.total')
            const keys = dataPath.split('.');
            let value = stat;
            for (const key of keys) {
                value = value[key];
                if (value === undefined) return 0;
            }
            return value;
        });
    }
};
