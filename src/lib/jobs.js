const { nowIso, randomId } = require("./utils");

const DEFAULT_RETENTION_MS = 10 * 60 * 1000;

// Tracks long-running work (currently server provisioning) so the browser can
// poll for progress instead of blocking on a request that runs for a minute.
// In-memory on purpose: a restart cancels the work anyway.
function createJobRegistry(options = {}) {
  const retentionMs = options.retentionMs || DEFAULT_RETENTION_MS;
  const jobs = new Map();

  function prune() {
    const cutoff = Date.now() - retentionMs;
    for (const [id, job] of jobs) {
      if (job.finishedAtMs && job.finishedAtMs < cutoff) {
        jobs.delete(id);
      }
    }
  }

  function serialize(job) {
    if (!job) {
      return null;
    }
    return {
      createdAt: job.createdAt,
      error: job.error,
      id: job.id,
      kind: job.kind,
      // Stage-based, not byte-based: honest about being an estimate.
      progress: job.totalSteps ? Math.min(1, job.stepIndex / job.totalSteps) : 0,
      result: job.result,
      status: job.status,
      step: job.step,
      stepIndex: job.stepIndex,
      totalSteps: job.totalSteps,
      updatedAt: job.updatedAt
    };
  }

  function create(kind, { totalSteps = 0, label = "" } = {}) {
    prune();
    const job = {
      createdAt: nowIso(),
      error: null,
      finishedAtMs: null,
      id: randomId("job"),
      kind,
      result: null,
      status: "running",
      step: label,
      stepIndex: 0,
      totalSteps,
      updatedAt: nowIso()
    };
    jobs.set(job.id, job);
    return job;
  }

  function progress(jobId, step) {
    const job = jobs.get(jobId);
    if (!job || job.status !== "running") {
      return;
    }
    job.step = step;
    job.stepIndex = Math.min(job.stepIndex + 1, job.totalSteps || job.stepIndex + 1);
    job.updatedAt = nowIso();
  }

  function succeed(jobId, result) {
    const job = jobs.get(jobId);
    if (!job) {
      return;
    }
    job.status = "succeeded";
    job.step = "done";
    job.stepIndex = job.totalSteps;
    job.result = result || null;
    job.finishedAtMs = Date.now();
    job.updatedAt = nowIso();
  }

  function fail(jobId, error) {
    const job = jobs.get(jobId);
    if (!job) {
      return;
    }
    job.status = "failed";
    job.error = (error && error.message) || String(error) || "The job failed.";
    job.finishedAtMs = Date.now();
    job.updatedAt = nowIso();
  }

  function get(jobId) {
    return serialize(jobs.get(jobId));
  }

  return { create, fail, get, progress, succeed };
}

module.exports = {
  createJobRegistry
};
