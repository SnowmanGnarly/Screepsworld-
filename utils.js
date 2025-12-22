// utils.js - helper functions for Screeps project
const constants = require('constants');

/**
 * Build a harvester body with at least 1 WORK, 1 CARRY, 1 MOVE.
 * Capped at 5 WORK, 2 CARRY, 2 MOVE maximum.
 * @param {number} energy - Available energy for the spawn.
 * @returns {BodyPartConstant[]} Array of body parts.
 */
function makeHarvesterBody(energy) {
    // Minimum body cost is 200 (WORK + CARRY + MOVE)
    if (energy < 200) {
        return [WORK, CARRY, MOVE];
    }
    // Maximum harvester: 5 WORK, 2 CARRY, 2 MOVE = 700 energy
    const maxEnergy = 700;
    const cappedEnergy = Math.min(energy, maxEnergy);

    // Body pattern: [WORK, WORK, ..., CARRY, CARRY, MOVE, MOVE]
    const body = [];
    let cost = 0;
    const workCost = 100;
    const minSupportCost = 200; // 2 CARRY (100) + 2 MOVE (100)
    const maxWork = 5;
    // Add as many WORK parts as possible (max 5), leaving room for 2 CARRY + 2 MOVE
    while (cost + workCost + minSupportCost <= cappedEnergy && body.filter(p => p === WORK).length < maxWork) {
        body.push(WORK);
        cost += workCost;
    }
    // Ensure at least 1 WORK part
    if (body.length === 0) {
        body.push(WORK);
        cost += 100;
    }
    // Add 2 CARRY parts (or 1 if not enough energy)
    if (cost + 100 <= cappedEnergy) {
        body.push(CARRY, CARRY);
        cost += 100;
    } else if (cost + 50 <= cappedEnergy) {
        body.push(CARRY);
        cost += 50;
    } else {
        body.push(CARRY);
        cost += 50;
    }
    // Add 2 MOVE parts (or 1 if not enough energy for 2)
    if (cost + 100 <= cappedEnergy) {
        body.push(MOVE, MOVE);
        cost += 100;
    } else if (cost + 50 <= cappedEnergy) {
        body.push(MOVE);
        cost += 50;
    } else {
        body.push(MOVE);
        cost += 50;
    }
    return body;
}

/**
 * Build a generic worker body (builder/upgrader) with balanced parts.
 * Uses the standard segment of WORK, CARRY, MOVE.
 * @param {number} energy - Available energy for the spawn.
 * @returns {BodyPartConstant[]} Array of body parts.
 */
function makeWorkerBody(energy) {
    const segmentCost = 200; // WORK + CARRY + MOVE
    const maxSegments = Math.floor(energy / segmentCost);
    if (maxSegments <= 0) {
        return [WORK, CARRY, MOVE];
    }
    const numSegments = Math.min(maxSegments, 16); // cap at 48 parts
    const body = [];
    for (let i = 0; i < numSegments; i++) body.push(WORK);
    for (let i = 0; i < numSegments; i++) body.push(CARRY);
    for (let i = 0; i < numSegments; i++) body.push(MOVE);
    return body;
}

/**
 * Find the best energy source for a creep to withdraw or harvest energy.
 * Priorities:
 *  1. Dropped resources on the ground (free energy)
 *  2. Energy from Links (immediate available energy)
 *  3. Assigned source (if this creep has a dedicated source)
 *  4. Friendly creeps (e.g., harvesters) carrying energy
 *  5. Available Sources to harvest (not overcrowded)
 *  6. Storage or Containers with energy
 *  7. Any source (even if occupied, as a last resort)
 * @param {Creep} creep - The creep that needs energy.
 * @returns {Resource|Structure|Creep|Source|null} The target object to get energy from, or null if none found.
 */
