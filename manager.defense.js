var MainUtil = require('./main.util');
var MainCache = require('./main.cache');
var info = require('./main.info');
var config = require('./main.config').DEFENSE;
var RemoteManager = require('./manager.remote');

class DefenseManager {

    static runAll() {
        var defendedRooms = new Set();
        MainUtil.findAllRooms().forEach(room => {
            if (!room.memory.base) return;
            defendedRooms.add(room.name);
            this._runRoom(room);
        });
        RemoteManager.getConfiguredOutposts().forEach(mission => {
            var room = Game.rooms[mission.targetRoom];
            if (!room || defendedRooms.has(room.name)) return;
            defendedRooms.add(room.name);
            this._runRoom(room, { outpost: true, mission: mission });
        });
    }

    static _runRoom(room, options = {}) {
        try {
            new DefenseManager(room, options).run();
        } catch (error) {
            info.error('Could not run defense for ' + room.name + ': ' + error, room);
            console.log(error.stack);
        }
    }

    constructor(room, options = {}) {
        this._room = room;
        this._outpost = !!options.outpost;
        this._mission = options.mission || null;
        this._memory = this._fetchMemory();
    }

    _fetchMemory() {
        var defaultData = {
            threatLevel: 0,
            lastNotification: null,
            alarmTicks: 0,
            desiredDefenders: 0,
        };
        if (this._room.memory.defense) {
            this._room.memory.defense = Object.assign(defaultData, this._room.memory.defense);
        } else {
            this._room.memory.defense = defaultData;
        }
        return this._room.memory.defense;
    }

    run() {
        var hostiles = MainCache.find(this._room, FIND_HOSTILE_CREEPS);
        var hostileStructures = MainCache.find(this._room, FIND_HOSTILE_STRUCTURES);
        var report = this._assessThreat(hostiles, hostileStructures);
        this._memory.threatLevel = report.level;
        this._memory.threatScore = report.score;
        this._memory.primaryTargetId = report.primaryTarget ? report.primaryTarget.id : null;

        if (report.level > 0) {
            this._memory.alarmTicks++;
            this._handleAlerts(report);
            this._coordinateDefenders(report);
            if (!this._outpost) this._evaluateSafeMode(report, hostiles);
        } else {
            this._memory.alarmTicks = 0;
            this._standDownDefenders();
        }
        if (this._outpost && this._mission) {
            this._mission.defense = {
                threatLevel: report.level,
                threatScore: report.score,
                primaryTargetId: this._memory.primaryTargetId,
                desiredDefenders: this._memory.desiredDefenders,
                preferredStyle: this._memory.preferredStyle || report.preferredStyle,
                updated: Game.time,
            };
        }
    }

    _assessThreat(hostiles, hostileStructures = []) {
        if (hostiles.length === 0 && hostileStructures.length === 0) {
            return { level: 0, score: 0, primaryTarget: null, healerCount: 0, preferredStyle: 'melee' };
        }

        var totalScore = 0;
        var healerCount = 0;
        var corePositions = MainCache.find(this._room, FIND_MY_SPAWNS).map(spawn => spawn.pos);
        if (this._room.storage) corePositions.push(this._room.storage.pos);

        var scoredHostiles = hostiles.map(hostile => {
            var healParts = hostile.getActiveBodyparts(HEAL);
            var attackParts = hostile.getActiveBodyparts(ATTACK);
            var rangedParts = hostile.getActiveBodyparts(RANGED_ATTACK);
            var workParts = hostile.getActiveBodyparts(WORK);
            if (healParts > 0) healerCount++;

            var score = DefenseManager._getThreatScore(hostile);
            if (corePositions.length > 0) {
                var minRange = Math.min(...corePositions.map(position => hostile.pos.getRangeTo(position)));
                score += Math.max(0, (config.PROXIMITY_RANGE - minRange) * config.PROXIMITY_WEIGHT);
            }
            totalScore += score;
            return { creep: hostile, score, healParts, attackParts, rangedParts, workParts };
        });
        var scoredStructures = hostileStructures.map(structure => {
            var score = DefenseManager._getThreatScore(structure);
            totalScore += score;
            return { creep: structure, score, healParts: 0, attackParts: 0, rangedParts: 0, workParts: 0 };
        });
        var scoredTargets = scoredHostiles.concat(scoredStructures).sort((a, b) => b.score - a.score);

        var primary = scoredTargets[0];
        var level = 1;
        if (totalScore >= config.LEVEL_2_SCORE || scoredTargets.some(hostile => hostile.attackParts > 0 || hostile.rangedParts > 0 || hostile.healParts > 0)) {
            level = 2;
        }
        if (corePositions.length > 0 && primary.workParts + primary.attackParts + primary.rangedParts + primary.healParts > 0) {
            var closestCore = Math.min(...corePositions.map(position => primary.creep.pos.getRangeTo(position)));
            if (closestCore <= config.LEVEL_3_CORE_RANGE) level = 3;
        }

        return {
            level,
            score: totalScore,
            primaryTarget: primary.creep,
            healerCount,
            preferredStyle: primary.rangedParts > 0 ? 'ranged' : 'melee',
        };
    }

