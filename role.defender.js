/*
 * Defenders spawn on demand with melee, ranged, or healing support bodies.
 */

var MainCache = require('./main.cache');
var RolePrototype = require('./role.prototype');
var DefenseManager = require('./manager.defense');
var RemoteManager = require('./manager.remote');

class Defender extends RolePrototype {

    constructor() {
        super('Defender', '#ff0000', '🛡️');
        this.priority = 90;
    }

    isNecessary(room) {
        return room.memory.defense && room.memory.defense.threatLevel >= 2;
    }

    spawnCreep(spawn) {
        var style = spawn.room.memory.defense && spawn.room.memory.defense.preferredStyle;
        if (style === 'ranged') {
            return this._spawnCreepWithParts(spawn, [RANGED_ATTACK, MOVE]);
        }
        if (style === 'support') {
            return this._spawnCreepWithParts(spawn, [HEAL, MOVE]);
        }
        return this._spawnCreepWithParts(spawn, [TOUGH, ATTACK, MOVE, MOVE], [ATTACK, MOVE]);
    }

    _work(creep) {
        if (creep.memory.missionId && creep.memory.targetRoom) {
            this._workMission(creep);
            return;
        }
        this._workLocal(creep);
    }

    _workLocal(creep) {
        var threatLevel = creep.room.memory.defense && creep.room.memory.defense.threatLevel;
        if (!threatLevel) {
            creep.memory.selfdestruct = true;
            return;
        }

        if (creep.getActiveBodyparts(HEAL) > 0) {
            this._support(creep);
            return;
        }

        var target = DefenseManager.getPriorityTarget(creep.room);
        if (!target) return;
        this._attackTarget(creep, target);
    }

    _workMission(creep) {
        var mission = RemoteManager.getMission(creep.memory.missionId);
        var targetRoom = creep.memory.targetRoom;
        var target = creep.room.name === targetRoom ? DefenseManager.getPriorityTarget(creep.room) : null;
        var threatLevel = target ? 2 : mission && mission.defense && mission.defense.threatLevel || 0;
        if (creep.room.name === targetRoom && creep.room.memory.defense) {
            threatLevel = Math.max(threatLevel, creep.room.memory.defense.threatLevel || 0);
        }

        if (creep.memory.retreating || creep.hitsMax && creep.hits < creep.hitsMax / 2) {
            creep.memory.retreating = true;
            this._returnHome(creep, true);
            return;
        }
        if (!threatLevel) {
            this._returnHome(creep, false);
            return;
        }
        if (creep.room.name !== targetRoom) {
            this._moveToRoom(creep, creep.memory.targetPos || { roomName: targetRoom, x: 25, y: 25 });
            return;
        }

        if (creep.getActiveBodyparts(HEAL) > 0) {
            this._support(creep);
            return;
        }
        if (target) this._attackTarget(creep, target);
    }

    _attackTarget(creep, target) {
        var result = creep.getActiveBodyparts(RANGED_ATTACK) > 0 ? creep.rangedAttack(target) : creep.attack(target);
        if (result === ERR_NOT_IN_RANGE) this._moveToLocation(creep, target);
    }

    _returnHome(creep, retreating) {
        var homeRoom = creep.memory.homeRoom;
        var localThreat = creep.room.name === homeRoom && creep.room.memory.defense && creep.room.memory.defense.threatLevel;
        if (creep.room.name === homeRoom && localThreat && !retreating) {
            this._workLocal(creep);
            return;
        }
        var destination = creep.memory.homePos || { roomName: homeRoom, x: 25, y: 25 };
        if (this._moveToRoom(creep, destination)) {
            if (retreating && creep.getActiveBodyparts(HEAL) > 0 && creep.hits < creep.hitsMax) creep.heal(creep);
            creep.memory.selfdestruct = true;
        }
    }

    _support(creep) {
        var damagedCreeps = MainCache.find(creep.room, FIND_MY_CREEPS, {
            filter: creep => creep.hits < creep.hitsMax
        });
        if (damagedCreeps.length > 0) {
            var target = damagedCreeps.sort((a, b) => creep.pos.getRangeTo(a) - creep.pos.getRangeTo(b))[0];
            if (creep.heal(target) === ERR_NOT_IN_RANGE) {
                this._moveToLocation(creep, target);
            }
            return;
        }

        var target = DefenseManager.getPriorityTarget(creep.room);
        if (target && !creep.pos.inRangeTo(target, 3)) {
            this._moveToLocation(creep, target);
        }
    }
}

module.exports = Defender;
