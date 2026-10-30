// Serial speech for one CHIEF turn. Cancel drops anything still queued and
// aborts the clip that is already playing. A later enqueue is a new turn.

export function createSpeechQueue() {
  let generation = 0;
  let running = false;
  let blocked = false;
  let blockResult = null;
  const pending = [];
  let idleWaiters = [];
  let activeController = null;

  function settleIdle() {
    if (running || pending.length) return;
    const waiters = idleWaiters;
    idleWaiters = [];
    for (const resolve of waiters) resolve();
  }

  function failGeneration(result, itemGeneration) {
    for (let index = pending.length - 1; index >= 0; index -= 1) {
      if (pending[index].generation !== itemGeneration) continue;
      pending[index].resolve(result);
      pending.splice(index, 1);
    }
  }

  function failAll(result) {
    while (pending.length) pending.shift().resolve(result);
  }

  async function pump() {
    if (running) return;
    running = true;
    try {
      while (pending.length) {
        const item = pending.shift();
        if (item.generation !== generation) {
          item.resolve({ ok: false, reason: "aborted" });
          continue;
        }
        const controller = new AbortController();
        activeController = controller;
        try {
          const result = await item.speak(item.text, controller.signal);
          const aborted = item.generation !== generation || controller.signal.aborted;
          if (aborted) {
            item.resolve({ ok: false, reason: "aborted" });
            failGeneration({ ok: false, reason: "aborted" }, item.generation);
          } else if (result?.ok === false) {
            const failed =
              result.reason === "aborted"
                ? { ok: false, reason: "aborted" }
                : {
                    ok: false,
                    reason: result.reason || "error",
                    error: result.error,
                    code: result.code,
                  };
            item.resolve(failed);
            if (failed.reason !== "aborted") {
              blocked = true;
              blockResult = failed;
            }
            failGeneration(failed, item.generation);
          } else {
            item.resolve(result ?? { ok: true });
          }
        } catch (error) {
          const aborted =
            item.generation !== generation ||
            controller.signal.aborted ||
            error?.name === "AbortError" ||
            error?.code === "aborted";
          if (aborted) {
            item.resolve({ ok: false, reason: "aborted" });
            failGeneration({ ok: false, reason: "aborted" }, item.generation);
          } else {
            const failed = {
              ok: false,
              reason: "error",
              error: error?.message || "CHIEF could not speak that response.",
              code: error?.code || "",
            };
            blocked = true;
            blockResult = failed;
            item.resolve(failed);
            failGeneration(failed, item.generation);
          }
        } finally {
          if (activeController === controller) activeController = null;
        }
      }
    } finally {
      running = false;
      settleIdle();
    }
  }

  return {
    enqueue(text, speak) {
      const spoken = typeof text === "string" ? text.trim() : "";
      if (!spoken || typeof speak !== "function") {
        return Promise.resolve({ ok: false, reason: "empty" });
      }
      if (blocked) {
        return Promise.resolve(blockResult || { ok: false, reason: "error" });
      }
      const itemGeneration = generation;
      return new Promise((resolve) => {
        pending.push({ text: spoken, speak, generation: itemGeneration, resolve });
        void pump();
      });
    },
    cancel() {
      generation += 1;
      blocked = false;
      blockResult = null;
      const controller = activeController;
      activeController = null;
      controller?.abort();
      failAll({ ok: false, reason: "aborted" });
      settleIdle();
    },
    whenIdle() {
      if (!running && pending.length === 0) return Promise.resolve();
      return new Promise((resolve) => {
        idleWaiters.push(resolve);
      });
    },
    hasWaiting() {
      return pending.length > 0;
    },
  };
}
