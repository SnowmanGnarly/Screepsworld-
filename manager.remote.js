var MainCache = require('./main.cache');
var MainUtil = require('./main.util');
var IntelManager = require('./manager.intel');
var RoadManager = require('./manager.road');
var info = require('./main.info');

class RemoteManager {

    static runAll(allowExpensive = true) {
        IntelManager.ensureMemory();
        this._importExplicitConfigurations();
        this.getRemoteMissions().forEach(mission => {
            try {
                this._normalizeMission(mission);
                this._refreshMission(mission);
                this._updateROI(mission);
                if (allowExpensive) this._planConstruction(mission);
            } catch (error) {
                info.error('Could not run remote mission ' + mission.id + ': ' + error);
            }
        });
    }

    static configure(home, targetRoom, options = {}) {
        if (!home || !targetRoom || typeof home !== 'string' || typeof targetRoom !== 'string') return false;
        var empire = IntelManager.ensureMemory();
        var id = options.id || 'remote:' + home + ':' + targetRoom;
        if (!empire.missions[id] && Object.keys(empire.missions).length >= IntelManager.MAX_MISSIONS) return false;
        var defaults = {
            id: id,
            type: 'remote',
            home: home,
            targetRoom: targetRoom,
            enabled: true,
            status: 'active',
            created: Game.time,
            maxDistance: RemoteManager.DEFAULT_MAX_DISTANCE,
            maxHaulers: RemoteManager.DEFAULT_MAX_HAULERS,
            maxSites: RemoteManager.DEFAULT_MAX_SITES,
            reserve: true,
        };
        var mission = Object.assign(defaults, empire.missions[id] || {}, options, {
            id: id,
            type: 'remote',
            home: home,
            targetRoom: targetRoom,
        });
        mission.maxDistance = this._clamp(mission.maxDistance, 1, 10, RemoteManager.DEFAULT_MAX_DISTANCE);
        mission.maxHaulers = this._clamp(mission.maxHaulers, 0, RemoteManager.MAX_HAULERS_PER_OUTPOST, RemoteManager.DEFAULT_MAX_HAULERS);
        mission.maxSites = this._clamp(mission.maxSites, 0, RemoteManager.MAX_SITES_PER_OUTPOST, RemoteManager.DEFAULT_MAX_SITES);
        empire.missions[id] = mission;
        this._normalizeMission(mission);
        return mission;
    }

    static _importExplicitConfigurations() {
        MainUtil.findAllRooms().forEach(room => {
            if (!room.memory.base || !room.memory.base.name) return;
            var base = room.memory.base;
            var remoteConfig = base.remote && typeof base.remote === 'object' ? base.remote : {};
            var entries = [];
            if (Array.isArray(base.remoteRooms)) entries = entries.concat(base.remoteRooms);
            else if (base.remoteRooms && typeof base.remoteRooms === 'object') {
                Object.keys(base.remoteRooms).forEach(targetRoom => {
                    entries.push(Object.assign({ targetRoom: targetRoom }, base.remoteRooms[targetRoom]));
                });
            }
            if (Array.isArray(remoteConfig.rooms)) entries = entries.concat(remoteConfig.rooms);
            entries.forEach(entry => {
                var targetRoom = typeof entry === 'string' ? entry : entry && (entry.targetRoom || entry.room || entry.name);
                if (!targetRoom) return;
                var options = typeof entry === 'object' ? Object.assign({}, remoteConfig, entry) : Object.assign({}, remoteConfig);
                delete options.rooms;
                options.homeRoom = room.name;
                this.configure(base.name, targetRoom, options);
            });
        });
        this._importFlags();
    }

