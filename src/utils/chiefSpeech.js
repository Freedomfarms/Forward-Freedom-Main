// Browser speech capture and ElevenLabs playback.
// Typed and spoken turns both become plain text for the existing chat route.
// This module does not know about sessions or TurnMachine.

const PCM_RATE = 24000;
const MIN_SAMPLES = 2400;

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

export async function playPcmStream(body, { audioContext, signal, sampleRate = PCM_RATE } = {}) {
  if (!body || !audioContext) throw new Error("CHIEF could not play that response.");
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
  if (signal?.aborted) throw abortError();
  signal?.addEventListener("abort", abort, { once: true });

  try {
    if (audioContext.state === "suspended") await audioContext.resume();
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
    const remaining = Math.max(0, (nextTime - audioContext.currentTime) * 1000);
    await wait(remaining, signal);
  } finally {
    signal?.removeEventListener("abort", abort);
  }
}

function playMp3Blob(blob, { signal } = {}) {
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
      () => {},
      (error) => finish(error?.name === "AbortError" ? abortError() : error)
    );
  });
}

export async function playChiefSpeech(response, { audioContext, signal } = {}) {
  const format = response?.headers?.get?.("X-Chief-Audio-Format") || "pcm_24000";
  if (signal?.aborted) throw abortError();
  if (format === "mp3") {
    const blob = await response.blob();
    if (signal?.aborted) throw abortError();
    await playMp3Blob(blob, { signal });
    return;
  }
  await playPcmStream(response.body, { audioContext, signal });
}
