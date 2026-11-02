// @ts-check
/*
 * Runs the tick as a table of jobs. A job that throws is reported and the next job still runs,
 * so one bug cannot silence towers or leave creeps standing. Each job names the lowest CPU tier
 * it may run in and, optionally, the ticks it runs on: every `every` ticks, offset by `phase`.
 * Fixed ticks keep two jobs apart, and a global reset cannot bunch them onto its expensive tick.
 *
 * Job: { name, run, tier = CpuManager.TIER_CRITICAL, every = 1, phase = 0, enabled = () => true }
 */

var info = require('./main.info');
var CpuManager = require('./manager.cpu');

/**
 * @typedef {{ name: string, run: Function, tier?: number, every?: number, phase?: number, enabled?: () => boolean }} Job
 */

class MainScheduler {

	/** @param {Job[]} jobs */
	static run(jobs) {
		var tier = CpuManager.getTier();
		jobs.forEach(job => this._runIfDue(job, tier));
	}

	/*
	 * Runs work that is not a job in the table, under the same boundary.
	 */

	/**
	 * @param {string} name
	 * @param {Function} action
	 */
	static guard(name, action) {
		try {
			action();
		} catch (error) {
			info.failure('job:' + name, 'Job ' + name + ' failed', error);
		}
	}

	/**
	 * @param {Job} job
	 * @param {number} tier
	 */
	static _runIfDue(job, tier) {
		this.guard(job.name, () => {
			if (this._isDue(job, tier)) CpuManager.measure(job.name, job.run);
		});
	}

	/**
	 * @param {Job} job
	 * @param {number} tier
	 */
	static _isDue(job, tier) {
		var jobTier = job.tier === undefined ? CpuManager.TIER_CRITICAL : job.tier;
		if (tier < jobTier) return false;
		// anything that can wait a tick must not be what tips this one over the limit
		if (jobTier > CpuManager.TIER_CRITICAL && !CpuManager.hasCpuLeft()) return false;
		if (job.enabled && !job.enabled()) return false;
		return !job.every || Game.time % job.every === (job.phase || 0);
	}
}

module.exports = MainScheduler;
