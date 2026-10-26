/*
 * Defenders spawn on demand with melee, ranged, or healing support bodies.
 */

var MainCache = require('./main.cache');
var RolePrototype = require('./role.prototype');
var DefenseManager = require('./manager.defense');

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
        var result = creep.getActiveBodyparts(RANGED_ATTACK) > 0 ? creep.rangedAttack(target) : creep.attack(target);
        if (result === ERR_NOT_IN_RANGE) {
            this._moveToLocation(creep, target);
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