function getEnergySource(creep) {
    const room = creep.room;
    // Priority 1: Dropped energy resources
    const dropped = getCachedDroppedEnergy(room);
    if (dropped.length > 0) {
        const closestDrop = creep.pos.findClosestByRange(dropped);
        if (closestDrop) {
            return closestDrop;
        }
    }
    // Priority 2: Filled links with energy
    const links = room.find(FIND_STRUCTURES, {
        filter: s => s.structureType === STRUCTURE_LINK && s.store[RESOURCE_ENERGY] > 0
    });
    if (links.length > 0) {
        const closestLink = creep.pos.findClosestByRange(links);
        if (closestLink) {
            return closestLink;
        }
    }
    // Priority 3: Dedicated assigned source (if any)
    if (creep.memory.assignedSource) {
        const assignedSource = Game.getObjectById(creep.memory.assignedSource);
        if (assignedSource) {
            return assignedSource;
        } else {
            creep.memory.assignedSource = null; // cleanup invalid assignment
        }
    }
    // Priority 4: Friendly creeps (harvesters) with spare energy
    const harvesters = room.find(FIND_MY_CREEPS, {
        filter: c => (c.memory.role === 'harvester' || c.memory.role === 'remote_harvester') && c.store[RESOURCE_ENERGY] > 0 && c.id !== creep.id
    });
    if (harvesters.length > 0) {
        const closestHarvester = creep.pos.findClosestByPath(harvesters);
        if (closestHarvester) {
            return closestHarvester;
        }
    }
    // Priority 5: Withdraw from storage or container (if available)
    if (room.storage && room.storage.store[RESOURCE_ENERGY] > 50) {
        return room.storage;
    }
    const containers = room.find(FIND_STRUCTURES, {
        filter: s => s.structureType === STRUCTURE_CONTAINER && s.store[RESOURCE_ENERGY] > 50
    });
    if (containers.length > 0) {
        const closestContainer = creep.pos.findClosestByPath(containers);
        if (closestContainer) return closestContainer;
    }

    // Priority 6: Harvest from a source that is not at full worker capacity
    const sources = getCachedSources(room);
    const availableSources = sources.filter(s => {
        const capacity = constants.SOURCE_CAPACITY[s.id] || 1;
        const nearbyCreeps = s.pos.findInRange(FIND_MY_CREEPS, 1);
        const count = nearbyCreeps.filter(c => c.id !== creep.id).length;
        return count < capacity;
    });
    if (availableSources.length > 0) {
        const openSource = creep.pos.findClosestByPath(availableSources);
        if (openSource) return openSource;
    }

    // Priority 7: Take energy from any source (last resort)
    if (sources.length > 0) {
        return creep.pos.findClosestByRange(sources);
    }
    // No energy source found
    return null;
}

/**
 * Cached lookup for structures of a given type (owned structures).
 * @param {Room} room - The room to query.
 * @param {StructureConstant} type - Structure type to find.
 * @param {string} cacheKey - Unique key for caching these structures.
 * @param {number} ttl - Time-to-live in ticks (default 10 ticks).
 * @returns {Structure[]} Array of structures of the given type.
 */
function getCachedStructures(room, type, cacheKey, ttl) {
    if (ttl === undefined) ttl = 10;
    if (!room.memory._cache) room.memory._cache = {};
    const now = Game.time;
    const entry = room.memory._cache[cacheKey];
    if (entry && now - entry.time < ttl) {
        return entry.ids.map(id => Game.getObjectById(id)).filter(s => s != null);
    }
    const structs = room.find(FIND_MY_STRUCTURES, {
        filter: s => s.structureType === type
    });
    room.memory._cache[cacheKey] = { ids: structs.map(s => s.id), time: now };
    return structs;
}

/**
 * Cached lookup for sources in a room.
 * Sources are static objects, so we cache them long-term.
 * @param {Room} room - The room to query.
 * @returns {Source[]} Array of source objects in the room.
 */
function getCachedSources(room) {
    if (!room.memory._cache) room.memory._cache = {};
    const cacheKey = 'sources';
    const ttl = 10000; // cache for a long time, sources don't move
    const now = Game.time;
    const entry = room.memory._cache[cacheKey];
    if (entry && now - entry.time < ttl) {
        return entry.ids.map(id => Game.getObjectById(id)).filter(s => s != null);
    }
    const sources = room.find(FIND_SOURCES);
    room.memory._cache[cacheKey] = { ids: sources.map(s => s.id), time: now };
    return sources;
}

