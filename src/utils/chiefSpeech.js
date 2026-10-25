// Browser speech capture and ElevenLabs playback.
// Typed and spoken turns both become plain text for the existing chat route.
// This module does not know about sessions or TurnMachine.

const PCM_RATE = 24000;
const MIN_SAMPLES = 2400;
const RESUME_LIMIT_MS = 300;

function playbackBlocked() {
  return Object.assign(new Error("Playback is blocked. Tap Play response to hear this answer."), {
    code: "playback_blocked",
  });
}

// A click that only calls resume() does not keep audio unlocked until a reply
// arrives. Start a silent buffer in that gesture, and hold a zero-gain node
// until the reply finishes so the context is still running.
export function holdAudioContext(audioContext) {
  if (!audioContext) return () => {};
  if (audioContext.state === "suspended" && typeof audioContext.resume === "function") {
    void audioContext.resume();
  }
  const stoppers = [];
  try {
    const rate = audioContext.sampleRate || PCM_RATE;
    const buffer = audioContext.createBuffer(1, 1, rate);
    const source = audioContext.createBufferSource();
    source.buffer = buffer;
    source.connect(audioContext.destination);
    source.start(0);
  } catch {
    // The context cannot start a buffer yet. The hold below still tries.
  }
  try {
    const gain = audioContext.createGain();
    gain.gain.value = 0;
    const oscillator = audioContext.createOscillator();
    oscillator.connect(gain);
    gain.connect(audioContext.destination);
    oscillator.start();
    stoppers.push(() => {
      try {
        oscillator.stop();
      } catch {
        // Already stopped.
      }
      try {
        oscillator.disconnect();
      } catch {
        // Already disconnected.
      }
      try {
        gain.disconnect();
      } catch {
        // Already disconnected.
      }
    });
  } catch {
    // Playback can still use this context when a later gesture starts it.
  }
  return () => {
    while (stoppers.length) stoppers.pop()();
  };
}

export async function ensureAudioRunning(audioContext) {
  if (!audioContext) return false;
  if (audioContext.state === "running") return true;
  if (audioContext.state !== "suspended" && audioContext.state !== "interrupted") return false;
  if (typeof audioContext.resume !== "function") return false;
  let timer = null;
  try {
    await Promise.race([
      Promise.resolve(audioContext.resume()),
      new Promise((resolve) => {
        timer = setTimeout(resolve, RESUME_LIMIT_MS);
      }),
    ]);
  } catch {
    return false;
  } finally {
    if (timer != null) clearTimeout(timer);
  }
  return audioContext.state === "running";
}

export function speechErrorMessage(code) {
  if (code === "unsupported") return "Speech recognition is not available in this browser.";
  if (code === "not-allowed" || code === "service-not-allowed") {
    return "Microphone permission was denied.";
  }
  if (code === "audio-capture") return "No microphone was found.";
  if (code === "network") return "Speech recognition needs a network connection.";
  if (code === "aborted" || code === "no-speech") return "";
  return `Speech recognition failed (${code || "unknown"}).`;
}

export function transcriptFromSpeechEvent(event) {
  const results = event?.results;
  if (!results) return { finalText: "", interim: "" };
  let finalText = "";
  let interim = "";
  for (let index = 0; index < results.length; index += 1) {
    const piece = results[index]?.[0]?.transcript ?? "";
    if (results[index]?.isFinal) finalText += piece;
    else interim += piece;
  }
  return { finalText: finalText.trim(), interim: interim.trim() };
}

function browserRecognition() {
  const root = globalThis;
  const Ctor = root.SpeechRecognition || root.webkitSpeechRecognition;
  if (!Ctor) return null;
  return new Ctor();
}

export function createChiefSpeechInput({
  recognition,
  onTranscript,
  onInterim,
  onStart,
  onEnd,
  onError,
} = {}) {
  const impl = recognition === undefined ? browserRecognition() : recognition;
  if (!impl) {
    return {
      supported: false,
      start() {
        const message = speechErrorMessage("unsupported");
        if (message) onError?.(message);
      },
      stop() {},
      abort() {},
    };
  }

  let sent = false;
  impl.continuous = false;
  impl.interimResults = true;
  impl.lang = "en-US";
  impl.onstart = () => {
    sent = false;
    onStart?.();
  };
  impl.onend = () => onEnd?.();
  impl.onerror = (event) => {
    const message = speechErrorMessage(event?.error);
    if (message) onError?.(message);
  };
  impl.onresult = (event) => {
    const parsed = transcriptFromSpeechEvent(event);
    if (parsed.interim) onInterim?.(parsed.interim);
    if (parsed.finalText && !sent) {
      sent = true;
      onTranscript?.(parsed.finalText);
    }
  };

  return {
    supported: true,
    start() {
      try {
        impl.start();
      } catch (error) {
        if (error?.name === "InvalidStateError") return;
        const message = speechErrorMessage(error?.name);
        if (message) onError?.(message);
      }
    },
    stop() {
      try {
        impl.stop();
      } catch {
        // Already stopped.
      }
    },
    abort() {
      try {
        impl.abort();
      } catch {
        // Already stopped.
      }
    },
  };
}

