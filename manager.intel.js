var MainCache = require('./main.cache');
var MainUtil = require('./main.util');
var info = require('./main.info');

class IntelManager {

    static ensureMemory() {
        if (!Memory.empire || typeof Memory.empire !== 'object' || Array.isArray(Memory.empire)) {
            Memory.empire = {};
        }
        var empire = Memory.empire;
        empire.version = IntelManager.EMPIRE_VERSION;
        empire.intel = this._normalizeMap(empire.intel, 'roomName');
        empire.missions = this._normalizeMap(empire.missions, 'id');
        empire.squads = this._normalizeMap(empire.squads, 'id');
        empire.alliances = this._normalizeMap(empire.alliances, 'id');
        empire.resourceRequests = this._normalizeMap(empire.resourceRequests, 'id');
        return empire;
    }

    static _normalizeMap(value, key) {
        if (Array.isArray(value)) {
            var converted = {};
            value.forEach((entry, index) => {
                if (!entry || typeof entry !== 'object') return;
                var id = entry[key] || entry.name || String(index);
                converted[id] = entry;
            });
            return converted;
        }
        return value && typeof value === 'object' ? value : {};
    }

    static runAll() {
        this.ensureMemory();
        MainUtil.findAllRooms().forEach(room => {
            try {
                this.observeRoom(room);
            } catch (error) {
                info.error('Could not observe room ' + room.name + ': ' + error, room);
            }
        });
        this.cleanup();
    }

    static observeRoom(room) {
        if (!room || !room.name) return null;
        var empire = this.ensureMemory();
        var previous = empire.intel[room.name] || {};
        var controller = room.controller;
        var observation = {
            roomName: room.name,
            lastSeen: Game.time,
            sources: MainCache.find(room, FIND_SOURCES).slice(0, IntelManager.MAX_SOURCES_PER_ROOM).map(source => ({
                id: source.id,
                x: source.pos.x,
                y: source.pos.y,
                energyCapacity: this._finiteNumber(source.energyCapacity, 0),
            })),
            controller: controller ? {
                id: controller.id || null,
                x: controller.pos ? controller.pos.x : null,
                y: controller.pos ? controller.pos.y : null,
                level: this._finiteNumber(controller.level, 0),
                my: !!controller.my,
                owner: controller.owner && controller.owner.username ? controller.owner.username : null,
                reservation: controller.reservation ? {
                    username: controller.reservation.username || null,
                    ticksToEnd: this._finiteNumber(controller.reservation.ticksToEnd, 0),
                } : null,
            } : null,
            hostiles: this._summarizeHostiles(MainCache.find(room, FIND_HOSTILE_CREEPS)),
            hostileStructures: MainCache.find(room, FIND_HOSTILE_STRUCTURES)
                .slice(0, IntelManager.MAX_STRUCTURES_PER_ROOM)
                .map(structure => ({
                    id: structure.id,
                    structureType: structure.structureType,
                    x: structure.pos.x,
                    y: structure.pos.y,
                    owner: structure.owner && structure.owner.username ? structure.owner.username : null,
                })),
        };
        Object.keys(previous).forEach(key => {
            if (observation[key] === undefined && key !== 'roomName' && key !== 'lastSeen') {
                observation[key] = previous[key];
            }
        });
        observation.stale = false;
        empire.intel[room.name] = observation;
        return observation;
    }

    static observeScout(creep) {
        if (!creep || !creep.room) return null;
        var observation = this.observeRoom(creep.room);
        if (observation && creep.memory && creep.memory.missionId) {
            var empire = this.ensureMemory();
            var mission = empire.missions[creep.memory.missionId];
            if (mission) mission.lastScouted = Game.time;
        }
        return observation;
    }

    static _summarizeHostiles(hostiles) {
        var summary = {
            count: hostiles.length,
            attack: 0,
            rangedAttack: 0,
            heal: 0,
            work: 0,
            npc: 0,
            players: 0,
        };
        hostiles.slice(0, IntelManager.MAX_HOSTILES_PER_ROOM).forEach(hostile => {
            if (hostile.getActiveBodyparts) {
                summary.attack += hostile.getActiveBodyparts(ATTACK);
                summary.rangedAttack += hostile.getActiveBodyparts(RANGED_ATTACK);
                summary.heal += hostile.getActiveBodyparts(HEAL);
                summary.work += hostile.getActiveBodyparts(WORK);
            }
            var owner = hostile.owner && hostile.owner.username;
            if (owner === 'Invader' || owner === 'Source Keeper') summary.npc++;
            else summary.players++;
        });
        return summary;
    }

    static getIntel(roomName) {
        return this.ensureMemory().intel[roomName] || null;
    }