    static _importFlags() {
        var baseRooms = MainUtil.findAllRooms().filter(room => room.memory.base && room.memory.base.name);
        MainUtil.findAllFlags().forEach(flag => {
            if (!/^remote(?:$|:)/i.test(flag.name)) return;
            var parts = flag.name.split(':');
            var home = null;
            var targetRoom = flag.pos.roomName;
            var options = flag.memory && typeof flag.memory === 'object' ? Object.assign({}, flag.memory) : {};
            if (parts.length >= 3) {
                home = parts[1];
                targetRoom = parts[2];
            } else if (parts.length === 2) {
                var matchingBase = baseRooms.find(room => room.memory.base.name === parts[1]);
                if (matchingBase) home = parts[1];
                else targetRoom = parts[1];
            }
            if (options.targetRoom) targetRoom = options.targetRoom;
            if (options.home) home = options.home;
            if (!home) {
                var candidates = baseRooms.map(room => ({
                    room: room,
                    distance: this._getDistance(room.name, targetRoom),
                })).filter(entry => entry.distance !== null && entry.distance <= (options.maxDistance || RemoteManager.DEFAULT_MAX_DISTANCE));
                candidates.sort((a, b) => a.distance - b.distance || a.room.name.localeCompare(b.room.name));
                if (candidates.length > 0) home = candidates[0].room.memory.base.name;
            }
            if (!home || !targetRoom) return;
            var homeRoom = baseRooms.find(room => room.memory.base.name === home);
            options.homeRoom = homeRoom ? homeRoom.name : options.homeRoom;
            this.configure(home, targetRoom, options);
        });
    }

    static getRemoteMissions() {
        var empire = IntelManager.ensureMemory();
        return Object.keys(empire.missions).map(id => empire.missions[id]).filter(mission => {
            return mission && mission.type === 'remote' && mission.home && mission.targetRoom;
        }).sort((a, b) => a.id.localeCompare(b.id));
    }

    static getMission(missionId) {
        if (!missionId) return null;
        return IntelManager.ensureMemory().missions[missionId] || null;
    }

    static getConfiguredOutposts() {
        return this.getRemoteMissions().filter(mission => mission.enabled !== false);
    }

    static _normalizeMission(mission) {
        mission.enabled = mission.enabled !== false;
        mission.status = mission.status || 'active';
        mission.maxDistance = this._clamp(mission.maxDistance, 1, 10, RemoteManager.DEFAULT_MAX_DISTANCE);
        mission.maxHaulers = this._clamp(mission.maxHaulers, 0, RemoteManager.MAX_HAULERS_PER_OUTPOST, RemoteManager.DEFAULT_MAX_HAULERS);
        mission.maxSites = this._clamp(mission.maxSites, 0, RemoteManager.MAX_SITES_PER_OUTPOST, RemoteManager.DEFAULT_MAX_SITES);
        mission.sources = Array.isArray(mission.sources) ? mission.sources.slice(0, 8) : [];
        mission.defense = Object.assign({ threatLevel: 0, desiredDefenders: 0 }, mission.defense || {});
        mission.stats = Object.assign({
            energyHarvested: 0,
            energyDelivered: 0,
            energySpent: 0,
            repairCost: 0,
            defenseCost: 0,
            windowStarted: mission.created || Game.time,
            lastROIUpdate: 0,
            roi: 0,
            negativeEvaluations: 0,
        }, mission.stats || {});
        Object.keys(mission.stats).forEach(key => {
            if (typeof mission.stats[key] === 'number') {
                mission.stats[key] = this._clamp(mission.stats[key], -RemoteManager.MAX_METRIC, RemoteManager.MAX_METRIC, 0);
            }
        });
        if (!mission.homeRoom) {
            var homeRoom = MainUtil.findAllRooms().find(room => room.memory.base && room.memory.base.name === mission.home);
            mission.homeRoom = homeRoom ? homeRoom.name : null;
        }
        return mission;
    }

    static _refreshMission(mission) {
        var intel = IntelManager.getIntel(mission.targetRoom);
        if (intel) {
            mission.sources = intel.sources.map(source => {
                var previous = mission.sources.find(candidate => candidate.id === source.id) || {};
                return {
                    id: source.id,
                    x: source.x,
                    y: source.y,
                    energyCapacity: source.energyCapacity || previous.energyCapacity || 0,
                    output: previous.output || 0,
                };
            });
            mission.controller = intel.controller;
            mission.lastIntel = intel.lastSeen;
        }
        var homeRoom = mission.homeRoom && Game.rooms[mission.homeRoom];
        mission.distance = homeRoom ? this._getDistance(homeRoom.name, mission.targetRoom) : null;
        mission.distanceValid = mission.distance !== null && mission.distance <= mission.maxDistance;
    }

