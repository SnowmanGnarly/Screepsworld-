/*
 * Runs the tick as a table of jobs. A job that throws is reported and the next job still runs,
 * so one bug cannot silence towers or leave creeps standing. Each job names the lowest CPU tier
 * it may run in and, optionally, how many ticks to leave between runs.
 *
 * Job: { name, run, tier = CpuManager.TIER_CRITICAL, every = 1, enabled = () => true }
 */

var config = require('./main.config');
var info = require('./main.info');
var CpuManager = require('./manager.cpu');

class MainScheduler {

	static run(jobs) {
		var tier = CpuManager.getTier();
		jobs.forEach(job => {
			if (this._isDue(job, tier)) this._runJob(job);
		});
	}

	static reset() {
		this._lastRun = {};
		this._lastError = {};
	}

	static _isDue(job, tier) {
		if (tier < (job.tier === undefined ? CpuManager.TIER_CRITICAL : job.tier)) return false;
		if (job.enabled && !job.enabled()) return false;
		var last = this._lastRun[job.name];
		// a job that has not run since the last global reset is always due
		return last === undefined || Game.time - last >= (job.every || 1);
	}

	static _runJob(job) {
		this._lastRun[job.name] = Game.time;
		try {
			CpuManager.measure(job.name, job.run);
		} catch (error) {
			this._reportError(job, error);
		}
	}

	static _reportError(job, error) {
		var last = this._lastError[job.name];
		if (last !== undefined && Game.time - last < config.CPU.ERROR_LOG_INTERVAL) return;
		this._lastError[job.name] = Game.time;
		info.error('Job ' + job.name + ' failed: ' + error);
		info.notify('job:' + job.name, 'Job ' + job.name + ' keeps failing: ' + error);
		console.log(error && error.stack);
	}
}

MainScheduler.reset();

module.exports = MainScheduler;
