"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/* Fallback listener for browsers without the Web Speech API (Firefox).
   Records the mic itself, cuts clips at natural pauses with a simple
   voice-activity detector, and queues them; the page sends the queue to
   Gemini, which transcribes and fact-checks in the same request. */

export interface AudioClip {
  /** Base64 audio, no data: prefix. */
  data: string;
  mimeType: string;
  bytes: number;
  /** A long silence came before this clip — likely the other debater. */
  pause?: boolean;
}

export interface UseAudioCaptureResult {
  supported: boolean;
  listening: boolean;
  /** Someone is talking right now (drives the wave bar). */
  talking: boolean;
  /** Transcript built from Gemini's transcriptions. Append-only. */
  transcript: string;
  error: string | null;
  start: () => Promise<void>;
  stop: () => void;
  reset: () => void;
  /** Adds transcribed words; returns the new full transcript. */
  append: (text: string, pauseBefore: boolean) => string;
  /** Takes every queued clip (oldest first). */
  takeClips: () => AudioClip[];
  /** Puts clips back at the front after a failed send. */
  returnClips: (clips: AudioClip[]) => void;
  hasClips: () => boolean;
}

const MIME_CANDIDATES = [
  "audio/ogg;codecs=opus",
  "audio/webm;codecs=opus",
  "audio/webm",
  "audio/mp4",
];
const TICK_MS = 100;
/** Silence this long after speech ends a clip — a natural pause. */
const PAUSE_MS = 700;
/** Less voiced time than this is a cough or a click — dropped. */
const MIN_SPEECH_MS = 400;
/** Cut long monologues so they still get checked mid-flow. */
const MAX_CLIP_MS = 15000;
/** Keep at most this much unsent audio (base64 bytes) during an outage. */
const MAX_QUEUED_BYTES = 2_000_000;
/** Silence between clips longer than this marks a turn change. */
const TURN_GAP_MS = 1500;

export function audioCaptureSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.MediaRecorder !== "undefined" &&
    !!navigator.mediaDevices?.getUserMedia
  );
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1] ?? "");
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

/**
 * @param suspended While true (the referee is talking), audio is thrown
 * away so the referee's own voice is never transcribed and fact-checked.
 */