    static _isOperational(mission) {
        if (!mission || mission.enabled === false || !mission.distanceValid) return false;
        if (mission.status === 'blacklisted') {
            if (mission.blacklistedUntil && mission.blacklistedUntil <= Game.time) {
                mission.status = 'suspended';
                mission.suspendedUntil = Math.max(mission.suspendedUntil || 0, Game.time + RemoteManager.SUSPENSION_TICKS);
            }
            return false;
        }
        if (mission.status === 'suspended') {
            if (!mission.suspendedUntil || mission.suspendedUntil > Game.time) return false;
            mission.status = 'active';
            mission.suspensionReason = null;
        }
        return mission.status === 'active';
    }

    static getSpawnRequests(home, baseRoom) {
        var requests = [];
        this.getRemoteMissions().forEach(mission => {
            if (mission.home !== home) return;
            this._normalizeMission(mission);
            this._refreshMission(mission);
            if (!this._isOperational(mission)) return;
            this._addDefenseRequest(mission, requests);
            if (mission.defense.threatLevel >= 2) return;
            this._addScoutRequest(mission, requests);
            this._addReserverRequest(mission, requests);
            this._addEconomyRequests(mission, baseRoom, requests);
        });
        return requests.slice(0, RemoteManager.MAX_SPAWN_REQUESTS_PER_HOME);
    }

    static _addDefenseRequest(mission, requests) {
        var defense = mission.defense || {};
        var current = this._getMissionCreeps(mission, 'Defender').filter(creep => !creep.memory.retiring).length;
        var desired = this._clamp(defense.desiredDefenders, 0, RemoteManager.MAX_DEFENDERS_PER_OUTPOST, 0);
        if (current >= desired) return;
        var style = defense.preferredStyle || 'melee';
        var body = style === 'ranged' ? [RANGED_ATTACK, MOVE] : style === 'support' ? [HEAL, MOVE] : [ATTACK, ATTACK, MOVE, MOVE];
        requests.push(this._makeRequest(mission, 'Defender', 95, body, {
            targetPos: this._getControllerPos(mission),
        }, 'defense'));
    }

    static _addScoutRequest(mission, requests) {
        if (mission.sources.length > 0 && mission.lastIntel && Game.time - mission.lastIntel < RemoteManager.SCOUT_INTERVAL) return;
        var current = this._getMissionCreeps(mission, 'Scout').filter(creep => creep.memory.phase !== 'return').length;
        if (current > 0) return;
        requests.push(this._makeRequest(mission, 'Scout', 30, [MOVE], {
            targetPos: { roomName: mission.targetRoom, x: 25, y: 25 },
        }, 'scout'));
    }

    static _addReserverRequest(mission, requests) {
        if (!mission.reserve || mission.sources.length === 0) return;
        var controller = mission.controller;
        if (controller && controller.owner && !controller.my) return;
        var username = this._getOwnUsername(mission);
        if (controller && controller.reservation && controller.reservation.username !== username) return;
        if (controller && controller.reservation && controller.reservation.username === username &&
            controller.reservation.ticksToEnd >= RemoteManager.RESERVATION_THRESHOLD) return;
        if (this._getMissionCreeps(mission, 'Reserver').some(creep => !creep.memory.retiring)) return;
        requests.push(this._makeRequest(mission, 'Reserver', 75, [CLAIM, MOVE], {
            controllerPos: this._getControllerPos(mission),
        }, 'reserve'));
    }