/**
 * Cached lookup for construction sites in a room.
 * @param {Room} room - The room to query.
 * @returns {ConstructionSite[]} Array of construction site objects.
 */
function getCachedConstructionSites(room) {
    if (!room.memory._cache) room.memory._cache = {};
    const cacheKey = 'constructionSites';
    const ttl = 50; // refresh periodically (sites can change)
    const now = Game.time;
    const entry = room.memory._cache[cacheKey];
    if (entry && now - entry.time < ttl) {
        return entry.ids.map(id => Game.getObjectById(id)).filter(site => site != null);
    }
    const sites = room.find(FIND_CONSTRUCTION_SITES);
    room.memory._cache[cacheKey] = { ids: sites.map(site => site.id), time: now };
    return sites;
}

/**
 * Cached lookup for dropped energy resources in a room.
 * @param {Room} room - The room to query.
 * @returns {Resource[]} Array of dropped energy Resource objects.
 */
function getCachedDroppedEnergy(room) {
    if (!room.memory._cache) room.memory._cache = {};
    const cacheKey = 'droppedEnergy';
    const ttl = 5; // refresh very frequently due to volatility
    const now = Game.time;
    const entry = room.memory._cache[cacheKey];
    if (entry && now - entry.time < ttl) {
        return entry.ids.map(id => Game.getObjectById(id)).filter(res => res != null);
    }
    const drops = room.find(FIND_DROPPED_RESOURCES, {
        filter: r => r.resourceType === RESOURCE_ENERGY
    });
    room.memory._cache[cacheKey] = { ids: drops.map(res => res.id), time: now };
    return drops;
}