export function useAudioCapture(suspended: () => boolean): UseAudioCaptureResult {
  const [supported, setSupported] = useState(true);
  const [listening, setListening] = useState(false);
  const [talking, setTalking] = useState(false);
  const [transcript, setTranscript] = useState("");
  const [error, setError] = useState<string | null>(null);

  const transcriptRef = useRef("");
  const queueRef = useRef<AudioClip[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  const ctxRef = useRef<AudioContext | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const activeRef = useRef(false);
  const suspendedRef = useRef(suspended);
  suspendedRef.current = suspended;

  useEffect(() => setSupported(audioCaptureSupported()), []);

  const teardown = useCallback(() => {
    activeRef.current = false;
    if (timerRef.current) clearInterval(timerRef.current);
    timerRef.current = null;
    const rec = recorderRef.current;
    recorderRef.current = null;
    if (rec && rec.state !== "inactive") {
      rec.ondataavailable = null;
      try {
        rec.stop();
      } catch {
        /* already stopped */
      }
    }
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    void ctxRef.current?.close().catch(() => {});
    ctxRef.current = null;
    setTalking(false);
  }, []);

  useEffect(() => teardown, [teardown]);

  const start = useCallback(async () => {
    if (activeRef.current) return;
    setError(null);
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
    } catch {
      setError("Microphone access denied. Allow the mic and try again.");
      return;
    }
    const mimeType = MIME_CANDIDATES.find((m) => MediaRecorder.isTypeSupported(m)) ?? "";
    streamRef.current = stream;
    activeRef.current = true;
    setListening(true);

    const ctx = new AudioContext();
    void ctx.resume().catch(() => {});
    ctxRef.current = ctx;
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;
    ctx.createMediaStreamSource(stream).connect(analyser);
    const samples = new Float32Array(analyser.fftSize);

    /* One recorder per clip, so every clip is a complete, decodable file. */
    let clipStart = 0;
    let voicedMs = 0;
    let lastVoiceAt = 0;
    let lastClipEndAt = 0;
    let pauseBefore = false;
    let noiseFloor = 0.01;

    const beginClip = () => {
      if (!activeRef.current || !streamRef.current) return;
      const rec = mimeType
        ? new MediaRecorder(streamRef.current, { mimeType })
        : new MediaRecorder(streamRef.current);
      const parts: Blob[] = [];
      rec.ondataavailable = (e) => {
        if (e.data.size) parts.push(e.data);
      };
      recorderRef.current = rec;
      clipStart = Date.now();
      voicedMs = 0;
      lastVoiceAt = 0;
      rec.start();
      return { rec, parts };
    };

    let current = beginClip();

    /** Ends the clip in progress; keeps it only if it held real speech. */
    const cutClip = (keep: boolean) => {
      const clip = current;
      if (!clip) return;
      const hadPause = pauseBefore;
      clip.rec.onstop = async () => {
        if (!keep || !clip.parts.length) return;
        const blob = new Blob(clip.parts, { type: clip.rec.mimeType || mimeType });
        try {
          const data = await blobToBase64(blob);
          const q = queueRef.current;
          q.push({
            data,
            mimeType: (blob.type || "audio/ogg").split(";")[0],
            bytes: data.length,
            pause: hadPause,
          });
          // During a long outage, drop the oldest audio rather than grow forever.
          let total = q.reduce((n, c) => n + c.bytes, 0);
          while (total > MAX_QUEUED_BYTES && q.length > 1) total -= q.shift()!.bytes;
        } catch {
          /* unreadable clip — skip it */
        }
      };
      try {
        clip.rec.stop();
      } catch {
        /* already stopped */
      }
      if (keep) lastClipEndAt = Date.now();
      current = beginClip();
    };

    timerRef.current = setInterval(() => {
      if (!activeRef.current) return;
      analyser.getFloatTimeDomainData(samples);
      let sum = 0;
      for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
      const rms = Math.sqrt(sum / samples.length);
      // Track the room's background level so the detector adapts to it.
      noiseFloor = rms < noiseFloor ? rms : noiseFloor * 0.995 + rms * 0.005;
      const voiced = rms > Math.max(0.015, noiseFloor * 2.5);
      const now = Date.now();
      setTalking(voiced);

      // The referee is speaking — discard, so it never hears itself.
      if (suspendedRef.current()) {
        if (now - clipStart > 300) cutClip(false);
        return;
      }
      if (voiced) {
        if (voicedMs === 0) pauseBefore = !!lastClipEndAt && now - lastClipEndAt > TURN_GAP_MS;
        voicedMs += TICK_MS;
        lastVoiceAt = now;
      }
      const age = now - clipStart;
      if (voicedMs >= MIN_SPEECH_MS) {
        if (now - lastVoiceAt >= PAUSE_MS || age >= MAX_CLIP_MS) cutClip(true);
      } else if (age > 8000 && now - lastVoiceAt > 2000) {
        cutClip(false); // only silence or noise — don't send it
      }
    }, TICK_MS);
  }, []);

  const stop = useCallback(() => {
    // Keep whatever was said right before stopping.
    const rec = recorderRef.current;
    if (rec && rec.state !== "inactive") {
      const parts: Blob[] = [];
      rec.ondataavailable = (e) => {
        if (e.data.size) parts.push(e.data);
      };
      rec.onstop = async () => {
        if (!parts.length) return;
        const blob = new Blob(parts, { type: rec.mimeType });
        if (blob.size < 2000) return;
        try {
          const data = await blobToBase64(blob);
          queueRef.current.push({
            data,
            mimeType: (blob.type || "audio/ogg").split(";")[0],
            bytes: data.length,
          });
        } catch {
          /* skip */
        }
      };
      try {
        rec.stop();
      } catch {
        /* already stopped */
      }
      recorderRef.current = null;
    }
    teardown();
    setListening(false);
  }, [teardown]);

  const reset = useCallback(() => {
    queueRef.current = [];
    transcriptRef.current = "";
    setTranscript("");
  }, []);

  const append = useCallback((text: string, pauseBefore: boolean) => {
    const words = text.trim();
    if (!words) return transcriptRef.current;
    const prev = transcriptRef.current;
    const next = prev + (pauseBefore && prev ? "\n" : "") + words + " ";
    transcriptRef.current = next;
    setTranscript(next);
    return next;
  }, []);

  const takeClips = useCallback(() => {
    const clips = queueRef.current;
    queueRef.current = [];
    return clips;
  }, []);

  const returnClips = useCallback((clips: AudioClip[]) => {
    queueRef.current = [...clips, ...queueRef.current];
  }, []);

  const hasClips = useCallback(() => queueRef.current.length > 0, []);

  return {
    supported,
    listening,
    talking,
    transcript,
    error,
    start,
    stop,
    reset,
    append,
    takeClips,
    returnClips,
    hasClips,
  };
}