    static _addEconomyRequests(mission, baseRoom, requests) {
        if (mission.sources.length === 0) return;
        var activeMiners = this._getMissionCreeps(mission, 'RemoteMiner');
        mission.sources.forEach(source => {
            var body = this.getMinerBody(mission, source);
            var current = activeMiners.filter(creep => {
                return (creep.memory.sourceId || creep.memory.source) === source.id &&
                    !this._needsReplacement(creep, mission, body);
            }).length;
            if (current > 0) return;
            requests.push(this._makeRequest(mission, 'RemoteMiner', 65, body, {
                sourceId: source.id,
                source: source.id,
                sourcePos: { roomName: mission.targetRoom, x: source.x, y: source.y },
            }, 'mine:' + source.id));
        });

        if (activeMiners.length === 0) return;
        var demand = this.calculateRouteDemand(mission, { baseRoom: baseRoom });
        var currentHaulers = this._getMissionCreeps(mission, 'RemoteHauler').filter(creep => {
            return !this._needsReplacement(creep, mission, demand.body);
        }).length;
        if (currentHaulers >= demand.haulers) return;
        var anchor = mission.sources[0];
        requests.push(this._makeRequest(mission, 'RemoteHauler', 60, demand.body, {
            sourcePos: { roomName: mission.targetRoom, x: anchor.x, y: anchor.y },
        }, 'haul'));
        mission.desired = Object.assign({}, mission.desired, demand);
    }

    static _makeRequest(mission, role, priority, body, memory, suffix) {
        var homePos = this._getHomePos(mission);
        return {
            id: mission.id + ':' + suffix,
            provider: 'remote',
            role: role,
            priority: priority,
            body: body.slice(),
            exactBody: body.slice(),
            home: mission.home,
            created: Game.time,
            memory: Object.assign({}, mission.creepMemory || {}, memory, {
                missionId: mission.id,
                targetRoom: mission.targetRoom,
                homeRoom: mission.homeRoom,
                homePos: homePos,
            }),
        };
    }

    static onSpawn(request, creep) {
        var mission = this.getMission(request.memory && request.memory.missionId);
        if (!mission) return;
        this._normalizeMission(mission);
        mission.stats.energySpent = this._boundedAdd(mission.stats.energySpent, this._bodyCost(request.body));
        mission.stats.totalSpawned = (mission.stats.totalSpawned || 0) + 1;
        if (request.role === 'RemoteMiner') {
            this._getMissionCreeps(mission, 'RemoteMiner').forEach(existing => {
                if (existing !== creep && (existing.memory.sourceId || existing.memory.source) === request.memory.sourceId) {
                    existing.memory.trainedReplacement = true;
                }
            });
        }
    }

    static _getMissionCreeps(mission, roleName) {
        return MainUtil.findAllCreeps().filter(creep => {
            return creep.memory.missionId === mission.id && (!roleName || creep.memory.role === roleName);
        });
    }

    static _needsReplacement(creep, mission, body) {
        if (creep.spawning) return false;
        if (creep.memory.trainedReplacement) return true;
        var leadTime = (mission.travelTicks || RemoteManager.DEFAULT_TRAVEL_TICKS) + body.length * 3 + RemoteManager.REPLACEMENT_BUFFER;
        return Number.isFinite(creep.ticksToLive) && creep.ticksToLive <= leadTime;
    }

    static getMinerBody(mission, source) {
        var reserved = mission.controller && mission.controller.reservation &&
            mission.controller.reservation.username === this._getOwnUsername(mission);
        var output = source.output || (source.energyCapacity ? source.energyCapacity / 300 : 0) || (reserved ? 10 : 5);
        var workParts = this._clamp(Math.ceil(output / 2), 3, 5, 3);
        var body = [];
        for (var index = 0; index < workParts; index++) body.push(WORK);
        body.push(CARRY, MOVE);
        return body;
    }

    static getHaulerBody(mission, baseRoom) {
        var homeRoom = baseRoom || mission.homeRoom && Game.rooms[mission.homeRoom];
        var energyCapacity = homeRoom && homeRoom.energyCapacityAvailable || 300;
        var configuredPairs = this._clamp(mission.haulerPairs, 1, 6, RemoteManager.DEFAULT_HAULER_PAIRS);
        var pairs = Math.max(1, Math.min(configuredPairs, Math.floor(energyCapacity / 150)));
        var body = [];
        for (var index = 0; index < pairs; index++) body.push(CARRY, CARRY, MOVE);
        return body;
    }

