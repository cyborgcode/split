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

export interface UseSpeechResult {
  supported: boolean;
  listening: boolean;
  /** All finalized speech so far, concatenated. */
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
  const shouldListenRef = useRef(false);
  const committedRef = useRef<Map<number, { raw: string }>>(new Map());
  /** Results below this index belong to text the user already cleared. */
  const firstIndexRef = useRef(0);
  const lastLengthRef = useRef(0);

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
    rec.onresult = (event) => {
      const committed = committedRef.current;
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
      if (finalText) {
        setTranscript((prev) => prev + finalText);
        setError(null); // hearing speech again — a past hiccup is over
      }
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
      // A new recognition session numbers its results from 0 again.
      committedRef.current = new Map();
      firstIndexRef.current = 0;
      lastLengthRef.current = 0;
      setInterim("");
      if (shouldListenRef.current) {
        try {
          rec.start();
        } catch {
          shouldListenRef.current = false;
          setListening(false);
        }
      } else {
        setListening(false);
      }
    };

    recognitionRef.current = rec;
    return () => {
      shouldListenRef.current = false;
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
    try {
      rec.start();
      setListening(true);
    } catch {
      /* start() throws if already running — treat as listening */
      setListening(true);
    }
  }, []);

  const stop = useCallback(() => {
    shouldListenRef.current = false;
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
    setTranscript("");
    setInterim("");
  }, []);

  return { supported, listening, transcript, interim, error, start, stop, reset };
}
