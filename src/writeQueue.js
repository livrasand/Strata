export class WriteQueue {
  constructor({
    commit,
    debounceMs = 2000,
    intervalMs = 5000,
    log = console
  } = {}) {
    if (typeof commit !== "function") {
      throw new Error("WriteQueue requires a commit function.");
    }

    this.commit = commit;
    this.debounceMs = queueDelay(debounceMs, 2000);
    this.intervalMs = queueDelay(intervalMs, 5000);
    this.log = log;

    this.dirtySince = null;
    this.timer = null;
    this.running = false;

    this.stats = {
      enqueued: 0,
      flushes: 0,
      conflicts: 0,
      errors: 0,
      lastFlushAt: null,
      lastError: null
    };
  }

  markDirty() {
    this.stats.enqueued += 1;

    if (this.dirtySince === null) {
      this.dirtySince = Date.now();
    }

    if (this.running) {
      return;
    }

    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, this.debounceMs);
    this.timer.unref?.();
  }

  async flushNow() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    return this.flush();
  }

  async settled(timeoutMs = 10000) {
    const started = Date.now();
    while (this.dirtySince !== null && Date.now() - started < timeoutMs) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    if (this.dirtySince !== null) {
      throw new Error("Write queue did not settle before the timeout.");
    }
  }

  snapshot() {
    return {
      pending: this.dirtySince !== null,
      ...this.stats
    };
  }

  async flush() {
    if (this.running || this.dirtySince === null) return { ok: false, reason: "idle" };

    this.running = true;
    let outcome;

    try {
      await this.commit();
      this.dirtySince = null;
      this.stats.flushes += 1;
      this.stats.lastFlushAt = new Date().toISOString();
      outcome = { ok: true };
    } catch (error) {
      this.stats.errors += 1;
      this.stats.lastError = error.message;
      if (error.status === 409) {
        this.stats.conflicts += 1;
      }
      this.log.error?.(`[write-queue] commit failed: ${error.message}`);
      outcome = { ok: false, error };
    } finally {
      this.running = false;
      if (this.dirtySince !== null) this.scheduleNext(this.intervalMs);
    }

    return outcome;
  }

  scheduleNext(delay) {
    if (this.dirtySince === null || this.timer || this.running) return;

    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, delay);
    this.timer.unref?.();
  }
}

function queueDelay(value, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return parsed;
}