    static calculateRouteDemand(mission, context = {}) {
        this._normalizeMission(mission);
        var sources = context.sources || mission.sources;
        var reserved = mission.controller && mission.controller.reservation &&
            mission.controller.reservation.username === this._getOwnUsername(mission);
        var outputPerTick = sources.reduce((sum, source) => {
            var output = source.output || (source.energyCapacity ? source.energyCapacity / 300 : 0) || (reserved ? 10 : 5);
            return sum + this._clamp(output, 0, 20, 5);
        }, 0);
        var distance = mission.distance === null || mission.distance === undefined ? 1 : mission.distance;
        var travelTicks = this._clamp(context.travelTicks || mission.travelTicks || distance * 50,
            20, RemoteManager.MAX_TRAVEL_TICKS, RemoteManager.DEFAULT_TRAVEL_TICKS);
        var roundTripTicks = this._clamp(travelTicks * 2 + 20, 40, 1500, 120);
        var body = context.body || this.getHaulerBody(mission, context.baseRoom);
        var carryParts = body.filter(part => part === CARRY).length;
        var capacity = Math.max(50, carryParts * 50);
        var rawHaulers = outputPerTick > 0 ? Math.ceil(outputPerTick * roundTripTicks / capacity) : 0;
        var haulers = this._clamp(rawHaulers, 0, mission.maxHaulers, 0);
        return {
            miners: sources.length,
            haulers: haulers,
            outputPerTick: this._clamp(outputPerTick, 0, 100, 0),
            travelTicks: travelTicks,
            roundTripTicks: roundTripTicks,
            capacity: capacity,
            body: body,
        };
    }

    static getRouteDemand(mission, context = {}) {
        return this.calculateRouteDemand(mission, context);
    }

    static calculateHaulerDemand(mission, context = {}) {
        return this.calculateRouteDemand(mission, context).haulers;
    }

    static calculateNetROI(mission) {
        var stats = mission.stats || {};
        var net = (stats.energyDelivered || 0) - (stats.energySpent || 0) -
            (stats.repairCost || 0) - (stats.defenseCost || 0);
        return this._clamp(net, -RemoteManager.MAX_METRIC, RemoteManager.MAX_METRIC, 0);
    }

    static calculateROI(mission) {
        var stats = mission.stats || {};
        var elapsed = this._clamp(Game.time - (stats.windowStarted || mission.created || 0), 1, 5000, 1);
        return this._clamp(this.calculateNetROI(mission) / elapsed, -1000, 1000, 0);
    }

    static _updateROI(mission, force = false) {
        if (!force && Game.time - (mission.stats.lastROIUpdate || 0) < RemoteManager.ROI_INTERVAL) return;
        mission.stats.lastROIUpdate = Game.time;
        mission.stats.roi = this.calculateROI(mission);
        var age = Game.time - (mission.stats.windowStarted || mission.created || Game.time);
        if (age >= RemoteManager.ROI_MINIMUM_AGE && mission.stats.roi < -1) mission.stats.negativeEvaluations++;
        else mission.stats.negativeEvaluations = 0;
        if (mission.stats.negativeEvaluations >= 2 && mission.status === 'active') {
            this.suspendMission(mission.id, 'negative ROI', RemoteManager.SUSPENSION_TICKS);
            mission.stats.negativeEvaluations = 0;
        }
    }

    static recordEnergyHarvested(missionId, amount) {
        this._recordMetric(missionId, 'energyHarvested', amount);
    }

    static recordEnergyDelivered(missionId, amount) {
        this._recordMetric(missionId, 'energyDelivered', amount);
    }

