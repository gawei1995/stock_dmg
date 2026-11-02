/**
 * Monotonic lifecycle guard for asynchronous broker work.
 *
 * A generation is advanced before credentials are forgotten or replaced.
 * Work that began under an older generation may finish at the transport
 * layer, but it cannot publish or persist its result after that boundary.
 */
export class AuthorizationGenerationGate {
  constructor({ initialGeneration = 0 } = {}) {
    const parsed = Number(initialGeneration);
    if (!Number.isSafeInteger(parsed) || parsed < 0) {
      throw new TypeError("Authorization generation must be a non-negative safe integer.");
    }
    this.generation = parsed;
    this.inFlight = new Map();
  }

  capture() {
    return this.generation;
  }

  advance() {
    if (this.generation >= Number.MAX_SAFE_INTEGER) {
      throw new Error("Authorization generation is exhausted.");
    }
    this.generation += 1;
    return this.generation;
  }

  isCurrent(generation) {
    return Number(generation) === this.generation;
  }

  assertCurrent(generation) {
    if (!this.isCurrent(generation)) {
      throw new StaleAuthorizationGenerationError(generation, this.generation);
    }
    return generation;
  }

  /**
   * Tracks an operation and checks the generation both before it starts and
   * after it settles. The operation itself should also use isCurrent() as a
   * commit guard immediately before any persistent mutation.
   */
  track(generation, operation) {
    const run = Promise.resolve().then(async () => {
      this.assertCurrent(generation);
      const result = await (typeof operation === "function" ? operation() : operation);
      this.assertCurrent(generation);
      return result;
    });
    const bucket = this.inFlight.get(generation) ?? new Set();
    bucket.add(run);
    this.inFlight.set(generation, bucket);
    const remove = () => {
      bucket.delete(run);
      if (!bucket.size) this.inFlight.delete(generation);
    };
    void run.then(remove, remove);
    return run;
  }

  /**
   * Waits only for work from older generations. The hard deadline prevents a
   * broken transport promise from blocking reauthorization forever; commit
   * guards continue rejecting that work after this method returns.
   */
  async settleSuperseded({ timeoutMs = 30_000 } = {}) {
    const timeout = Number(timeoutMs);
    if (!Number.isFinite(timeout) || timeout < 0) {
      throw new TypeError("Authorization drain timeout must be a non-negative number.");
    }
    const deadline = Date.now() + timeout;
    while (true) {
      const pending = [...this.inFlight.entries()]
        .filter(([generation]) => !this.isCurrent(generation))
        .flatMap(([, operations]) => [...operations]);
      if (!pending.length) return { settled: true, pendingCount: 0 };
      const remainingMs = Math.max(0, deadline - Date.now());
      if (remainingMs === 0) {
        return { settled: false, pendingCount: pending.length };
      }
      const outcome = await settleWithDeadline(pending, remainingMs);
      if (outcome === "timeout") {
        const pendingCount = [...this.inFlight.entries()]
          .filter(([generation]) => !this.isCurrent(generation))
          .reduce((total, [, operations]) => total + operations.size, 0);
        return { settled: false, pendingCount };
      }
    }
  }
}

export class StaleAuthorizationGenerationError extends Error {
  constructor(requestGeneration, currentGeneration) {
    super("长桥授权已在请求期间发生变化；旧请求结果已丢弃，请重新同步。");
    this.name = "StaleAuthorizationGenerationError";
    this.code = "STALE_LONGBRIDGE_AUTHORIZATION_GENERATION";
    this.requestGeneration = Number(requestGeneration);
    this.currentGeneration = Number(currentGeneration);
    this.retryable = true;
  }
}

function settleWithDeadline(operations, timeoutMs) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve("timeout"), timeoutMs);
    Promise.allSettled(operations).then(() => {
      clearTimeout(timer);
      resolve("settled");
    });
  });
}
