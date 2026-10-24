/*
 * Defense Manager coordinates room-wide threat assessment,
 * on-demand defender dispatching, rate-limited notifications, and safe mode safeguards.
 */

var constants = require('./main.constants');
var MainUtil = require('./main.util');
var MainCache = require('./main.cache');
var info = require('./main.info');

class DefenseManager {

	static runAll() {
		MainUtil.findAllRooms().forEach(room => {
			if (room.memory.base) {
				new DefenseManager(room).run();
			}
		});
	}

	constructor(room) {
		this._room = room;
		this._memory = this._fetchMemory();
	}

	_fetchMemory() {
		var defaultData = {
			threatLevel: 0,
			lastNotification: 0,
			alarmTicks: 0,
		};
		if (!this._room.memory.defense) {
			this._room.memory.defense = defaultData;
		}
		return this._room.memory.defense;
	}

	run() {
		var hostiles = MainCache.find(this._room, FIND_HOSTILE_CREEPS);
		var threatReport = this._assessThreat(hostiles);

		this._memory.threatLevel = threatReport.level;
		this._memory.primaryTargetId = threatReport.primaryTarget ? threatReport.primaryTarget.id : null;

		if (threatReport.level > 0) {
			this._memory.alarmTicks++;
			this._handleAlerts(threatReport);
			this._coordinateDefenders(threatReport);
			this._evaluateSafeMode(threatReport, hostiles);
		} else {
			this._memory.alarmTicks = 0;
			this._standDownDefenders();
		}
	}

	_assessThreat(hostiles) {
		if (hostiles.length === 0) {
			return { level: 0, score: 0, primaryTarget: null, healerCount: 0 };
		}

		var totalScore = 0;
		var scoredHostiles = [];
		var healerCount = 0;

		var corePositions = MainCache.find(this._room, FIND_MY_SPAWNS).map(s => s.pos);
		if (this._room.storage) corePositions.push(this._room.storage.pos);

		hostiles.forEach(hostile => {
			var healParts = hostile.getActiveBodyparts(HEAL);
			var attackParts = hostile.getActiveBodyparts(ATTACK);
			var rangedParts = hostile.getActiveBodyparts(RANGED_ATTACK);
			var workParts = hostile.getActiveBodyparts(WORK);
			var isBoosted = hostile.body.some(part => !!part.boost);

			if (healParts > 0) healerCount++;

			var score = (healParts * 150) + (rangedParts * 120) + (attackParts * 100) + (workParts * 80);
			if (isBoosted) score *= 2;

			// Proximity weight to core structures
			if (corePositions.length > 0) {
				var minRange = Math.min(...corePositions.map(pos => hostile.pos.getRangeTo(pos)));
				score += Math.max(0, (20 - minRange) * 10);
			}

			totalScore += score;
			scoredHostiles.push({ creep: hostile, score: score, healParts: healParts, attackParts: attackParts + rangedParts });
		});

		// Sort: healers first, then highest combat threat
		scoredHostiles.sort((a, b) => b.score - a.score);
		var primaryTarget = scoredHostiles.length > 0 ? scoredHostiles[0].creep : null;

		var level = 1; // Probing
		if (totalScore >= 200 || scoredHostiles.some(h => h.attackParts > 0 || h.healParts > 0)) {
			level = 2; // Invasion
		}

		if (corePositions.length > 0 && primaryTarget) {
			var closestCore = Math.min(...corePositions.map(pos => primaryTarget.pos.getRangeTo(pos)));
			if (closestCore <= 4) {
				level = 3; // Critical
			}
		}

		return {
			level: level,
			score: totalScore,
			primaryTarget: primaryTarget,
			healerCount: healerCount,
		};
	}

	_handleAlerts(threatReport) {
		if (threatReport.level >= 2) {
			var now = Game.time;
			var last = this._memory.lastNotification || 0;
			if (now - last > 100) {
				this._memory.lastNotification = now;
				var message = '🛡️ [DEFENSE ALERT] Invasion in ' + this._room.name + ' at tick ' + now +
					'! Threat Level: ' + threatReport.level + ', Threat Score: ' + threatReport.score;
				Game.notify(message);
				info.error(message, this._room);
			}
		}
	}

	_coordinateDefenders(threatReport) {
		if (!this._room.memory.base || !this._room.memory.base.roleConfig) {
			return;
		}
		var roleConfig = this._room.memory.base.roleConfig;
		if (!roleConfig.Defender) {
			roleConfig.Defender = { requiredNumber: 0 };
		}

		if (threatReport.level >= 2) {
			var desiredDefenders = threatReport.score > 600 ? 2 : 1;
			if (roleConfig.Defender.requiredNumber < desiredDefenders) {
				roleConfig.Defender.requiredNumber = desiredDefenders;
				info.warning('🛡️ DefenseManager requested ' + desiredDefenders + ' on-demand defenders in ' + this._room.name);
			}
		}
	}

	_standDownDefenders() {
		if (this._room.memory.base && this._room.memory.base.roleConfig && this._room.memory.base.roleConfig.Defender) {
			if (this._room.memory.base.roleConfig.Defender.requiredNumber > 0) {
				this._room.memory.base.roleConfig.Defender.requiredNumber = 0;
				info.log('🕊️ DefenseManager stood down defenders in ' + this._room.name);
			}
		}
	}

	_evaluateSafeMode(threatReport, hostiles) {
		var controller = this._room.controller;
		if (!controller || !controller.my) return;
		if (controller.safeMode || controller.safeModeCooldown || controller.safeModeAvailable === 0) {
			return;
		}

		if (threatReport.level === 3) {
			var spawns = MainCache.find(this._room, FIND_MY_SPAWNS);
			var breach = spawns.some(spawn => hostiles.some(h => h.pos.inRangeTo(spawn, 3)));
			if (breach) {
				var result = controller.activateSafeMode();
				if (result === OK) {
					var alertMsg = '🚨 [SAFE MODE ACTIVATED] Room ' + this._room.name + ' activated safe mode under critical breach!';
					Game.notify(alertMsg);
					info.error(alertMsg, this._room);
				}
			}
		}
	}

	static getPriorityTarget(room) {
		if (room.memory.defense && room.memory.defense.primaryTargetId) {
			var target = Game.getObjectById(room.memory.defense.primaryTargetId);
			if (target) return target;
		}
		var hostiles = MainCache.find(room, FIND_HOSTILE_CREEPS);
		return hostiles.length > 0 ? hostiles[0] : null;
	}
}

module.exports = DefenseManager;
