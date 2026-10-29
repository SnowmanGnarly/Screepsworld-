var RolePrototype = require('./role.prototype');
var MineralManager = require('./manager.mineral');

class MineralMiner extends RolePrototype {

    constructor() {
        super('MineralMiner', '#888888', '⛏️');
        this.priority = -1;
        this._disableAutomaticLoot = true;
    }

    isNecessary(room) {
        return MineralManager.getDesiredMinerCount(room) > 0;
    }

    spawnCreep(spawn) {
        var state = MineralManager.getMiningState(spawn.room);
        if (!MineralManager.canHarvest(state)) return false;
        var resultingCreep = this._spawnCreepWithParts(spawn, [WORK], [MOVE, CARRY]);
        if (resultingCreep) {
            resultingCreep.memory.source = state.mineral.id;
            resultingCreep.memory.homeSpawn = spawn.name;
        }
        return resultingCreep;
    }

    _getPartsMaxMultiplier(spawn) {
        return 5;
    }

    _findTargets(room) {
        return MineralManager.getDeliveryTargets(room);
    }

    _work(creep) {
        var mineral = Game.getObjectById(creep.memory.source);
        if (!mineral) {
            var recoveryState = MineralManager.getMiningState(creep.room);
            mineral = recoveryState.mineral;
            if (mineral) creep.memory.source = mineral.id;
        }
        if (!mineral || !mineral.mineralType) return;
        var mineralType = mineral.mineralType;

        // Fill up across extractor cooldowns; deliver early only when mining has stopped.
        var state = MineralManager.getMiningState(creep.room);
        var available = !!state.mineral && state.mineral.id === mineral.id && MineralManager.isMineralAvailable(state);
        if (creep.store.getUsedCapacity(mineralType) > 0 &&
            (!available || creep.store.getFreeCapacity(mineralType) <= 0)) {
            this._deliverMineral(creep, mineralType);
            return;
        }
        if (!available) return;

        var harvestResult = creep.harvest(mineral);
        if (harvestResult === ERR_NOT_IN_RANGE) {
            this._moveToLocation(creep, mineral);
            return;
        }
        if (harvestResult === ERR_TIRED || harvestResult === ERR_NOT_ENOUGH_RESOURCES) return;
        if (harvestResult !== OK) this._handleSourceWorkResult(creep, harvestResult);
    }

    _deliverMineral(creep, mineralType) {
        var targets = MineralManager.getDeliveryTargets(creep.room).slice().sort((a, b) => {
            return creep.pos.getRangeTo(a) - creep.pos.getRangeTo(b);
        });
        for (var i = 0; i < targets.length; i++) {
            var transferResult = creep.transfer(targets[i], mineralType);
            if (transferResult === ERR_FULL) continue;
            if (transferResult === ERR_NOT_IN_RANGE) {
                this._moveToLocation(creep, targets[i]);
            } else if (transferResult !== OK) {
                this._handleTargetWorkResult(creep, transferResult);
            }
            return transferResult;
        }
        return ERR_FULL;
    }
}

module.exports = MineralMiner;
