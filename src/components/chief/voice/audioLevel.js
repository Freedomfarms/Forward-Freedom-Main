// Microphone level for the existing orb ripple.
// The sample loop writes a ref. It does not render React.

const SILENCE = 0;

function rms(samples) {
  let sum = 0;
  for (let index = 0; index < samples.length; index += 1) {
    const value = (samples[index] - 128) / 128;
    sum += value * value;
  }
  return Math.sqrt(sum / samples.length);
}

export function createAudioLevel({
  levelRef = { current: SILENCE },
  getUserMedia = defaultGetUserMedia(),
  AudioContext = defaultAudioContext(),
  intervalMs = 50,
} = {}) {
  let stream = null;
  let context = null;
  let analyser = null;
  let source = null;
  let timer = null;
  let samples = null;

  function resetLevel() {
    levelRef.current = SILENCE;
  }

  async function stop() {
    if (timer != null) {
      clearInterval(timer);
      timer = null;
    }
    try {
      source?.disconnect();
    } catch {
      // Already disconnected.
    }
    try {
      analyser?.disconnect();
    } catch {
      // Already disconnected.
    }
    source = null;
    analyser = null;
    samples = null;
    if (stream) {
      for (const track of stream.getTracks()) track.stop();
      stream = null;
    }
    if (context) {
      const closing = context;
      context = null;
      try {
        await closing.close();
      } catch {
        // The context is already closed.
      }
    }
    resetLevel();
  }

  return {
    levelRef,
    async start() {
      await stop();
      if (typeof getUserMedia !== "function" || typeof AudioContext !== "function") {
        return false;
      }
      try {
        stream = await getUserMedia({
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            channelCount: 1,
          },
          video: false,
        });
        context = new AudioContext();
        if (context.state === "suspended") await context.resume();
        analyser = context.createAnalyser();
        analyser.fftSize = 256;
        analyser.smoothingTimeConstant = 0.8;
        source = context.createMediaStreamSource(stream);
        source.connect(analyser);
        samples = new Uint8Array(analyser.fftSize);
        timer = setInterval(() => {
          if (!analyser || !samples) return;
          analyser.getByteTimeDomainData(samples);
          const next = Math.max(0, Math.min(1, rms(samples) * 3.2));
          levelRef.current = levelRef.current * 0.6 + next * 0.4;
        }, intervalMs);
        return true;
      } catch {
        await stop();
        return false;
      }
    },
    stop,
  };
}

function defaultGetUserMedia() {
  if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) return null;
  return (constraints) => navigator.mediaDevices.getUserMedia(constraints);
}

function defaultAudioContext() {
  if (typeof window === "undefined") return null;
  return window.AudioContext || window.webkitAudioContext || null;
}