    _handleAlerts(report) {
        if (report.level < config.DEFENDER_THREAT_LEVEL) return;
        var now = Game.time;
        var last = this._memory.lastNotification;
        if (last && now - last < config.ALERT_INTERVAL) return;
        this._memory.lastNotification = now;
        var message = '🛡️ [DEFENSE ALERT] Invasion in ' + this._room.name + ' at tick ' + now +
            '! Threat Level: ' + report.level + ', Threat Score: ' + report.score;
        Game.notify(message);
        info.error(message, this._room);
    }

    _coordinateDefenders(report) {
        var desired = report.level >= config.DEFENDER_THREAT_LEVEL || (this._outpost && report.level > 0) ? (report.score > config.SECOND_DEFENDER_SCORE ? 2 : 1) : 0;
        this._memory.desiredDefenders = Math.min(config.MAX_LOCAL_DEFENDERS, desired);
        var baseName = this._outpost ? this._mission.home : this._room.memory.base.name;
        var defenders = MainCache.getCreepsByHome(baseName).filter(creep => {
            return creep.memory.role === 'Defender' && (!this._outpost || creep.memory.missionId === this._mission.id);
        });
        this._memory.preferredStyle = report.healerCount > 0 && defenders.length > 0 ? 'support' : report.preferredStyle;
    }

    _standDownDefenders() {
        this._memory.desiredDefenders = 0;
    }

    _evaluateSafeMode(report, hostiles) {
        var controller = this._room.controller;
        if (!controller || !controller.my || controller.safeMode || controller.safeModeCooldown || !controller.safeModeAvailable) return;
        if (report.level !== 3) return;

        var criticalStructures = MainCache.find(this._room, FIND_MY_SPAWNS).slice();
        if (this._room.storage) criticalStructures.push(this._room.storage);
        var breachedStructure = criticalStructures.find(structure => {
            return hostiles.some(hostile => this._isDangerous(hostile) && hostile.pos.inRangeTo(structure, config.SAFE_MODE_BREACH_RANGE));
        });
        if (!breachedStructure || !this._isVulnerable(breachedStructure)) return;
        if (this._hasAdequateDefense(report)) return;

        var result = controller.activateSafeMode();
        var message = '🚨 [SAFE MODE] Room ' + this._room.name + ' activation result: ' + result;
        if (result === OK) {
            Game.notify(message);
            info.error(message, this._room);
        } else {
            info.warning(message, this._room);
        }
    }

    _isDangerous(creep) {
        return creep.getActiveBodyparts(ATTACK) + creep.getActiveBodyparts(RANGED_ATTACK) + creep.getActiveBodyparts(WORK) > 0;
    }

    _isVulnerable(structure) {
        var coveringRampart = MainCache.find(this._room, FIND_MY_STRUCTURES, {
            filter: candidate => candidate.structureType === STRUCTURE_RAMPART &&
                candidate.pos.x === structure.pos.x && candidate.pos.y === structure.pos.y && candidate.hits >= config.SAFE_RAMPART_HITS
        });
        return coveringRampart.length === 0;
    }

