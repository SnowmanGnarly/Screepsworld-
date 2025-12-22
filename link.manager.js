module.exports = {
    run: function (room) {
        // Find all links in the room
        const links = room.find(FIND_MY_STRUCTURES, {
            filter: { structureType: STRUCTURE_LINK }
        });

        // Need at least 2 links to transfer
        if (links.length < 2) return;

        const senders = [];
        const receivers = [];

        // Categorize links
        // Receivers: Close to Spawn, Storage, Controller, or Terminal
        // Senders: Everything else (e.g. Source links, Remote drop-off links)

        const baseStructures = room.find(FIND_MY_STRUCTURES, {
            filter: s => s.structureType === STRUCTURE_SPAWN ||
                s.structureType === STRUCTURE_STORAGE ||
                s.structureType === STRUCTURE_CONTROLLER ||
                s.structureType === STRUCTURE_TERMINAL
        });

        for (const link of links) {
            let isReceiver = false;

            // Check if near a base structure
            for (const struct of baseStructures) {
                if (link.pos.inRangeTo(struct, 3)) {
                    isReceiver = true;
                    break;
                }
            }

            if (isReceiver) {
                receivers.push(link);
            } else {
                senders.push(link);
            }
        }

        // Execute transfers
        for (const sender of senders) {
            // Only transfer if we have energy and cooldown is ready
            if (sender.store[RESOURCE_ENERGY] > 0 && sender.cooldown === 0) {
                // Find a receiver that isn't full
                const target = receivers.find(r => r.store.getFreeCapacity(RESOURCE_ENERGY) > 0);

                if (target) {
                    sender.transferEnergy(target);
                }
            }
        }
    }
};
