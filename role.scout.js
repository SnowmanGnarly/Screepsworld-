var RolePrototype = require('./role.prototype');
var IntelManager = require('./manager.intel');

class Scout extends RolePrototype {

    constructor() {
        super('Scout', '#66ccff', '🔭');
        this._disableAutomaticLoot = true;
    }

    isNecessary(room) {
        return false;
    }

    spawnCreep(spawn) {
        return false;
    }

    _work(creep) {
        if (creep.memory.phase === 'return' || !creep.memory.targetRoom) {
            this._returnHome(creep);
            return;
        }
        var destination = creep.memory.targetPos || { roomName: creep.memory.targetRoom, x: 25, y: 25 };
        if (!this._moveToRoom(creep, destination)) return;

        IntelManager.observeScout(creep);
        creep.memory.scoutedAt = Game.time;
        if (destination.x !== undefined && (creep.pos.x !== destination.x || creep.pos.y !== destination.y)) {
            this._moveToLocation(creep, new RoomPosition(destination.x, destination.y, creep.room.name));
            return;
        }
        creep.memory.phase = 'return';
    }

    _returnHome(creep) {
        var homeRoom = creep.memory.homeRoom;
        if (!homeRoom) return;
        var destination = creep.memory.homePos || { roomName: homeRoom, x: 25, y: 25 };
        if (this._moveToRoom(creep, destination)) {
            creep.memory.selfdestruct = true;
        }
    }
}

module.exports = Scout;
