"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useSpeech } from "@/lib/useSpeech";
import WaveBar from "@/components/WaveBar";
import {
  ClearIcon,
  MicIcon,
  MuteIcon,
  ScaleIcon,
  SearchIcon,
  StopIcon,
  VolumeIcon,
} from "@/components/Icons";
import type { AnalyzeResponse, FactCheckFinding, Finding } from "@/lib/types";

interface PlacedFinding {
  id: number;
  finding: Finding;
  /** Transcript offset the card is woven in at (just after the quote). */
  offset: number;
}

/* Gemini's free tier allows 15 requests/min per model. Spacing requests
   4.5s apart keeps us at ~13/min — under the cap even with network jitter. */
const ANALYZE_INTERVAL_MS = 5000;
const MIN_SPACING_MS = 4500;
const MIN_CHUNK_CHARS = 40;
const MAX_WAIT_MS = 10000;
const CONTEXT_CHARS = 1500;
const REPEAT_WINDOW_MS = 180000;

const VERDICT_LABEL: Record<string, string> = {
  false: "False",
  misleading: "Misleading",
  unverifiable: "Unverifiable",
};

/* Filler words say nothing about whether a phrase came from the referee. */
const STOP_WORDS = new Set(
  "a an and are as at be but by for from has have he her his i if in is it its of on or our she so that the their them there they this to was we were what when which who will with you your s t".split(
    " "
  )
);

