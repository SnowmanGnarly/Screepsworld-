/*
 * This module is used to display GPC measurements on screen, so that I know where to optimize.
 * It also keeps a short CPU history in Memory.stats that survives global resets.
 */

var config = require('./main.config');
var MainUtil = require('./main.util');
var info = require('./main.info');

class CpuManager {

    /*
	 * Starts a new round of measurements.
	 */

	static initRound() {
		this._measurements = [];
		var previousState = this._degraded;
		if (Game.cpu.bucket < config.CPU.DEGRADED_BUCKET) {
			this._degraded = true;
		} else if (Game.cpu.bucket > config.CPU.RECOVERED_BUCKET) {
			this._degraded = false;
		} else if (this._degraded === undefined) {
			// a global reset forgets the state, so inside the band assume we are still recovering
			this._degraded = true;
		}
		if (previousState !== this._degraded && this._degraded && Game.time - (this._lastDeferredNotice || 0) > 100) {
			this._lastDeferredNotice = Game.time;
			info.warning('CPU bucket is low; deferring non-essential work.');
		}
	}

	static shouldRunDeferred() {
		return !this._degraded;
	}

	/*
	 * Returns the CPU tier for this tick. Higher tiers run more work.
	 */

	static getTier() {
		if (Game.cpu.bucket < config.CPU.CRITICAL_BUCKET) return CpuManager.TIER_CRITICAL;
		return this._degraded ? CpuManager.TIER_DEGRADED : CpuManager.TIER_NORMAL;
	}

    /*
	 * Displays the collected GC measurements on the screen.
	 */

	static visualize() {
		MainUtil.findAllRooms().forEach(room => this._visualizeMeasurements(room));
    }

    /*
	 * Displays the GC measurements for a specific room on the screen.
	 *
	 * @param {Room} room
	 */

	static _visualizeMeasurements(room) {
		const memory = this._fetchMemoryOfRoomCpu(room);
        var x = memory.x;
        var y = memory.y;
        var spaceToUsedTicks = 7;

    	room.visual.text('CPU Watcher', x, y, {align: 'left', opacity: memory.opacity + 0.2});
    	y++;

        this._measurements.forEach(measurement => {
        	var color = measurement.usedTicks > 10 ? 'red' : 'white';
        	room.visual.text(measurement.name, x, y, {align: 'left', opacity: memory.opacity, color: color});
        	room.visual.text(this._format.format(measurement.usedTicks), x + spaceToUsedTicks, y, {align: 'right', opacity: memory.opacity, color: color});
        	y++;
        });
    }

	/*
	 * Fetches the memory of the room's CPU manager.
	 *
	 * @param {Room} room
	 */

	static _fetchMemoryOfRoomCpu(room) {
		var defaultArray = {
			x: 20,
			y: 0,
			opacity: 0.5,
		};
		if (room.memory.cpu) {
			room.memory.cpu = Object.assign(defaultArray, room.memory.cpu);
		} else {
			room.memory.cpu = defaultArray;
		}
		return room.memory.cpu;
	}

	/*
	 * Measures the CPU usage of a specific function. The usage is recorded even if the function
	 * throws, and the error still reaches the caller.
	 *
	 * @param name
	 * @param executedFunction
	 */

	static measure(name, executedFunction) {
		var usedTicks = Game.cpu.getUsed();
		try {
			executedFunction();
		} finally {
			usedTicks = Game.cpu.getUsed() - usedTicks;
			this._measurements.push( {
				name: name,
				usedTicks: usedTicks,
			});
		}
    }

	/*
	 * Adds this tick to the running window and writes a sample once the window is full. Between
	 * samples nothing touches Memory, so the history costs almost nothing to keep.
	 */

	static collectStats() {
		var window = this._statsWindow;
		window.ticks++;
		window.cpu += Game.cpu.getUsed();
		this._measurements.forEach(measurement => {
			window.jobs[measurement.name] = (window.jobs[measurement.name] || 0) + measurement.usedTicks;
		});
		if (window.ticks >= config.CPU.STATS_INTERVAL) this._writeStatsSample();
	}

	static _writeStatsSample() {
		var window = this._statsWindow;
		var round = value => Math.round(value / window.ticks * 100) / 100;
		var jobs = {};
		Object.keys(window.jobs)
			.sort((a, b) => window.jobs[b] - window.jobs[a])
			.slice(0, config.CPU.STATS_TOP_JOBS)
			.forEach(name => { jobs[name] = round(window.jobs[name]); });

		if (!Memory.stats || !Array.isArray(Memory.stats.samples)) Memory.stats = { samples: [] };
		Memory.stats.samples.push({ t: Game.time, cpu: round(window.cpu), bucket: Game.cpu.bucket, jobs: jobs });
		if (Memory.stats.samples.length > config.CPU.STATS_SAMPLES) Memory.stats.samples.shift();
		this._resetStatsWindow();
	}

	static _resetStatsWindow() {
		this._statsWindow = { ticks: 0, cpu: 0, jobs: {} };
	}

	/*
	 * Summarizes the stored history: average CPU, bucket trend and the most expensive jobs.
	 */

	static getStatsReport() {
		var samples = Memory.stats && Array.isArray(Memory.stats.samples) ? Memory.stats.samples : [];
		if (samples.length === 0) return 'No CPU samples yet.';
		var totals = {};
		var cpu = 0;
		samples.forEach(sample => {
			cpu += sample.cpu;
			Object.keys(sample.jobs).forEach(name => { totals[name] = (totals[name] || 0) + sample.jobs[name]; });
		});
		var lines = ['CPU over ' + samples.length + ' samples: average ' + (cpu / samples.length).toFixed(2) +
			', bucket ' + samples[0].bucket + ' -> ' + samples[samples.length - 1].bucket];
		Object.keys(totals).sort((a, b) => totals[b] - totals[a]).slice(0, 10).forEach(name => {
			lines.push('  ' + name + ': ' + (totals[name] / samples.length).toFixed(2));
		});
		return lines.join('\n');
	}

};

CpuManager.TIER_CRITICAL = 0;
CpuManager.TIER_DEGRADED = 1;
CpuManager.TIER_NORMAL = 2;
CpuManager._measurements = [];
CpuManager._format = new Intl.NumberFormat('en', { maximumSignificantDigits: 1 });
CpuManager._resetStatsWindow();

module.exports = CpuManager;