    _hasAdequateDefense(report) {
        var towers = MainCache.find(this._room, FIND_MY_STRUCTURES, {
            filter: structure => structure.structureType === STRUCTURE_TOWER
        });
        if (DefenseManager.getTowerPlan(this._room, towers).target) return true;
        var defenderPower = MainCache.find(this._room, FIND_MY_CREEPS, {
            filter: creep => creep.memory.role === 'Defender'
        }).reduce((sum, creep) => {
            return sum + creep.getActiveBodyparts(ATTACK) * config.DEFENDER_POWER.attack +
                creep.getActiveBodyparts(RANGED_ATTACK) * config.DEFENDER_POWER.ranged + creep.getActiveBodyparts(HEAL) * config.DEFENDER_POWER.heal;
        }, 0);
        return defenderPower > 0 && defenderPower >= report.score;
    }

    static getPriorityTarget(room) {
        var hostiles = MainCache.find(room, FIND_HOSTILE_CREEPS);
        var hostileStructures = MainCache.find(room, FIND_HOSTILE_STRUCTURES);
        var targets = hostiles.concat(hostileStructures);
        if (room.memory.defense && room.memory.defense.primaryTargetId) {
            var saved = Game.getObjectById(room.memory.defense.primaryTargetId);
            if (saved) {
                var current = targets.find(hostile => hostile.id === saved.id &&
                    (hostile.room.name === room.name || hostile.pos.roomName === room.name));
                if (current) return current;
            }
        }
        return targets[0] || null;
    }

    static getTowerPlan(room, towers) {
        var hostiles = MainCache.find(room, FIND_HOSTILE_CREEPS).concat(MainCache.find(room, FIND_HOSTILE_STRUCTURES));
        var priority = this.getPriorityTarget(room);
        var candidates = hostiles.slice().sort((a, b) => {
            if (a === b) return 0;
            if (a === priority) return -1;
            if (b === priority) return 1;
            return this._getThreatScore(b) - this._getThreatScore(a);
        });

        for (var candidate of candidates) {
            var attackers = towers.filter(tower => {
                return tower.store.getUsedCapacity(RESOURCE_ENERGY) >= TOWER_ENERGY_COST;
            });
            if (attackers.length === 0) continue;
            var damage = attackers.reduce((sum, tower) => sum + this._estimateTowerDamage(tower, candidate), 0);
            var healing = this._estimateHealing(candidate, hostiles);
            if (damage > healing) return { target: candidate, attackers };
        }
        return { target: null, attackers: [] };
    }

    static _getThreatScore(creep) {
        if (!creep.getActiveBodyparts) return creep.structureType === STRUCTURE_INVADER_CORE ? config.INVADER_CORE_SCORE : config.HOSTILE_STRUCTURE_SCORE;
        var weights = config.THREAT_WEIGHTS;
        var score = creep.getActiveBodyparts(HEAL) * weights.heal +
            creep.getActiveBodyparts(RANGED_ATTACK) * weights.ranged +
            creep.getActiveBodyparts(ATTACK) * weights.attack +
            creep.getActiveBodyparts(WORK) * weights.work;
        return creep.body.some(part => !!part.boost) ? score * config.BOOSTED_THREAT_MULTIPLIER : score;
    }

    static _estimateTowerDamage(tower, target) {
        var range = tower.pos.getRangeTo(target);
        if (range <= TOWER_OPTIMAL_RANGE) return TOWER_POWER_ATTACK;
        if (range >= TOWER_FALLOFF_RANGE) return TOWER_POWER_ATTACK * (1 - TOWER_FALLOFF);
        return TOWER_POWER_ATTACK * (1 - TOWER_FALLOFF * (range - TOWER_OPTIMAL_RANGE) / (TOWER_FALLOFF_RANGE - TOWER_OPTIMAL_RANGE));
    }

    static _estimateHealing(target, hostiles) {
        return hostiles.filter(hostile => hostile.getActiveBodyparts && hostile.pos.inRangeTo(target.pos, 3)).reduce((sum, healer) => {
            var adjacent = healer.pos.inRangeTo(target.pos, 1);
            var power = adjacent ? HEAL_POWER : RANGED_HEAL_POWER;
            var effect = adjacent ? 'heal' : 'rangedHeal';
            return sum + healer.body.reduce((healing, part) => {
                if (part.type !== HEAL || part.hits === 0) return healing;
                return healing + power * this._getHealBoost(part, effect);
            }, 0);
        }, 0);
    }

    static _getHealBoost(part, effect) {
        var boost = part.boost && BOOSTS[HEAL] && BOOSTS[HEAL][part.boost];
        return boost && boost[effect] || 1;
    }
}

module.exports = DefenseManager;
