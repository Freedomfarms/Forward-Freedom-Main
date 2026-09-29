// CHIEF rate limit — token bucket, per user and tool.
//
// PORT/ADAPT of OpenJarvis (Stanford, Apache-2.0)
//   Upstream: https://github.com/open-jarvis/OpenJarvis
//   Source files: src/openjarvis/security/rate_limiter.py (TokenBucket.consume)
//     and rust/crates/openjarvis-security/src/rate_limiter.rs (check)
//   Commit: 5e5f5efde4bfcf8a60fe70d1cea12a0185f615ec
//
// The Python RateLimiter.check() always delegates to Rust, and reset() returns
// before its Python bucket path. The portable algorithm is TokenBucket.consume
// plus the Rust check() refill (requests_per_minute / 60, burst capacity).
//
// Adaptation: buckets are keyed by userId + agentId + tool. A process-global
// key of only the tool name would let one user consume another's budget, and
// a missing userId fails closed. Buckets live in the injected store. The
// default store is in-process; it does not survive a new serverless instance.

export class MemoryRateLimitStore {
  constructor() {
    this.buckets = new Map();
  }

  get(key) {
    return this.buckets.get(key) ?? null;
  }

  set(key, bucket) {
    this.buckets.set(key, bucket);
  }
}

export class TokenBucket {
  constructor({ rate, capacity, now }) {
    this.rate = rate;
    this.capacity = capacity;
    this.tokens = capacity;
    this.lastRefill = now();
    this._now = now;
  }

  consume(tokens = 1) {
    const now = this._now();
    const elapsed = Math.max(0, (now - this.lastRefill) / 1000);
    this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.rate);
    this.lastRefill = now;
    if (this.tokens >= tokens) {
      this.tokens -= tokens;
      return { allowed: true, waitSeconds: 0 };
    }
    return { allowed: false, waitSeconds: (tokens - this.tokens) / this.rate };
  }
}

export class RateLimiter {
  constructor({
    requestsPerMinute = 60,
    burstSize = 10,
    store = new MemoryRateLimitStore(),
    now = () => performance.now(),
  } = {}) {
    if (!(requestsPerMinute > 0) || !(burstSize > 0)) {
      throw new TypeError("rate limit requires a positive rate and burst");
    }
    this._rate = requestsPerMinute / 60;
    this._capacity = burstSize;
    this._store = store;
    this._now = now;
  }

  check(key) {
    if (typeof key !== "string" || key.trim() === "") {
      return { allowed: false, waitSeconds: this._capacity / this._rate };
    }
    let bucket = this._store.get(key);
    if (!bucket) {
      bucket = new TokenBucket({ rate: this._rate, capacity: this._capacity, now: this._now });
      this._store.set(key, bucket);
    }
    return bucket.consume(1);
  }
}

export function rateLimitKey({ userId, agentId, toolName }) {
  if (!userId || !toolName) return "";
  return `${userId}\u0000${agentId || "chief"}\u0000${toolName}`;
}
