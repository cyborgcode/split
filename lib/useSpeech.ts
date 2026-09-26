"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/* Minimal typings for the Web Speech API (not in lib.dom for all setups). */
interface SpeechRecognitionAlternativeLike {
  transcript: string;
}
interface SpeechRecognitionResultLike {
  isFinal: boolean;
  0: SpeechRecognitionAlternativeLike;
}
interface SpeechRecognitionEventLike {
  resultIndex: number;
  results: {
    length: number;
    [index: number]: SpeechRecognitionResultLike;
  };
}
interface SpeechRecognitionLike {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
}

declare global {
  interface Window {
    SpeechRecognition?: new () => SpeechRecognitionLike;
    webkitSpeechRecognition?: new () => SpeechRecognitionLike;
  }
}

/** Silence longer than this between utterances starts a new line. */
const PAUSE_BREAK_MS = 1500;

export interface UseSpeechResult {
  supported: boolean;
  listening: boolean;
  /** All finalized speech so far. Append-only; "\n" marks a long pause. */
  transcript: string;
  /** Words currently being spoken (not yet finalized). */
  interim: string;
  error: string | null;
  start: () => void;
  stop: () => void;
  reset: () => void;
}

/**
 * @param transform Optional filter applied to every recognized segment
 * (interim and final). Return "" to drop it — used to scrub the referee's
 * own TTS voice out of the transcript while listening continues in parallel.
 * Must be referentially stable (wrap in useCallback).
 */