function normalizeQuote(q: string): string {
  return q.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function modelLabel(model: string): string {
  return model
    .replace(/^gemini-/, "")
    .split("-")
    .map((w) => (/^\d/.test(w) ? w : w[0].toUpperCase() + w.slice(1)))
    .join(" ")
    .replace("Flash Lite", "Flash-Lite");
}

function tagLabel(f: Finding): string {
  return f.type === "fallacy" ? f.fallacy_name : VERDICT_LABEL[f.verdict];
}

function verdictClass(f: Finding): string {
  return `v-${f.type === "fallacy" ? "fallacy" : f.verdict}`;
}

/** What the referee says out loud when it cuts in. */
function ttsText(f: Finding): string {
  if (f.type === "fallacy") {
    const article = /^[aeiou]/i.test(f.fallacy_name) ? "an" : "a";
    return `Foul! That's ${article} ${f.fallacy_name}. ${f.explanation}`;
  }
  const lead =
    f.verdict === "false"
      ? "Stop right there — that's false! Here's the truth:"
      : f.verdict === "misleading"
        ? "Hold on — that's misleading. Actually:"
        : "Careful — that claim can't be verified.";
  const source = f.source_name ? ` Source: ${f.source_name}.` : "";
  return `${lead} ${f.correction}${source}`;
}

/**
 * Where a finding's card goes: right after its quote in the transcript,
 * snapped to the end of that word. Falls back to the end of the text.
 */
function anchorOffset(transcript: string, quote: string, from: number): number {
  const lower = transcript.toLowerCase();
  const q = quote.toLowerCase().trim();
  let idx = q ? lower.indexOf(q, Math.max(0, from - q.length)) : -1;
  if (idx < 0 && q.length > 24) idx = lower.indexOf(q.slice(0, 24), from);
  if (idx < 0) return transcript.length;
  const end = idx + (lower.startsWith(q, idx) ? q.length : 24);
  const space = transcript.indexOf(" ", end);
  return space < 0 ? transcript.length : space;
}

type VoiceMode = "off" | "browser";

type AudioWindow = Window & { webkitAudioContext?: typeof AudioContext };

export default function Home() {
  /* What the referee is currently saying out loud. Recognition keeps running
     while it speaks, so segments that are mostly the referee's own words are
     scrubbed from the transcript instead of being fact-checked back at it.
     Only content words count — "that is not true" shares "that"/"is" with
     almost any callout and must not be dropped. */
  const calloutTextRef = useRef("");
  const echoFilter = useCallback((text: string) => {
    const spoken = calloutTextRef.current;
    if (!spoken) return text;
    const spokenWords = new Set(normalizeQuote(spoken).split(" "));
    const words = normalizeQuote(text)
      .split(" ")
      .filter((w) => w && !STOP_WORDS.has(w));
    if (words.length === 0) return text;
    const matches = words.filter((w) => spokenWords.has(w)).length;
    return matches / words.length > 0.6 ? "" : text;
  }, []);

  const { supported, listening, transcript, interim, error, start, stop, reset } =
    useSpeech("en-US", echoFilter);

  const [sessionActive, setSessionActive] = useState(false);
  const [findings, setFindings] = useState<PlacedFinding[]>([]);
  const [analyzing, setAnalyzing] = useState(false);
  const [apiError, setApiError] = useState<string | null>(null);
  const [rateLimited, setRateLimited] = useState(false);
  const [quotaExhausted, setQuotaExhausted] = useState(false);
  const [voiceMode, setVoiceMode] = useState<VoiceMode>("browser");
  const [voiceName, setVoiceName] = useState(""); // "" = auto
  const [pickerOpen, setPickerOpen] = useState(false);
  const [browserVoices, setBrowserVoices] = useState<string[]>([]);
  const [webSearch, setWebSearch] = useState(true);
  const [speakingFinding, setSpeakingFinding] = useState<Finding | null>(null);
  const [viewedId, setViewedId] = useState<number | null>(null);
  const [aiConfigured, setAiConfigured] = useState<boolean | null>(null);
  const [model, setModel] = useState("");
  const [note, setNote] = useState<string | null>(null);
  const noteTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const transcriptRef = useRef("");
  const interimRef = useRef("");
  const analyzedRef = useRef(0);
  const lastChunkRef = useRef("");
  const pendingSinceRef = useRef<number | null>(null);
  const inFlightRef = useRef(false);
  /** Quote → when it was last flagged; repeats re-alert after 3 minutes. */
  const seenQuotesRef = useRef<Map<string, number>>(new Map());
  const nextIdRef = useRef(1);
  /** Bumped on reset so answers to requests sent before it are dropped. */
  const epochRef = useRef(0);
  const voiceModeRef = useRef<VoiceMode>(voiceMode);
  const voiceNameRef = useRef(voiceName);
  const webSearchRef = useRef(webSearch);
  const speakQueueRef = useRef<Finding[]>([]);
  const speakingRef = useRef(false);
  /** Bumped on stop so a callout still waiting on its alert stays silent. */
  const speechEpochRef = useRef(0);
  const transcriptElRef = useRef<HTMLDivElement>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);

  transcriptRef.current = transcript;
  interimRef.current = interim;
  voiceModeRef.current = voiceMode;
  voiceNameRef.current = voiceName;
  webSearchRef.current = webSearch;

  const flash = useCallback((text: string) => {
    setNote(text);
    if (noteTimerRef.current) clearTimeout(noteTimerRef.current);
    noteTimerRef.current = setTimeout(() => setNote(null), 8000);
  }, []);

  // Pre-pick an English TTS voice; voices often load async.
  const ttsVoiceRef = useRef<SpeechSynthesisVoice | null>(null);
  useEffect(() => {
    if (!("speechSynthesis" in window)) return;
    const pick = () => {
      const voices = window.speechSynthesis.getVoices();
      ttsVoiceRef.current =
        voices.find(
          (v) => v.lang.startsWith("en") && /Google US|Samantha|Aria|Zira/i.test(v.name)
        ) ??
        voices.find((v) => v.lang.startsWith("en")) ??
        voices[0] ??
        null;
      setBrowserVoices(
        voices.filter((v) => v.lang.startsWith("en")).map((v) => v.name)
      );
    };
    pick();
    window.speechSynthesis.addEventListener("voiceschanged", pick);
    return () => window.speechSynthesis.removeEventListener("voiceschanged", pick);
  }, []);

  // Restore device preferences.
  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem("split-voice") ?? "null");
      if (saved?.mode) setVoiceMode(saved.mode === "off" ? "off" : "browser");
      if (typeof saved?.pick?.browser === "string") setVoiceName(saved.pick.browser);
      setWebSearch(localStorage.getItem("split-web-search") !== "off");
    } catch {
      /* corrupted or blocked storage — keep defaults */
    }
  }, []);
  useEffect(() => {
    try {
      localStorage.setItem(
        "split-voice",
        JSON.stringify({ mode: voiceMode, pick: { browser: voiceName } })
      );
      localStorage.setItem("split-web-search", webSearch ? "on" : "off");
    } catch {
      /* private mode — not persisted */
    }
  }, [voiceMode, voiceName, webSearch]);

  // Verify server setup once on load so a missing key never fails silently.
  useEffect(() => {
    fetch("/api/health")
      .then((r) => r.json())
      .then((h) => {
        setAiConfigured(!!h.ai);
        if (typeof h.model === "string") setModel(h.model);
      })
      .catch(() => setAiConfigured(null));
  }, []);

  /* ── Sounds — all on one AudioContext, unlocked by the mic tap (iOS
     keeps contexts created outside a user gesture silent). ─────────────── */
  const getAudioCtx = useCallback((): AudioContext | null => {
    if (!audioCtxRef.current) {
      const Ctx = window.AudioContext ?? (window as AudioWindow).webkitAudioContext;
      if (!Ctx) return null;
      audioCtxRef.current = new Ctx();
    }
    const ctx = audioCtxRef.current;
    if (ctx.state === "suspended") void ctx.resume().catch(() => {});
    return ctx;
  }, []);

  const tone = useCallback(
    (type: OscillatorType, freqs: [number, number][], volume: number, seconds: number) => {
      try {
        const ctx = getAudioCtx();
        if (!ctx) return;
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = type;
        for (const [hz, at] of freqs) osc.frequency.setValueAtTime(hz, ctx.currentTime + at);
        gain.gain.setValueAtTime(volume, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + seconds);
        osc.connect(gain).connect(ctx.destination);
        osc.start();
        osc.stop(ctx.currentTime + seconds);
      } catch {
        /* audio is best-effort */
      }
    },
    [getAudioCtx]
  );

  const chime = useCallback(() => {
    tone("sine", [[880, 0]], 0.15, 0.4);
    if (navigator.vibrate) navigator.vibrate(200);
  }, [tone]);

  /** Sharp game-show buzzer — fallback if the alert sound file fails. */
  const buzzer = useCallback(() => {
    tone("square", [[220, 0], [160, 0.18]], 0.3, 0.45);
  }, [tone]);

  /* Alert sound played before the referee speaks. Fetched once and decoded
     lazily against the shared AudioContext. */
  const alertBytesRef = useRef<ArrayBuffer | null>(null);
  const alertBufferRef = useRef<AudioBuffer | null>(null);
  const alertSourceRef = useRef<AudioBufferSourceNode | null>(null);
  useEffect(() => {
    fetch("/alert.mp3")
      .then((r) => (r.ok ? r.arrayBuffer() : null))
      .then((bytes) => {
        alertBytesRef.current = bytes;
      })
      .catch(() => {});
  }, []);

  /** Plays the alert sound to completion; falls back to the buzzer. */
  const playAlert = useCallback(async (): Promise<void> => {
    const ctx = getAudioCtx();
    try {
      if (ctx) {
        if (!alertBufferRef.current && alertBytesRef.current) {
          // decodeAudioData detaches the buffer — hand it a copy
          alertBufferRef.current = await ctx.decodeAudioData(
            alertBytesRef.current.slice(0)
          );
        }
        const buffer = alertBufferRef.current;
        if (buffer) {
          await new Promise<void>((resolve) => {
            const src = ctx.createBufferSource();
            src.buffer = buffer;
            src.connect(ctx.destination);
            alertSourceRef.current = src;
            const safety = setTimeout(resolve, buffer.duration * 1000 + 500);
            src.onended = () => {
              clearTimeout(safety);
              alertSourceRef.current = null;
              resolve();
            };
            src.start();
          });
          return;
        }
      }
    } catch {
      /* fall through to the buzzer */
    }
    buzzer();
    await new Promise((r) => setTimeout(r, 450));
  }, [buzzer, getAudioCtx]);

  /* ── Spoken interruptions — browser speech synthesis ────────────────── */
  const speakWithBrowserTts = useCallback((text: string): Promise<void> => {
    return new Promise((resolve) => {
      if (!("speechSynthesis" in window)) return resolve();
      const synth = window.speechSynthesis;
      const utter = new SpeechSynthesisUtterance(text);
      utter.rate = 1.15;
      utter.volume = 1;
      utter.lang = "en-US";
      const picked = voiceNameRef.current
        ? synth.getVoices().find((v) => v.name === voiceNameRef.current)
        : null;
      const chosen = picked ?? ttsVoiceRef.current;
      if (chosen) utter.voice = chosen;

      // Chrome silently pauses long utterances; nudge it while speaking.
      const keepAlive = setInterval(() => synth.resume(), 4000);
      let finished = false;
      const done = () => {
        if (finished) return;
        finished = true;
        clearInterval(keepAlive);
        clearTimeout(watchdog);
        resolve();
      };
      // Some engines never fire onend (e.g. an utterance dropped right after
      // cancel()) — give up after roughly how long the text takes to say,
      // instead of freezing the overlay for a fixed 25 seconds.
      const watchdog = setTimeout(() => {
        synth.cancel();
        done();
      }, 3000 + text.length * 80);
      utter.onend = done;
      utter.onerror = done;
      if (synth.speaking || synth.pending) {
        // Chrome can drop a speak() issued in the same tick as cancel().
        synth.cancel();
        setTimeout(() => synth.speak(utter), 60);
      } else {
        synth.speak(utter);
      }
    });
  }, []);

  const calloutClearTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const drainSpeakQueue = useCallback(() => {
    if (speakingRef.current) return;
    const next = speakQueueRef.current.shift();
    if (!next) return;
    speakingRef.current = true;
    // Recognition keeps running in parallel — the echo filter scrubs the
    // referee's own voice so the debaters' words are never lost.
    setSpeakingFinding(next);
    if (navigator.vibrate) navigator.vibrate([120, 60, 120]);

    const speechEpoch = speechEpochRef.current;
    void (async () => {
      const text = ttsText(next);
      if (calloutClearTimerRef.current) clearTimeout(calloutClearTimerRef.current);
      calloutTextRef.current = text;
      // The alert grabs the room's attention; the voice cuts in over its
      // tail instead of waiting for it to finish.
      const alertDone = playAlert();
      await new Promise((r) => setTimeout(r, 900));
      if (speechEpoch === speechEpochRef.current) await speakWithBrowserTts(text);
      await alertDone.catch(() => {});
      // recognition finals lag behind the audio — keep filtering briefly
      calloutClearTimerRef.current = setTimeout(() => {
        if (!speakingRef.current) calloutTextRef.current = "";
      }, 2500);
      speakingRef.current = false;
      setSpeakingFinding(null);
      drainSpeakQueue();
    })();
  }, [playAlert, speakWithBrowserTts]);

  const interrupt = useCallback(
    (fresh: Finding[]) => {
      if (voiceModeRef.current !== "off") {
        speakQueueRef.current.push(...fresh);
        drainSpeakQueue();
      } else {
        chime();
      }
    },
    [drainSpeakQueue, chime]
  );

  const skipSpeaking = useCallback(() => {
    window.speechSynthesis?.cancel(); // fires onend/onerror → queue drains
    try {
      alertSourceRef.current?.stop();
    } catch {
      /* already stopped */
    }
  }, []);

  /* ── Analysis loop ──────────────────────────────────────────────────── */
  /** Swap in a live source once it lands — never blocks the callout. */
  const enrichSource = useCallback((id: number, f: FactCheckFinding) => {
    if (!webSearchRef.current) return; // toggled off — keep the AI's citation
    const query = f.search_query || f.correction;
    fetch("/api/source", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query }),
    })
      .then((r) => (r.ok ? r.json() : null))
      .then((s) => {
        if (!s?.source_url) return;
        setFindings((prev) =>
          prev.map((pf) =>
            pf.id === id && pf.finding.type === "fact_check"
              ? {
                  ...pf,
                  finding: {
                    ...pf.finding,
                    source_name: s.source_name || pf.finding.source_name,
                    source_url: s.source_url,
                  },
                }
              : pf
          )
        );
      })
      .catch(() => {});
  }, []);

  const cooldownUntilRef = useRef(0);
  const lastSentAtRef = useRef(0);
  const analyze = useCallback(async (force = false) => {
    if (inFlightRef.current) return;
    if (Date.now() < cooldownUntilRef.current) return; // backing off a rate limit
    // Event-driven ticks can fire often — keep request spacing quota-safe.
    if (!force && Date.now() - lastSentAtRef.current < MIN_SPACING_MS) return;
    const finalText = transcriptRef.current;
    // Include words still being spoken so continuous talkers get checked
    // without waiting for a pause. Only finalized text advances the analyzed
    // pointer — the live tail is re-sent next tick and deduped by quote.
    const live = interimRef.current.trim();
    const combined = live ? `${finalText} ${live}` : finalText;
    // Cap what we send — an unbounded chunk would trip the server's length
    // limit forever, since the pointer only advances on success.
    const chunk = combined.slice(analyzedRef.current).trim().slice(-3500);
    if (!chunk) return;
    if (chunk === lastChunkRef.current) return; // nothing new since last send

    const pendingSince = pendingSinceRef.current ?? Date.now();
    pendingSinceRef.current = pendingSince;
    const waitedLongEnough = Date.now() - pendingSince >= MAX_WAIT_MS;
    if (chunk.length < MIN_CHUNK_CHARS && !waitedLongEnough) return;

    inFlightRef.current = true;
    lastChunkRef.current = chunk;
    lastSentAtRef.current = Date.now();
    const sentFrom = analyzedRef.current;
    const sentUpTo = finalText.length;
    const epoch = epochRef.current;
    setAnalyzing(true);
    try {
      const context = finalText
        .slice(Math.max(0, sentFrom - CONTEXT_CHARS), sentFrom)
        .trim();
      const res = await fetch("/api/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chunk, context }),
        signal: AbortSignal.timeout(28000),
      });
      if (epoch !== epochRef.current) return; // cleared while in flight
      if (!res.ok) {
        lastChunkRef.current = ""; // failed — let the next tick retry this chunk
        const data = await res.json().catch(() => null);
        if (res.status === 429 && data?.daily_quota) {
          // Every model's daily cap is spent — poll gently until it resets.
          setQuotaExhausted(true);
          cooldownUntilRef.current = Date.now() + 60000;
          return;
        }
        if (res.status === 429 || res.status === 503 || res.status === 504) {
          // transient rate limit / overload / timeout — back off quietly
          setRateLimited(true);
          cooldownUntilRef.current = Date.now() + (res.status === 429 ? 15000 : 6000);
          return;
        }
        setApiError(data?.error ?? `Analysis failed (HTTP ${res.status})`);
        return;
      }
      setApiError(null);
      setRateLimited(false);
      setQuotaExhausted(false);
      analyzedRef.current = sentUpTo;
      pendingSinceRef.current = null;

      const data: AnalyzeResponse = await res.json();
      if (data.model) setModel(data.model);
      const now = Date.now();
      const fresh = data.findings.filter((f) => {
        const key = `${f.type}:${normalizeQuote(f.quote)}`;
        const lastFlagged = seenQuotesRef.current.get(key);
        if (lastFlagged && now - lastFlagged < REPEAT_WINDOW_MS) return false;
        seenQuotesRef.current.set(key, now);
        return true;
      });
      if (fresh.length > 0) {
        const text = transcriptRef.current;
        const placed = fresh
          .map((finding) => ({
            id: nextIdRef.current++,
            finding,
            offset: anchorOffset(text, finding.quote, sentFrom),
          }))
          .sort((a, b) => a.offset - b.offset);
        setFindings((prev) => {
          // Cards render in order, so never anchor before an earlier card.
          const floor = prev.length ? prev[prev.length - 1].offset : 0;
          return [...prev, ...placed.map((p) => ({ ...p, offset: Math.max(p.offset, floor) }))];
        });
        // Speak first; live sources swap in whenever the search lands.
        for (const p of placed) {
          if (p.finding.type === "fact_check") enrichSource(p.id, p.finding);
        }
        interrupt(fresh);
      } else if (data.findings.length > 0) {
        // Flagged, but identical to a recent callout — don't claim "accurate".
        flash("Repeated claim — already called out");
      } else if ((data.claims_checked ?? 0) > 0) {
        // Prove the referee is working even when nobody is wrong.
        const n = data.claims_checked!;
        flash(`${n} claim${n === 1 ? "" : "s"} checked — all accurate`);
      }
    } catch {
      if (epoch !== epochRef.current) return;
      lastChunkRef.current = ""; // failed — let the next tick retry this chunk
      setApiError("Network error while analyzing. Retrying…");
    } finally {
      if (epoch === epochRef.current) {
        inFlightRef.current = false;
        setAnalyzing(false);
      }
    }
  }, [interrupt, enrichSource, flash]);

  // Fallback ticker — catches long unfinalized monologues and retries
  // after a cooldown even if nobody says anything new.
  useEffect(() => {
    if (!sessionActive) return;
    const timer = setInterval(() => void analyze(), ANALYZE_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [sessionActive, analyze]);

  // Primary trigger: check the moment new speech is finalized instead of
  // waiting for the next tick (analyze() itself enforces request spacing).
  useEffect(() => {
    if (!sessionActive || !transcript) return;
    void analyze();
  }, [transcript, sessionActive, analyze]);

  /* ── Session controls ───────────────────────────────────────────────── */
  const handleStart = useCallback(() => {
    setApiError(null);
    setSessionActive(true);
    // Unlock audio output on this user gesture (required on iOS): resume the
    // shared AudioContext and speak a silent utterance so later callouts
    // are allowed to make sound.
    getAudioCtx();
    if ("speechSynthesis" in window) {
      window.speechSynthesis.cancel();
      const unlock = new SpeechSynthesisUtterance(" ");
      unlock.volume = 0;
      window.speechSynthesis.speak(unlock);
    }
    start();
  }, [start, getAudioCtx]);

  const flushTimersRef = useRef<ReturnType<typeof setTimeout>[]>([]);
  const handleStop = useCallback(() => {
    setSessionActive(false);
    speechEpochRef.current++;
    speakQueueRef.current = [];
    window.speechSynthesis?.cancel();
    try {
      alertSourceRef.current?.stop();
    } catch {
      /* already stopped */
    }
    stop();
    // The last words finalize a beat after stop(), and a request may still
    // be in flight — try the final short chunk a few times so it isn't lost.
    flushTimersRef.current.forEach(clearTimeout);
    flushTimersRef.current = [0, 1200, 3000, 6000].map((ms) =>
      setTimeout(() => {
        pendingSinceRef.current = 0;
        void analyze(true);
      }, ms)
    );
  }, [stop, analyze]);

  const handleReset = useCallback(() => {
    flushTimersRef.current.forEach(clearTimeout);
    epochRef.current++;
    inFlightRef.current = false;
    setAnalyzing(false);
    reset();
    setFindings([]);
    setApiError(null);
    setNote(null);
    analyzedRef.current = 0;
    lastChunkRef.current = "";
    pendingSinceRef.current = null;
    seenQuotesRef.current.clear();
  }, [reset]);

  // Keep the newest words in view — unless the reader scrolled up.
  const stickToBottomRef = useRef(true);
  useEffect(() => {
    const el = transcriptElRef.current;
    if (el && stickToBottomRef.current) el.scrollTop = el.scrollHeight;
  }, [transcript, interim, findings]);

  // Close overlays with Escape.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setPickerOpen(false);
      setViewedId(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  /* ── Render: transcript with findings woven in at their offsets ─────── */
  // Looked-up live so background source updates show in the open overlay.
  const viewedFinding =
    viewedId === null
      ? null
      : (findings.find((pf) => pf.id === viewedId)?.finding ?? null);
  const segments: React.ReactNode[] = [];
  let cursor = 0;
  for (const pf of findings) {
    const text = transcript.slice(cursor, pf.offset).trim();
    if (text) segments.push(<span key={`t${pf.id}`}>{text} </span>);
    cursor = Math.max(cursor, pf.offset);
    const f = pf.finding;
    segments.push(
      <span
        key={`f${pf.id}`}
        className={`inline-card ${verdictClass(f)}`}
        role="button"
        tabIndex={0}
        onClick={() => setViewedId(pf.id)}
        onKeyDown={(e) => e.key === "Enter" && setViewedId(pf.id)}
      >
        <span className="tag">{tagLabel(f)}</span>
        <span className="body">
          {f.type === "fallacy" ? f.explanation : f.correction}
        </span>
        {f.type === "fact_check" && f.source_name && (
          <span className="source">
            {f.source_url ? (
              <a
                href={f.source_url}
                target="_blank"
                rel="noreferrer"
                onClick={(e) => e.stopPropagation()}
              >
                {f.source_name}
              </a>
            ) : (
              f.source_name
            )}
          </span>
        )}
      </span>
    );
  }
  const tailText = transcript.slice(cursor).trim();

  const factCount = findings.filter((pf) => pf.finding.type === "fact_check").length;
  const fallacyCount = findings.length - factCount;

  const status = speakingFinding
    ? { text: "Referee speaking", tone: "alert" }
    : !sessionActive
      ? { text: "Mic off", tone: "idle" }
      : quotaExhausted
        ? { text: "Daily quota used up", tone: "warn" }
        : rateLimited
          ? { text: "Gemini busy — retrying", tone: "warn" }
          : analyzing
            ? { text: "Fact-checking", tone: "busy" }
            : !listening
              ? { text: "Paused", tone: "idle" }
              : note
                ? { text: note, tone: "ok" }
                : { text: "Listening", tone: "live" };

  const overlayFinding = speakingFinding ?? viewedFinding;

  return (
    <main className="stage">
      <header className="topbar">
        <div className="brand">
          <ScaleIcon size={20} />
          <span>Split</span>
        </div>
        <div className="topbar-right">
          {findings.length > 0 && (
            <span className="counts" aria-label="Callouts so far">
              {factCount > 0 && (
                <span className="count v-false">
                  {factCount} claim{factCount === 1 ? "" : "s"}
                </span>
              )}
              {fallacyCount > 0 && (
                <span className="count v-fallacy">
                  {fallacyCount} fallac{fallacyCount === 1 ? "y" : "ies"}
                </span>
              )}
            </span>
          )}
          {model && aiConfigured !== false && (
            <span className="model-chip" title={`Fact-checking with ${model}`}>
              {modelLabel(model)}
            </span>
          )}
        </div>
      </header>

      {aiConfigured === false && (
        <div className="banner warn">
          <strong>Setup needed:</strong> no Gemini key is configured, so nothing
          will be fact-checked. Add <code>GEMINI_API_KEY</code> (free at{" "}
          <a href="https://aistudio.google.com/apikey" target="_blank" rel="noreferrer">
            aistudio.google.com/apikey
          </a>
          ) to your environment variables and redeploy.
        </div>
      )}
      {!supported && (
        <div className="banner warn">
          This browser doesn&apos;t support live speech recognition. Use Chrome,
          Edge, or Safari.
        </div>
      )}
      {quotaExhausted && (
        <div className="banner warn">
          Today&apos;s free Gemini quota is used up. Listening continues, and
          fact-checking resumes by itself when the quota resets at midnight
          Pacific time.
        </div>
      )}
      {(error || apiError) && (
        <div className="banner error" role="alert">
          <span>{error ?? apiError}</span>
          {apiError && !error && (
            <button className="banner-close" onClick={() => setApiError(null)} aria-label="Dismiss">
              ×
            </button>
          )}
        </div>
      )}

      <div
        className="transcript"
        ref={transcriptElRef}
        onScroll={(e) => {
          const el = e.currentTarget;
          stickToBottomRef.current =
            el.scrollHeight - el.scrollTop - el.clientHeight < 80;
        }}
      >
        {transcript || interim || findings.length > 0 ? (
          <p>
            {segments}
            {tailText && <span>{tailText} </span>}
            {interim && <span className="interim">{interim}</span>}
          </p>
        ) : (
          <div className="hint">
            <div className="mark">
              <ScaleIcon size={40} />
            </div>
            <h1>Your AI debate referee</h1>
            <p>
              Place the phone between you, tap the mic, and argue. When someone
              gets a fact wrong or slips into a fallacy, the referee cuts in out
              loud with the correction and a source.
            </p>
            <p className="try">
              Try saying: <em>&ldquo;The Great Wall of China is visible from the
              Moon.&rdquo;</em>
            </p>
          </div>
        )}
      </div>

      <div className="dock">
        <WaveBar active={sessionActive} />
        <div className="controls">
          <div className="controls-side left">
            <button
              className={`side-btn ${voiceMode !== "off" ? "active" : ""}`}
              onClick={() => setPickerOpen(true)}
              title="Referee voice"
              aria-label="Referee voice"
            >
              {voiceMode === "off" ? <MuteIcon /> : <VolumeIcon />}
            </button>
            <button
              className={`side-btn ${webSearch ? "active" : ""}`}
              onClick={() => setWebSearch((s) => !s)}
              aria-pressed={webSearch}
              aria-label="Live source lookup"
              title={
                webSearch
                  ? "Source lookup on — cards link a live Wikipedia page"
                  : "Source lookup off — cards cite the AI's own source"
              }
            >
              <SearchIcon off={!webSearch} />
            </button>
          </div>
          <button
            className={`mic-btn ${sessionActive ? "listening" : ""}`}
            onClick={sessionActive ? handleStop : handleStart}
            disabled={!supported}
            aria-label={sessionActive ? "Stop listening" : "Start listening"}
          >
            {sessionActive ? <StopIcon size={24} /> : <MicIcon size={26} />}
          </button>
          <div className="controls-side right">
            <button
              className="side-btn"
              onClick={handleReset}
              disabled={!transcript && !interim && findings.length === 0}
              title="Clear transcript"
              aria-label="Clear transcript"
            >
              <ClearIcon />
            </button>
          </div>
        </div>
        <div className={`status tone-${status.tone}`} aria-live="polite">
          <span className="dot" />
          {status.text}
        </div>
      </div>

      {pickerOpen && (
        <div className="picker-overlay" onClick={() => setPickerOpen(false)}>
          <div
            className="picker-card"
            role="dialog"
            aria-label="Referee voice"
            onClick={(e) => e.stopPropagation()}
          >
            <h2>Referee voice</h2>

            <label className={`picker-row ${voiceMode === "browser" ? "selected" : ""}`}>
              <input
                type="radio"
                name="voice-mode"
                checked={voiceMode === "browser"}
                onChange={() => setVoiceMode("browser")}
              />
              <span className="row-main">
                <span className="row-title">Speak callouts</span>
                <span className="row-sub">Built-in browser voice — free and on-device</span>
              </span>
            </label>
            {voiceMode === "browser" && browserVoices.length > 0 && (
              <select
                className="picker-select"
                value={voiceName}
                onChange={(e) => setVoiceName(e.target.value)}
                aria-label="Voice"
              >
                <option value="">Auto (recommended)</option>
                {browserVoices.map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </select>
            )}

            <label className={`picker-row ${voiceMode === "off" ? "selected" : ""}`}>
              <input
                type="radio"
                name="voice-mode"
                checked={voiceMode === "off"}
                onChange={() => setVoiceMode("off")}
              />
              <span className="row-main">
                <span className="row-title">Silent</span>
                <span className="row-sub">Chime + vibration only</span>
              </span>
            </label>

            <div className="picker-actions">
              <button
                className="side-btn"
                disabled={voiceMode === "off" || !!speakingFinding}
                onClick={() => {
                  getAudioCtx();
                  void speakWithBrowserTts(
                    "Fact check. This is your debate referee speaking."
                  );
                }}
              >
                Test voice
              </button>
              <button className="side-btn primary" onClick={() => setPickerOpen(false)}>
                Done
              </button>
            </div>
          </div>
        </div>
      )}

      {overlayFinding && (
        <div
          className="interrupt-overlay"
          onClick={speakingFinding ? skipSpeaking : () => setViewedId(null)}
        >
          <div
            className={`interrupt-card ${verdictClass(overlayFinding)}`}
            role="dialog"
            aria-live="assertive"
            onClick={speakingFinding ? undefined : (e) => e.stopPropagation()}
          >
            <span className="tag">{tagLabel(overlayFinding)}</span>
            <blockquote>&ldquo;{overlayFinding.quote}&rdquo;</blockquote>
            <div className="body">
              {overlayFinding.type === "fallacy"
                ? overlayFinding.explanation
                : overlayFinding.correction}
            </div>
            {overlayFinding.type === "fact_check" && overlayFinding.source_name && (
              <div className="source">
                Source:{" "}
                {overlayFinding.source_url && !speakingFinding ? (
                  <a href={overlayFinding.source_url} target="_blank" rel="noreferrer">
                    {overlayFinding.source_name}
                  </a>
                ) : (
                  overlayFinding.source_name
                )}
              </div>
            )}
            {speakingFinding ? (
              <div className="skip">Tap anywhere to skip</div>
            ) : (
              <div className="picker-actions">
                <button
                  className="side-btn"
                  disabled={voiceMode === "off"}
                  onClick={() => {
                    const f = overlayFinding;
                    setViewedId(null);
                    getAudioCtx();
                    speakQueueRef.current.push(f);
                    drainSpeakQueue();
                  }}
                >
                  Replay
                </button>
                <button className="side-btn primary" onClick={() => setViewedId(null)}>
                  Close
                </button>
              </div>
            )}
          </div>
        </div>
      )}
    </main>
  );
}