export function takePcmSamples(pending, chunk) {
  const head = pending instanceof Uint8Array ? pending : new Uint8Array();
  const tail = chunk instanceof Uint8Array ? chunk : new Uint8Array();
  const combined = new Uint8Array(head.length + tail.length);
  combined.set(head, 0);
  combined.set(tail, head.length);
  const even = combined.length - (combined.length % 2);
  const samples = new Int16Array(even / 2);
  for (let index = 0; index < samples.length; index += 1) {
    const low = combined[index * 2];
    const high = combined[index * 2 + 1];
    let value = low | (high << 8);
    if (value & 0x8000) value -= 0x10000;
    samples[index] = value;
  }
  return { samples, pending: combined.subarray(even) };
}

function abortError() {
  const error = new Error("The speech playback was stopped.");
  error.name = "AbortError";
  return error;
}

async function finishPlayback(audioContext, remaining, signal) {
  const deadline = Date.now() + Math.max(0, remaining);
  while (Date.now() < deadline) {
    if (signal?.aborted) throw abortError();
    if (audioContext.state !== "running") throw playbackBlocked();
    const slice = Math.min(50, deadline - Date.now());
    if (slice <= 0) break;
    await wait(slice, signal);
  }
  if (signal?.aborted) throw abortError();
  if (audioContext.state !== "running") throw playbackBlocked();
}

function wait(ms, signal) {
  if (ms <= 20) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(timer);
      reject(abortError());
    }
    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function schedulePcm(audioContext, samples, sampleRate, when) {
  const floats = new Float32Array(samples.length);
  for (let index = 0; index < samples.length; index += 1) {
    floats[index] = samples[index] / 32768;
  }
  const buffer = audioContext.createBuffer(1, floats.length, sampleRate);
  buffer.copyToChannel(floats, 0);
  const source = audioContext.createBufferSource();
  source.buffer = buffer;
  source.connect(audioContext.destination);
  const startAt = Math.max(when, audioContext.currentTime + 0.02);
  source.start(startAt);
  return { source, nextTime: startAt + samples.length / sampleRate };
}

function mergeSamples(parts) {
  const count = parts.reduce((total, part) => total + part.length, 0);
  const merged = new Int16Array(count);
  let offset = 0;
  for (const part of parts) {
    merged.set(part, offset);
    offset += part.length;
  }
  return merged;
}

export async function playPcmStream(
  body,
  { audioContext, signal, sampleRate = PCM_RATE, onPlaybackStart } = {}
) {
  if (!body || !audioContext) throw new Error("CHIEF could not play that response.");
  const running = await ensureAudioRunning(audioContext);
  if (signal?.aborted) throw abortError();
  if (!running) throw playbackBlocked();
  const reader = body.getReader();
  const sources = [];
  let pending = new Uint8Array();
  let queued = [];
  let queuedCount = 0;
  let nextTime = audioContext.currentTime + 0.05;
  let started = false;

  function enqueue(samples, flush) {
    if (samples.length) {
      queued.push(samples);
      queuedCount += samples.length;
    }
    if (!flush && queuedCount < MIN_SAMPLES) return;
    if (!queuedCount) return;
    const merged = mergeSamples(queued);
    queued = [];
    queuedCount = 0;
    const scheduled = schedulePcm(audioContext, merged, sampleRate, nextTime);
    sources.push(scheduled.source);
    nextTime = scheduled.nextTime;
    if (!started) onPlaybackStart?.();
    started = true;
  }

  const abort = () => {
    reader.cancel().catch(() => {});
    for (const source of sources) {
      try {
        source.stop();
      } catch {
        // Already finished.
      }
    }
  };
  signal?.addEventListener("abort", abort, { once: true });

  try {
    while (!signal?.aborted) {
      const { done, value } = await reader.read();
      if (value) {
        const taken = takePcmSamples(pending, value);
        pending = taken.pending;
        enqueue(taken.samples, false);
      }
      if (done) break;
    }
    if (signal?.aborted) throw abortError();
    enqueue(new Int16Array(), true);
    if (!started) throw new Error("CHIEF returned no audio.");
    if (audioContext.state !== "running") throw playbackBlocked();
    const remaining = Math.max(0, (nextTime - audioContext.currentTime) * 1000);
    await finishPlayback(audioContext, remaining, signal);
  } catch (error) {
    for (const source of sources) {
      try {
        source.stop();
      } catch {
        // Already finished.
      }
    }
    throw error;
  } finally {
    try {
      reader.releaseLock?.();
    } catch {
      // The reader is already released.
    }
    signal?.removeEventListener("abort", abort);
  }
}