    static _recordMetric(missionId, key, amount) {
        var mission = this.getMission(missionId);
        if (!mission || !Number.isFinite(amount) || amount <= 0) return;
        this._normalizeMission(mission);
        mission.stats[key] = this._boundedAdd(mission.stats[key], amount);
    }

    static recordMinerArrival(missionId, travelTicks, source) {
        var mission = this.getMission(missionId);
        if (!mission) return;
        mission.travelTicks = this._clamp(Math.max(mission.travelTicks || 0, travelTicks || 0),
            20, RemoteManager.MAX_TRAVEL_TICKS, RemoteManager.DEFAULT_TRAVEL_TICKS);
        var sourceMemory = mission.sources.find(candidate => candidate.id === source.id);
        if (sourceMemory && source.energyCapacity) sourceMemory.output = this._clamp(source.energyCapacity / 300, 0, 20, 5);
    }

    static suspendMission(missionId, reason, duration = RemoteManager.SUSPENSION_TICKS) {
        var mission = this.getMission(missionId);
        if (!mission) return false;
        duration = this._clamp(duration, 100, 10000, RemoteManager.SUSPENSION_TICKS);
        mission.status = 'suspended';
        mission.suspensionReason = reason || 'suspended';
        mission.suspendedUntil = Math.max(mission.suspendedUntil || 0, Game.time + duration);
        mission.updated = Game.time;
        return true;
    }

    static blacklistMission(missionId, reason, duration = RemoteManager.PLAYER_BLACKLIST_TICKS) {
        var mission = this.getMission(missionId);
        if (!mission) return false;
        duration = this._clamp(duration, 500, 20000, RemoteManager.PLAYER_BLACKLIST_TICKS);
        mission.status = 'blacklisted';
        mission.blacklistReason = reason || 'hostile outpost';
        mission.blacklistedAt = Game.time;
        mission.blacklistedUntil = Math.max(mission.blacklistedUntil || 0, Game.time + duration);
        mission.suspendedUntil = Math.max(mission.suspendedUntil || 0, mission.blacklistedUntil + RemoteManager.SUSPENSION_TICKS);
        mission.updated = Game.time;
        return true;
    }

    static _planConstruction(mission) {
        if (!this._isOperational(mission) || mission.maxSites === 0 || mission.defense.threatLevel >= 2) return;
        if (Game.time - (mission.lastConstructionPlan || 0) < RemoteManager.CONSTRUCTION_INTERVAL) return;
        var room = Game.rooms[mission.targetRoom];
        if (!room || mission.sources.length === 0) return;
        mission.lastConstructionPlan = Game.time;
        var sites = MainCache.find(room, FIND_CONSTRUCTION_SITES);
        if (sites.length >= mission.maxSites) return;
        var structures = MainCache.find(room, FIND_STRUCTURES);
        var occupied = new Set(structures.concat(sites).map(value => value.pos.x + ',' + value.pos.y));
        var created = 0;

        for (var source of mission.sources) {
            if (sites.length + created >= mission.maxSites) break;
            var hasContainer = structures.concat(sites).some(value => {
                return (value.structureType === STRUCTURE_CONTAINER || value.structureType === STRUCTURE_STORAGE) &&
                    value.pos.getRangeTo(source.x, source.y) <= 1;
            });
            if (hasContainer) continue;
            var position = this._findContainerPosition(room, source, occupied);
            if (position && this._createRemoteSite(room, position, STRUCTURE_CONTAINER)) {
                occupied.add(position.x + ',' + position.y);
                created++;
            }
        }

        if (sites.length + created >= mission.maxSites) return;
        var roadPositions = new RoadManager(room).fetchPositionsOverThreshold().slice(0, 10);
        for (var roadPosition of roadPositions) {
            var key = roadPosition.x + ',' + roadPosition.y;
            if (occupied.has(key)) continue;
            if (this._createRemoteSite(room, roadPosition, STRUCTURE_ROAD)) {
                occupied.add(key);
                created++;
                break;
            }
        }
    }

