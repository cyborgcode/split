# ⚖️ Split — the AI debate referee

Place your phone between you and your debate opponent. Split listens to the
conversation and, in real time:

- **Fact-checks false claims and statistics** — when someone states something
  incorrect, the referee **interrupts out loud**, speaking the correct
  claim/statistic and its source, while the correction card appears inline in
  the transcript.
- **Calls out logical fallacies** — ad hominem, straw man, false dilemma,
  whataboutism, slippery slope, and more, each with a one-line explanation of
  why it's a fallacy.

The UI is a single full-page live transcript with a wave bar at the bottom
that illuminates while the debaters talk.

No alerts means the debate is clean. Better debates for both sides.

## How it works

1. The browser's built-in **Web Speech API** transcribes the debate live on
   your phone — no audio ever leaves the device.
2. Every few seconds, the new slice of transcript is sent to a serverless API
   route (`/api/analyze`).
3. The route asks **Google Gemini** (free tier, `gemini-3.5-flash-lite`) to
   judge every factual claim and flag clear-cut fallacies, and returns
   structured JSON.
4. Each flagged claim is then looked up on the **keyless Wikipedia search
   API** so the card links a real page — not just the model's memory. The
   **search button** toggles this: off keeps the AI's own citation.
5. New findings interrupt the debate mid-conversation: a sharp buzzer cuts
   through the talking, then the referee **calls the lie out loud** —
   "Stop right there, that's a lie! Here's the truth: …" — followed by the
   correction and source, shown full-screen while it speaks. The voice is
   the browser's built-in speech synthesis — free, instant, on-device. The
   **🔊 button opens a picker** to choose any installed English voice (with
   a ▶ Test button) or switch to **Off** (chime + vibration only); the
   choice is remembered on the device. Listening continues through the
   callout, with the referee's own words scrubbed from the transcript, and
   the card stays woven into the transcript at the point where it happened.

## Setup

```bash
npm install
cp .env.example .env.local   # then add ONE of the keys below
npm run dev
```

Set your key in `.env.local`:

| Variable | Where to get it | Default model |
| --- | --- | --- |
| `GEMINI_API_KEY` | [aistudio.google.com/apikey](https://aistudio.google.com/apikey) (free) | `gemini-3.5-flash-lite` |

**Why Flash-Lite:** Google no longer publishes free-tier limits, but measured
on a fresh key (Sept 2026) the Flash-Lite models get **15 requests/min and
500/day** each, versus 5/min and 20/day for the Flash models — and the 2.x
models are shut down or closed to new keys. Quotas are counted per model, so
when `gemini-3.5-flash-lite` hits its limit the app falls through to
`gemini-3.1-flash-lite`, giving roughly **1,000 checks a day** (about an
hour of nonstop debate at one check every ~4.5s). Your live limits are
shown in AI Studio. Override with `GEMINI_MODEL` if you like.

Open `http://localhost:3000`, allow microphone access, press
**Start listening**, and start arguing.

> Live speech recognition requires Chrome, Edge, or Safari (desktop or
> mobile). Firefox doesn't ship the Web Speech API yet.

## Deploy to Vercel

1. Push this repo to GitHub.
2. [Import it into Vercel](https://vercel.com/new) — it's auto-detected as a
   Next.js app; no configuration needed.
3. In **Project → Settings → Environment Variables**, add `GEMINI_API_KEY`.
4. Deploy. The mic works on the deployed URL because Vercel serves over HTTPS
   (browsers only allow microphone access on secure origins).

## Nothing happening? Troubleshooting

- **No AI key configured** is the #1 cause — the app shows a yellow setup
  banner on load if so. Add `GEMINI_API_KEY` in Vercel → Settings →
  Environment Variables and **redeploy** (env changes don't apply to old
  deployments).
- Any Gemini error (bad key, model) appears as a red banner with the actual
  error message. Per-minute rate limits back off quietly ("Gemini busy —
  retrying"); if the **daily** quota is used up on every model, a banner says
  so and checking resumes by itself after midnight Pacific.
- Analysis runs as soon as ~40 characters of speech accumulate (at most one
  request every 4.5 seconds) — say a full sentence or two and give it a beat.
- The referee is deliberately conservative: opinions and vague claims are
  ignored. Test it with something concrete and clearly wrong, e.g. "the Great
  Wall of China is visible from the Moon" or "unemployment is 40 percent".
- **Measure it instead of guessing:** `node scripts/eval.mjs
  https://your-app.vercel.app` sends 10 famous myths plus 2 controls at the
  analyzer and prints which were caught (uses ~12 free-tier requests). If
  recall is low, set `GEMINI_MODEL=gemini-3.8-flash` — sharper, but its
  free tier is only ~20 requests/day and it queues slowly, so it suits a
  short demo, not daily use.
- Speech recognition needs Chrome, Edge, or Safari over HTTPS (or localhost),
  with mic permission granted.

## Notes & limits

- The AI is prompted to be **conservative**: opinions, predictions, and
  hyperbole are never flagged — only concrete, checkable claims and clear-cut
  fallacies.
- Sources come from a live web search (authoritative domains are preferred
  when picking the result to cite); still, treat them as a starting point and
  verify anything that matters.
- Speech recognition quality depends on the device mic, distance, and
  crosstalk — put the phone roughly equidistant between both speakers.