module.exports = {
    makeHarvesterBody: makeHarvesterBody,
    makeWorkerBody: makeWorkerBody,
    getEnergySource: getEnergySource,
    getCachedStructures: getCachedStructures,
    getCachedSources: getCachedSources,
    getCachedConstructionSites: getCachedConstructionSites,
    getCachedDroppedEnergy: getCachedDroppedEnergy,

    /**
     * Build a hauler body (focused on CARRY and MOVE parts).
     */
    makeHaulerBody: function (energy) {
        const maxCost = 1600;
        const actualEnergy = Math.min(energy, maxCost);
        const numParts = Math.floor(actualEnergy / 100);
        const body = [];
        for (let i = 0; i < numParts; i++) {
            body.push(CARRY);
            body.push(MOVE);
        }
        return body;
    },

    /**
     * Build a warrior body (melee fighter).
     * Pattern: primarily TOUGH parts, some MOVE, and a couple ATTACK parts.
     * Optimal full composition is 38 TOUGH, 10 MOVE, 2 ATTACK (50 parts total).
     */
    makeWarriorBody: function (energy) {
        // Minimum viable warrior
        if (energy < 260) {
            return [TOUGH, MOVE, MOVE, ATTACK, ATTACK];
        }
        // Optimal composition if energy allows (1040 energy)
        if (energy >= 1040) {
            const body = [];
            for (let i = 0; i < 38; i++) body.push(TOUGH);
            for (let i = 0; i < 10; i++) body.push(MOVE);
            body.push(ATTACK, ATTACK);
            return body;
        }
        // Scale-down logic for intermediate energy levels
        const body = [];
        let remainingEnergy = energy;
        const reservedEnergy = 160 + 100; // reserve for 2 ATTACK and 2 MOVE
        const availableForTough = remainingEnergy - reservedEnergy;
        // TOUGH parts (up to 38)
        const toughCount = Math.min(38, Math.floor(availableForTough / 10));
        for (let i = 0; i < toughCount; i++) {
            body.push(TOUGH);
        }
        // Consume energy for TOUGH and reserved parts
        remainingEnergy -= toughCount * 10;
        // MOVE parts (up to 10)
        remainingEnergy -= 160; // account for reserved 2 ATTACK + 2 MOVE
        const moveCount = Math.min(10, Math.floor(remainingEnergy / 50));
        for (let i = 0; i < moveCount; i++) {
            body.push(MOVE);
        }
        // Always add 2 ATTACK at the end
        body.push(ATTACK, ATTACK);
        return body;
    },

    /**
     * Build a ranged attacker body.
     * Pattern: mixture of TOUGH and RANGED_ATTACK parts with equal MOVE support.
     */
    makeRangedBody: function (energy) {
        if (energy < 300) {
            return [RANGED_ATTACK, RANGED_ATTACK, MOVE, MOVE];
        }
        const maxCost = 3000;
        const actualEnergy = Math.min(energy, maxCost);
        let remainingEnergy = actualEnergy - 300; // allocate base for 2 RANGED_ATTACK + 2 MOVE
        const body = [];
        // Add TOUGH parts first (up to 40 parts or as allowed by energy)
        while (remainingEnergy >= 60 && body.length < 40) {
            body.push(TOUGH);
            remainingEnergy -= 10;
        }
        // Base 2 RANGED_ATTACK
        body.push(RANGED_ATTACK, RANGED_ATTACK);
        // Add more RANGED_ATTACK parts if possible (up to 20 total)
        while (remainingEnergy >= 150 && body.filter(p => p === RANGED_ATTACK).length < 20) {
            body.push(RANGED_ATTACK);
            remainingEnergy -= 150;
        }
        // Add MOVE parts equal to total parts count (to keep speed)
        const totalParts = body.length;
        for (let i = 0; i < totalParts && body.length < 50; i++) {
            body.push(MOVE);
        }
        return body;
    },

    /**
     * Build a healer body.
     * Pattern: some TOUGH upfront, followed by HEAL/MOVE pairs.
     */
    makeHealerBody: function (energy) {
        if (energy < 500) {
            return [HEAL, HEAL, MOVE, MOVE];
        }
        const maxCost = 3000;
        const actualEnergy = Math.min(energy, maxCost);
        let remainingEnergy = actualEnergy;
        const body = [];
        // Add a few TOUGH parts for survivability (max 10)
        while (remainingEnergy >= 60 && body.length < 10) {
            body.push(TOUGH);
            remainingEnergy -= 10;
        }
        // Add HEAL and matching MOVE parts
        let healCount = 0;
        while (remainingEnergy >= 300 && healCount < 20 && body.length < 45) {
            body.push(HEAL);
            healCount++;
            remainingEnergy -= 250;
        }
        for (let i = 0; i < healCount && body.length < 50; i++) {
            body.push(MOVE);
        }
        // Ensure at least 2 HEAL parts (with 2 MOVE)
        const currentHealParts = body.filter(p => p === HEAL).length;
        if (currentHealParts < 2) {
            return [HEAL, HEAL, MOVE, MOVE];
        }
        return body;
    },

    /**
     * Smart move with traffic management.
     */
    smartMove: function (creep, target) {
        // Basic stuck detection
        if (creep.memory._moveTime === Game.time - 1) {
            if (creep.pos.x === creep.memory._lastX && creep.pos.y === creep.memory._lastY) {
                creep.memory._stuckCount = (creep.memory._stuckCount || 0) + 1;
            } else {
                creep.memory._stuckCount = 0;
            }
        } else {
            creep.memory._stuckCount = 0;
        }

        creep.memory._moveTime = Game.time;
        creep.memory._lastX = creep.pos.x;
        creep.memory._lastY = creep.pos.y;

        const opts = { visualizePathStyle: { stroke: '#ffffff' } };

        // Traffic Management / Way Identification
        if (creep.memory._stuckCount >= 2) {
            opts.reusePath = 0;
            opts.ignoreCreeps = false;

            const blockers = creep.pos.findInRange(FIND_MY_CREEPS, 1);
            if (blockers.length > 0) {
                creep.say('⛔ move');

                if (creep.memory._stuckCount >= 5) {
                    const r = Math.ceil(Math.random() * 8);
                    creep.move(r);
                    creep.memory._stuckCount = 0;
                    return;
                }
            }
        } else {
            opts.reusePath = 10;
            opts.ignoreCreeps = true;
        }

        creep.moveTo(target, opts);
    }
};
