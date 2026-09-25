"use client";

import { useEffect, useRef } from "react";

const BAR_COUNT = 36;
const TALK_THRESHOLD = 0.045; // RMS level above which the bar "illuminates"

/**
 * Full-width audio wave that lights up while someone is talking.
 * Opens its own mic stream (independent of speech recognition) and renders
 * live frequency bars to a canvas.
 */
export default function WaveBar({ active }: { active: boolean }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx2d = canvas.getContext("2d");
    if (!ctx2d) return;

    let raf = 0;
    let stream: MediaStream | null = null;
    let audioCtx: AudioContext | null = null;
    let analyser: AnalyserNode | null = null;
    let cancelled = false;

    const draw = () => {
      const dpr = window.devicePixelRatio || 1;
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
        canvas.width = w * dpr;
        canvas.height = h * dpr;
      }
      ctx2d.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx2d.clearRect(0, 0, w, h);

      let bins: Uint8Array | null = null;
      let rms = 0;
      if (analyser) {
        const freq = new Uint8Array(analyser.frequencyBinCount);
        analyser.getByteFrequencyData(freq);
        bins = freq;
        const time = new Uint8Array(analyser.fftSize);
        analyser.getByteTimeDomainData(time);
        let sum = 0;
        for (let i = 0; i < time.length; i++) {
          const v = (time[i] - 128) / 128;
          sum += v * v;
        }
        rms = Math.sqrt(sum / time.length);
      }
      const talking = rms > TALK_THRESHOLD;

      const gap = 3;
      const barW = (w - gap * (BAR_COUNT - 1)) / BAR_COUNT;
      const mid = h / 2;
      for (let i = 0; i < BAR_COUNT; i++) {
        let level = 0;
        if (bins) {
          // sample the lower ~2/3 of the spectrum, where speech lives
          const idx = Math.floor((i / BAR_COUNT) * bins.length * 0.66);
          level = bins[idx] / 255;
        }
        const barH = Math.max(3, level * (h - 6));
        ctx2d.fillStyle = talking
          ? `rgba(124, 156, 255, ${0.45 + level * 0.55})`
          : "rgba(120, 132, 160, 0.3)";
        const x = i * (barW + gap);
        const r = Math.min(barW / 2, 3);
        ctx2d.beginPath();
        ctx2d.roundRect(x, mid - barH / 2, barW, barH, r);
        ctx2d.fill();
      }
      raf = requestAnimationFrame(draw);
    };

    if (active) {
      navigator.mediaDevices
        .getUserMedia({ audio: true })
        .then((s) => {
          if (cancelled) {
            s.getTracks().forEach((t) => t.stop());
            return;
          }
          stream = s;
          audioCtx = new AudioContext();
          // iOS starts contexts created outside a tap suspended — bars would
          // never move. The mic tap that got us here allows resuming.
          void audioCtx.resume().catch(() => {});
          analyser = audioCtx.createAnalyser();
          analyser.fftSize = 512;
          analyser.smoothingTimeConstant = 0.75;
          audioCtx.createMediaStreamSource(s).connect(analyser);
        })
        .catch(() => {
          /* mic denied — the speech hook surfaces the error */
        });
      raf = requestAnimationFrame(draw);
    } else {
      // one static frame of dim idle bars
      raf = requestAnimationFrame(draw);
      setTimeout(() => cancelAnimationFrame(raf), 50);
    }

    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
      stream?.getTracks().forEach((t) => t.stop());
      void audioCtx?.close().catch(() => {});
    };
  }, [active]);

  return <canvas className="wavebar" ref={canvasRef} aria-hidden />;
}