    static _findContainerPosition(room, source, occupied) {
        var terrain = room.getTerrain();
        for (var dx = -1; dx <= 1; dx++) {
            for (var dy = -1; dy <= 1; dy++) {
                if (dx === 0 && dy === 0) continue;
                var x = source.x + dx;
                var y = source.y + dy;
                if (x < 1 || x > 48 || y < 1 || y > 48 || occupied.has(x + ',' + y)) continue;
                if (terrain.get(x, y) === TERRAIN_MASK_WALL) continue;
                return new RoomPosition(x, y, room.name);
            }
        }
        return null;
    }

    static _createRemoteSite(room, position, structureType) {
        var result = position.createConstructionSite(structureType);
        if (result !== OK) return false;
        MainCache.invalidateRoom(room, FIND_CONSTRUCTION_SITES);
        MainCache.invalidateRoom(room, FIND_MY_CONSTRUCTION_SITES);
        return true;
    }

    static _getControllerPos(mission) {
        var controller = mission.controller;
        return controller && controller.x !== null && controller.x !== undefined ?
            { roomName: mission.targetRoom, x: controller.x, y: controller.y } :
            { roomName: mission.targetRoom, x: 25, y: 25 };
    }

    static _getHomePos(mission) {
        var room = mission.homeRoom && Game.rooms[mission.homeRoom];
        var anchor = room && (room.storage || MainCache.find(room, FIND_MY_SPAWNS)[0]);
        return anchor ? { roomName: room.name, x: anchor.pos.x, y: anchor.pos.y } :
            { roomName: mission.homeRoom, x: 25, y: 25 };
    }

    static _getOwnUsername(mission) {
        if (Game.player && Game.player.username) return Game.player.username;
        var room = mission.homeRoom && Game.rooms[mission.homeRoom];
        return room && room.controller && room.controller.owner && room.controller.owner.username || null;
    }

    static _getDistance(first, second) {
        if (!first || !second || !Game.map || !Game.map.getRoomLinearDistance) return null;
        var distance = Game.map.getRoomLinearDistance(first, second);
        return Number.isFinite(distance) ? distance : null;
    }

    static _bodyCost(body) {
        return (body || []).reduce((sum, part) => sum + (BODYPART_COST[part] || 0), 0);
    }

    static _boundedAdd(value, amount) {
        return this._clamp((Number.isFinite(value) ? value : 0) + amount, 0, RemoteManager.MAX_METRIC, 0);
    }

    static _clamp(value, minimum, maximum, fallback) {
        value = Number(value);
        if (value === Infinity) return maximum;
        if (value === -Infinity) return minimum;
        if (!Number.isFinite(value)) return fallback;
        return Math.max(minimum, Math.min(maximum, value));
    }
}

RemoteManager.DEFAULT_MAX_DISTANCE = 1;
RemoteManager.DEFAULT_MAX_HAULERS = 3;
RemoteManager.MAX_HAULERS_PER_OUTPOST = 4;
RemoteManager.DEFAULT_MAX_SITES = 2;
RemoteManager.MAX_SITES_PER_OUTPOST = 4;
RemoteManager.MAX_DEFENDERS_PER_OUTPOST = 2;
RemoteManager.MAX_SPAWN_REQUESTS_PER_HOME = 50;
RemoteManager.DEFAULT_TRAVEL_TICKS = 50;
RemoteManager.MAX_TRAVEL_TICKS = 600;
RemoteManager.REPLACEMENT_BUFFER = 20;
RemoteManager.DEFAULT_HAULER_PAIRS = 4;
RemoteManager.SCOUT_INTERVAL = 1000;
RemoteManager.RESERVATION_THRESHOLD = 1000;
RemoteManager.CONSTRUCTION_INTERVAL = 25;
RemoteManager.ROI_INTERVAL = 500;
RemoteManager.ROI_MINIMUM_AGE = 1500;
RemoteManager.SUSPENSION_TICKS = 1000;
RemoteManager.PLAYER_BLACKLIST_TICKS = 5000;
RemoteManager.MAX_METRIC = 1000000000;

module.exports = RemoteManager;