async function playDecodedBuffer(audioContext, audioBuffer, { signal, onPlaybackStart } = {}) {
  const running = await ensureAudioRunning(audioContext);
  if (signal?.aborted) throw abortError();
  if (!running) throw playbackBlocked();
  const source = audioContext.createBufferSource();
  source.buffer = audioBuffer;
  source.connect(audioContext.destination);
  const durationMs = Math.max(0, Number(audioBuffer?.duration) * 1000 || 0);
  if (signal?.aborted) throw abortError();
  try {
    source.start(audioContext.currentTime + 0.02);
  } catch (error) {
    throw error?.name === "AbortError" ? abortError() : error;
  }
  if (audioContext.state !== "running") throw playbackBlocked();
  onPlaybackStart?.();
  try {
    await finishPlayback(audioContext, durationMs, signal);
  } catch (error) {
    try {
      source.stop();
    } catch {
      // Already stopped.
    }
    throw error;
  }
}

export function speakBrowserText(text, { rate = 1, signal, onStart } = {}) {
  const synthesis = globalThis.speechSynthesis;
  const Utterance = globalThis.SpeechSynthesisUtterance;
  if (!synthesis || typeof Utterance !== "function") throw playbackBlocked();
  const spoken = typeof text === "string" ? text.trim() : "";
  if (!spoken) throw playbackBlocked();
  const utterance = new Utterance(spoken);
  const numericRate = Number(rate);
  utterance.rate = Number.isFinite(numericRate) ? Math.min(1.2, Math.max(0.7, numericRate)) : 1;
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      if (error) reject(error);
      else resolve();
    };
    const onAbort = () => {
      try {
        synthesis.cancel();
      } catch {
        // Already stopped.
      }
      finish(abortError());
    };
    utterance.onstart = () => {
      if (signal?.aborted) return;
      onStart?.();
    };
    utterance.onend = () => finish();
    utterance.onerror = (event) => {
      if (event?.error === "interrupted" || event?.error === "canceled") {
        finish(abortError());
        return;
      }
      finish(playbackBlocked());
    };
    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      synthesis.cancel();
      synthesis.resume?.();
      synthesis.speak(utterance);
    } catch (error) {
      finish(error);
    }
  });
}

function playMp3Blob(blob, { signal, onPlaybackStart } = {}) {
  const url = URL.createObjectURL(blob);
  const audio = new Audio(url);
  return new Promise((resolve, reject) => {
    let settled = false;
    function finish(error) {
      if (settled) return;
      settled = true;
      URL.revokeObjectURL(url);
      if (error) reject(error);
      else resolve();
    }
    function onAbort() {
      audio.pause();
      finish(abortError());
    }
    audio.onended = () => finish();
    audio.onerror = () => finish(new Error("CHIEF could not play that response."));
    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });
    audio.play().then(
      () => onPlaybackStart?.(),
      (error) =>
        finish(
          error?.name === "AbortError"
            ? abortError()
            : error?.name === "NotAllowedError"
              ? playbackBlocked()
              : error
        )
    );
  });
}

export async function playChiefSpeech(response, { audioContext, signal, onPlaybackStart } = {}) {
  const format = response?.headers?.get?.("X-Chief-Audio-Format") || "pcm_24000";
  if (signal?.aborted) throw abortError();
  if (format === "mp3") {
    const bytes = await response.arrayBuffer();
    if (signal?.aborted) throw abortError();
    if (audioContext && typeof audioContext.decodeAudioData === "function") {
      try {
        const decoded = await audioContext.decodeAudioData(bytes.slice(0));
        await playDecodedBuffer(audioContext, decoded, { signal, onPlaybackStart });
        return;
      } catch (error) {
        if (error?.name === "AbortError" || error?.code === "playback_blocked") throw error;
      }
    }
    await playMp3Blob(new Blob([bytes], { type: "audio/mpeg" }), { signal, onPlaybackStart });
    return;
  }
  await playPcmStream(response.body, { audioContext, signal, onPlaybackStart });
}