    static cleanup() {
        var empire = this.ensureMemory();
        var activeRooms = this._getActiveRooms(empire);
        Object.keys(empire.intel).forEach(roomName => {
            var observation = empire.intel[roomName];
            if (!observation || typeof observation !== 'object') {
                delete empire.intel[roomName];
                return;
            }
            var age = Game.time - this._finiteNumber(observation.lastSeen, 0);
            if (age > IntelManager.INTEL_TTL) {
                if (activeRooms.has(roomName)) observation.stale = true;
                else delete empire.intel[roomName];
            }
        });
        this._boundMap(empire.intel, IntelManager.MAX_INTEL_ROOMS, activeRooms, 'lastSeen');

        Object.keys(empire.missions).forEach(id => {
            var mission = empire.missions[id];
            if (!mission || typeof mission !== 'object') {
                delete empire.missions[id];
                return;
            }
            if ((mission.status === 'complete' || mission.status === 'abandoned') &&
                Game.time - this._finiteNumber(mission.completedAt || mission.updated, 0) > IntelManager.MISSION_RETENTION) {
                delete empire.missions[id];
            }
        });
        this._boundMap(empire.missions, IntelManager.MAX_MISSIONS, null, 'created', true);

        Object.keys(empire.squads).forEach(id => {
            var squad = empire.squads[id];
            if (!squad || typeof squad !== 'object' || (squad.expiresAt !== undefined && squad.expiresAt < Game.time)) {
                delete empire.squads[id];
            }
        });
        this._boundMap(empire.squads, IntelManager.MAX_SQUADS, null, 'created', false);
        this._boundMap(empire.alliances, IntelManager.MAX_ALLIANCES, null, 'created', false);

        Object.keys(empire.resourceRequests).forEach(id => {
            var request = empire.resourceRequests[id];
            if (!request || typeof request !== 'object') {
                delete empire.resourceRequests[id];
                return;
            }
            var expired = Number.isFinite(request.expiresAt) && request.expiresAt <= Game.time;
            var finished = (request.status === 'complete' || request.status === 'cancelled' || request.status === 'expired') &&
                Game.time - this._finiteNumber(request.completedAt || request.updated, 0) > IntelManager.RESOURCE_REQUEST_RETENTION;
            if (expired || finished) delete empire.resourceRequests[id];
        });
        var requestKeys = Object.keys(empire.resourceRequests);
        if (requestKeys.length > IntelManager.MAX_RESOURCE_REQUESTS) {
            requestKeys.sort((a, b) => {
                var requestA = empire.resourceRequests[a];
                var requestB = empire.resourceRequests[b];
                return this._finiteNumber(requestA.priority, 0) - this._finiteNumber(requestB.priority, 0) ||
                    this._finiteNumber(requestA.created, 0) - this._finiteNumber(requestB.created, 0) || a.localeCompare(b);
            });
            while (requestKeys.length > 0 && Object.keys(empire.resourceRequests).length > IntelManager.MAX_RESOURCE_REQUESTS) {
                delete empire.resourceRequests[requestKeys.shift()];
            }
        }
        return empire;
    }

    static _getActiveRooms(empire) {
        var rooms = new Set();
        Object.keys(empire.missions).forEach(id => {
            var mission = empire.missions[id];
            if (!mission || mission.status === 'complete' || mission.status === 'abandoned') return;
            if (mission.targetRoom) rooms.add(mission.targetRoom);
        });
        Object.keys(Game.creeps || {}).forEach(name => {
            var memory = Game.creeps[name].memory || {};
            if (memory.targetRoom) rooms.add(memory.targetRoom);
        });
        return rooms;
    }

    static _boundMap(map, limit, protectedKeys, timeKey, protectActive) {
        var keys = Object.keys(map);
        if (keys.length <= limit) return;
        var protectedMap = protectedKeys || new Set();
        keys.sort((a, b) => {
            var aActive = protectActive && map[a] && map[a].status !== 'complete' && map[a].status !== 'abandoned';
            var bActive = protectActive && map[b] && map[b].status !== 'complete' && map[b].status !== 'abandoned';
            if (!!aActive !== !!bActive) return aActive ? 1 : -1;
            var aProtected = protectedMap.has(a) || (map[a] && protectedMap.has(map[a].targetRoom));
            var bProtected = protectedMap.has(b) || (map[b] && protectedMap.has(map[b].targetRoom));
            if (!!aProtected !== !!bProtected) return aProtected ? 1 : -1;
            return this._finiteNumber(map[a] && map[a][timeKey], 0) - this._finiteNumber(map[b] && map[b][timeKey], 0);
        });
        for (var index = 0; index < keys.length && Object.keys(map).length > limit; index++) {
            var key = keys[index];
            var active = protectActive && map[key] && map[key].status !== 'complete' && map[key].status !== 'abandoned';
            if (active || protectedMap.has(key) || (map[key] && protectedMap.has(map[key].targetRoom))) continue;
            delete map[key];
        }
    }

    static _finiteNumber(value, fallback) {
        return Number.isFinite(value) ? value : fallback;
    }
}

IntelManager.EMPIRE_VERSION = 1;
IntelManager.INTEL_TTL = 3000;
IntelManager.MISSION_RETENTION = 5000;
IntelManager.RESOURCE_REQUEST_RETENTION = 500;
IntelManager.MAX_RESOURCE_REQUESTS = 100;
IntelManager.MAX_INTEL_ROOMS = 100;
IntelManager.MAX_MISSIONS = 50;
IntelManager.MAX_SQUADS = 25;
IntelManager.MAX_ALLIANCES = 25;
IntelManager.MAX_SOURCES_PER_ROOM = 8;
IntelManager.MAX_STRUCTURES_PER_ROOM = 25;
IntelManager.MAX_HOSTILES_PER_ROOM = 50;

module.exports = IntelManager;
