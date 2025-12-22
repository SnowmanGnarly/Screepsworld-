// Shared military module for warrior and ranged creeps
module.exports = {
    /**
     * Main combat logic shared by warrior and ranged creeps
     * @param {Creep} creep - The military creep
     * @param {function} attackFunction - The attack function to use (attack or rangedAttack)
     * @param {string} attackEmoji - Emoji for attack message
     */
    run: function (creep, attackFunction, attackEmoji) {
        const targetRoom = creep.memory.targetRoom || creep.room.name;

        // If in target room, find enemies
        if (creep.room.name === targetRoom) {
            const enemy = creep.pos.findClosestByRange(FIND_HOSTILE_CREEPS);
            const structure = creep.pos.findClosestByRange(FIND_HOSTILE_STRUCTURES);

            if (enemy) {
                if (attackFunction.call(creep, enemy) === ERR_NOT_IN_RANGE) {
                    creep.moveTo(enemy, {
                        visualizePathStyle: { stroke: '#ff0000' },
                        reusePath: 10
                    });
                    creep.say(attackEmoji + ' Attack!');
                }
            } else if (structure) {
                if (attackFunction.call(creep, structure) === ERR_NOT_IN_RANGE) {
                    creep.moveTo(structure, {
                        visualizePathStyle: { stroke: '#ff0000' },
                        reusePath: 10
                    });
                    creep.say('💥 Destroy!');
                }
            } else {
                // Patrol room if no targets
                const flag = creep.room.find(FIND_FLAGS)[0];
                if (flag) {
                    creep.moveTo(flag, {
                        visualizePathStyle: { stroke: '#ff0000' },
                        reusePath: 10
                    });
                    creep.say('🛡️ Patrol');
                }
            }
        } else {
            // Move to target room
            const exit = creep.room.findExitTo(targetRoom);
            if (exit !== ERR_NO_PATH && exit !== ERR_INVALID_ARGS) {
                creep.moveTo(creep.pos.findClosestByRange(exit), {
                    visualizePathStyle: { stroke: '#ff0000' },
                    reusePath: 10
                });
                creep.say('🚶 Moving');
            }
        }
    }
};
