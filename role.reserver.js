var RolePrototype = require('./role.prototype');
var RemoteManager = require('./manager.remote');

class Reserver extends RolePrototype {

    constructor() {
        super('Reserver', '#cc99ff', '🔐');
        this.priority = -15;
        this._disableAutomaticLoot = true;
    }

    isNecessary(room) {
        return false;
    }

    spawnCreep(spawn) {
        return false;
    }

    _work(creep) {
        if (creep.memory.retiring) {
            this._returnHome(creep);
            return;
        }
        var destination = creep.memory.controllerPos || { roomName: creep.memory.targetRoom, x: 25, y: 25 };
        if (!this._moveToRoom(creep, destination)) return;
        var controller = creep.room.controller;
        if (!controller) return;

        if (!this.canReserveController(creep, controller)) {
            creep.memory.reservationBlocked = true;
            creep.memory.retiring = true;
            RemoteManager.blacklistMission(creep.memory.missionId, 'hostile controller', RemoteManager.PLAYER_BLACKLIST_TICKS);
            return;
        }

        var result = creep.reserveController(controller);
        if (result === ERR_NOT_IN_RANGE) this._moveToLocation(creep, controller);
    }

    canReserveController(creep, controller) {
        if (!controller || (controller.owner && !controller.my)) return false;
        if (!controller.reservation || !controller.reservation.username) return true;
        var username = creep.owner && creep.owner.username || Game.player && Game.player.username;
        return !!username && controller.reservation.username === username;
    }

    _returnHome(creep) {
        var destination = creep.memory.homePos || { roomName: creep.memory.homeRoom, x: 25, y: 25 };
        if (this._moveToRoom(creep, destination)) creep.memory.selfdestruct = true;
    }
}

module.exports = Reserver;