export function useSpeech(
  lang = "en-US",
  transform?: (text: string) => string
): UseSpeechResult {
  const [supported, setSupported] = useState(true);
  const [listening, setListening] = useState(false);
  const [transcript, setTranscript] = useState("");
  const [interim, setInterim] = useState("");
  const [error, setError] = useState<string | null>(null);

  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const beginRef = useRef<(() => void) | null>(null);
  const shouldListenRef = useRef(false);
  const committedRef = useRef<Map<number, { raw: string }>>(new Map());
  /** Results below this index belong to text the user already cleared. */
  const firstIndexRef = useRef(0);
  const lastLengthRef = useRef(0);
  const lastFinalAtRef = useRef(0);
  /** An interim utterance is in progress. */
  const speakingRef = useRef(false);
  const breakPendingRef = useRef(false);
  /** Latest not-yet-final words (already filtered). */
  const pendingInterimRef = useRef("");
  const sessionStartRef = useRef(0);
  const sessionHeardRef = useRef(false);
  /** Recognition sessions in a row that died before hearing anything. */
  const quickFailsRef = useRef(0);
  const restartTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const Ctor = window.SpeechRecognition ?? window.webkitSpeechRecognition;
    if (!Ctor) {
      setSupported(false);
      return;
    }
    const rec = new Ctor();
    rec.continuous = true;
    rec.interimResults = true;
    rec.lang = lang;

    /* Finals are committed once per result index, so the transcript is
       append-only (findings anchor to character offsets in it). Re-reading
       every index — not just from resultIndex — also absorbs Android
       Chrome, which re-delivers earlier finals and sometimes repeats the
       previous final as the prefix of the next one. */
    const commit = (text: string, now: number) => {
      const brk = breakPendingRef.current;
      breakPendingRef.current = false;
      lastFinalAtRef.current = now;
      setTranscript((prev) => prev + (brk && prev ? "\n" : "") + text);
      setError(null); // hearing speech again — a past hiccup is over
    };

    const begin = () => {
      sessionStartRef.current = Date.now();
      sessionHeardRef.current = false;
      rec.start();
    };
    beginRef.current = begin;

    rec.onresult = (event) => {
      const committed = committedRef.current;
      const now = Date.now();
      let interimText = "";
      let finalText = "";
      for (let i = firstIndexRef.current; i < event.results.length; i++) {
        const result = event.results[i];
        const raw = (result[0]?.transcript ?? "").trim();
        if (!result.isFinal) {
          const text = transform ? transform(raw) : raw;
          if (text.trim()) interimText += (interimText ? " " : "") + text.trim();
          continue;
        }
        if (committed.has(i)) continue;
        let fresh = raw;
        const prev = committed.get(i - 1)?.raw;
        if (prev && prev.length >= 12 && fresh.toLowerCase().startsWith(prev.toLowerCase())) {
          fresh = fresh.slice(prev.length).trim();
        }
        // The filter runs once, when the final lands — the referee's words
        // stay scrubbed even after it stops talking.
        const text = transform ? transform(fresh) : fresh;
        committed.set(i, { raw });
        if (text.trim()) finalText += text.trim() + " ";
      }
      // A new utterance after a real silence usually means the other side
      // is answering — mark it with a line break so both the reader and
      // the model can follow the turns of the conversation.
      if (!speakingRef.current && (interimText || finalText)) {
        const last = lastFinalAtRef.current;
        if (last && now - last > PAUSE_BREAK_MS) breakPendingRef.current = true;
      }
      speakingRef.current = !!interimText;
      if (finalText) commit(finalText, now);
      if (finalText || interimText) {
        sessionHeardRef.current = true;
        quickFailsRef.current = 0;
      }
      pendingInterimRef.current = interimText;
      setInterim(interimText);
      lastLengthRef.current = event.results.length;
    };

    rec.onerror = (event) => {
      if (event.error === "not-allowed" || event.error === "service-not-allowed") {
        shouldListenRef.current = false;
        setListening(false);
        setError("Microphone access denied. Allow the mic and try again.");
      } else if (event.error !== "no-speech" && event.error !== "aborted") {
        setError(`Speech recognition error: ${event.error}`);
      }
    };

    // Chrome stops recognition after silence — restart while a session is active.
    rec.onend = () => {
      // iOS Safari often ends a session without ever marking its words
      // final — keep them instead of wiping them with the next session.
      const leftover = pendingInterimRef.current.trim();
      pendingInterimRef.current = "";
      if (leftover) commit(leftover + " ", Date.now());
      // A new recognition session numbers its results from 0 again.
      committedRef.current = new Map();
      firstIndexRef.current = 0;
      lastLengthRef.current = 0;
      speakingRef.current = false;
      setInterim("");
      if (!shouldListenRef.current) {
        setListening(false);
        return;
      }
      // Restart right away after a normal session. If sessions keep dying
      // instantly (mic busy, audio session switching on iPhone), back off
      // instead of thrashing the mic on and off.
      const died = !sessionHeardRef.current && Date.now() - sessionStartRef.current < 2000;
      quickFailsRef.current = died ? quickFailsRef.current + 1 : 0;
      if (quickFailsRef.current > 8) {
        shouldListenRef.current = false;
        setListening(false);
        setError("The microphone keeps stopping. Close other apps using the mic and tap the mic again.");
        return;
      }
      const delay = died ? Math.min(250 * 2 ** quickFailsRef.current, 4000) : 0;
      if (restartTimerRef.current) clearTimeout(restartTimerRef.current);
      restartTimerRef.current = setTimeout(() => {
        if (!shouldListenRef.current) return;
        try {
          begin();
        } catch {
          shouldListenRef.current = false;
          setListening(false);
        }
      }, delay);
    };

    recognitionRef.current = rec;
    return () => {
      shouldListenRef.current = false;
      if (restartTimerRef.current) clearTimeout(restartTimerRef.current);
      rec.onresult = null;
      rec.onerror = null;
      rec.onend = null;
      try {
        rec.stop();
      } catch {
        /* already stopped */
      }
    };
  }, [lang, transform]);

  const start = useCallback(() => {
    const rec = recognitionRef.current;
    if (!rec || shouldListenRef.current) return;
    setError(null);
    shouldListenRef.current = true;
    quickFailsRef.current = 0;
    try {
      beginRef.current?.();
      setListening(true);
    } catch {
      /* start() throws if already running — treat as listening */
      setListening(true);
    }
  }, []);

  const stop = useCallback(() => {
    shouldListenRef.current = false;
    if (restartTimerRef.current) clearTimeout(restartTimerRef.current);
    setListening(false);
    setInterim("");
    try {
      recognitionRef.current?.stop();
    } catch {
      /* already stopped */
    }
  }, []);

  const reset = useCallback(() => {
    // The live session keeps its old results — skip past them.
    firstIndexRef.current = lastLengthRef.current;
    pendingInterimRef.current = "";
    lastFinalAtRef.current = 0;
    breakPendingRef.current = false;
    setTranscript("");
    setInterim("");
  }, []);

  return { supported, listening, transcript, interim, error, start, stop, reset };
}
