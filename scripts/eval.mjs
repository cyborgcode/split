#!/usr/bin/env node
/**
 * Myth-recall eval for the /api/analyze endpoint.
 *
 *   node scripts/eval.mjs                       # against http://localhost:3000
 *   node scripts/eval.mjs https://your-app.vercel.app
 *
 * Sends 10 well-known false claims (plus 2 accurate/opinion controls that
 * must NOT be flagged) and reports what came back. Uses ~12 requests of the
 * Gemini free-tier quota, paced to stay under the rate limit.
 */

const base = (process.argv[2] || "http://localhost:3000").replace(/\/$/, "");

const MYTHS = [
  "The Great Wall of China is visible from the Moon with the naked eye.",
  "Humans only use 10 percent of their brains.",
  "Water always boils at exactly 100 degrees Celsius regardless of altitude.",
  "Einstein failed math as a student, you know.",
  "Goldfish have a 3 second memory, everyone knows that.",
  "Lightning never strikes the same place twice.",
  "You lose most of your body heat through your head.",
  "Bulls are enraged by the color red, that's why matadors use red capes.",
  "Napoleon Bonaparte was unusually short for his time.",
  "Sugar makes children hyperactive, every parent has seen it.",
];

const CONTROLS = [
  "Water boils at 100 degrees Celsius at sea level.", // true — must not flag
  "I just think people were happier before social media.", // opinion — must not flag
];

let caught = 0;
let falseAlarms = 0;

async function check(chunk, expectFlag) {
  const res = await fetch(`${base}/api/analyze`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chunk }),
  });
  if (!res.ok) {
    const body = await res.text();
    console.log(`  HTTP ${res.status} — ${body.slice(0, 140)}`);
    return;
  }
  const data = await res.json();
  const flagged = data.findings.length > 0;
  const ok = flagged === expectFlag;
  if (expectFlag && flagged) caught++;
  if (!expectFlag && flagged) falseAlarms++;
  const mark = ok ? "✅" : "❌";
  const detail = flagged
    ? data.findings
        .map((f) =>
          f.type === "fact_check"
            ? `[${f.verdict}] ${f.correction.slice(0, 90)}`
            : `[fallacy: ${f.fallacy_name}]`
        )
        .join(" | ")
    : `not flagged (claims_checked=${data.claims_checked ?? "?"})`;
  console.log(`  ${mark} ${detail}`);
}

console.log(`Evaluating ${base}/api/analyze\n`);
console.log("── Myths (all 10 should be flagged) ──");
for (const [i, myth] of MYTHS.entries()) {
  console.log(`${i + 1}. ${myth}`);
  await check(myth, true);
  await new Promise((r) => setTimeout(r, 4500)); // stay under 15 RPM
}
console.log("\n── Controls (must NOT be flagged) ──");
for (const control of CONTROLS) {
  console.log(`• ${control}`);
  await check(control, false);
  await new Promise((r) => setTimeout(r, 4500));
}

console.log(`\nScore: ${caught}/${MYTHS.length} myths caught, ${falseAlarms} false alarms.`);
if (caught < 8) {
  console.log(
    "Low recall → try a stronger model: set GEMINI_MODEL=gemini-3.8-flash (note: ~20 req/day free)."
  );
}
