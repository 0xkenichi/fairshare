// Fairshare: reviews contributor reward claims against a written policy with SERV Reasoning,
// then applies the exact maths (late penalties, monthly cap, budget) in code.
import OpenAI from "openai";
import fs from "node:fs";
import path from "node:path";

// --- config -----------------------------------------------------------------
const env = Object.fromEntries(
  (fs.existsSync(".env") ? fs.readFileSync(".env", "utf8") : "")
    .split("\n").filter((l) => l.includes("=")).map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()])
);
const KEY = process.env.SERV_API_KEY || env.SERV_API_KEY;
if (!KEY) { console.error("Put your key in .env as SERV_API_KEY=..."); process.exit(1); }

const MODEL = process.env.FAIRSHARE_MODEL || "gpt-5.4-mini-serv-multipath";
const client = new OpenAI({ baseURL: "https://inference-api.openserv.ai/v1", apiKey: KEY });

const policy = fs.readFileSync("policy.md", "utf8");
const batch = JSON.parse(fs.readFileSync(process.argv[2] || "claims.json", "utf8"));
const OUT = "out";
fs.mkdirSync(OUT, { recursive: true });

// --- deterministic rules (never asked of the model) ---------------------------
const POINTS = { writing: { A: 12, B: 6 }, dev: { A: 15, B: 7 }, community: { A: 10, B: 4 }, design: { A: 10, B: 4 } };
const CAP = 30;
const day = 86400000;
const daysLate = (submitted) => Math.max(0, Math.round((Date.parse(submitted) - Date.parse(batch.cutoff)) / day));

// --- the judgment the model makes, as a schema --------------------------------
const schema = {
  name: "claim_review",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["decision", "category", "tier", "evidence_supports", "reasons", "policy_rules", "missing_info"],
    properties: {
      decision: { type: "string", enum: ["approve", "partial", "reject", "escalate"] },
      category: { type: "string", enum: ["writing", "dev", "community", "design", "unclear"] },
      tier: { type: "string", enum: ["A", "B", "none"], description: "Tier the evidence supports; none if rejected or escalated" },
      evidence_supports: { type: "string", enum: ["full", "partial", "none"] },
      reasons: { type: "array", items: { type: "string" }, description: "Short, specific reasons a treasurer can check" },
      policy_rules: { type: "array", items: { type: "string" }, description: "Policy sections relied on, e.g. '2. Evidence rules'" },
      missing_info: { type: ["string", "null"], description: "What would let this claim be decided or upgraded; null if nothing" },
    },
  },
};

async function review(claim, facts) {
  const user = [
    `Program: ${batch.program} · Month: ${batch.month} · Cut-off: ${batch.cutoff}`,
    `Workgroup leads: ${JSON.stringify(batch.workgroup_leads)}`,
    "",
    "Facts computed by the system (trust these, do not recompute):",
    `- days late: ${facts.daysLate}`,
    `- duplicate of an approved claim this month: ${facts.duplicateOf || "no"}`,
    `- contributor's points already awarded this month: ${facts.pointsSoFar}`,
    "",
    "Claim:",
    JSON.stringify(claim, null, 2),
    "",
    "Decide this one claim under the policy. Score the tier from the evidence only. The system applies late penalties, the monthly cap and the budget after you.",
  ].join("\n");

  const base = {
    model: MODEL,
    messages: [{ role: "system", content: policy }, { role: "user", content: user }],
    response_format: { type: "json_schema", json_schema: schema },
  };
  const shadow = {
    tools: [{
      type: "function",
      function: {
        name: "serv_shadow_agent",
        parameters: {
          type: "object",
          properties: {
            hint: { type: "string", default: "The decision must follow the policy's evidence and exception rules, cite the sections used, and never reward work the evidence does not show." },
            max_iterations: { type: "integer", default: 2 },
          },
        },
      },
    }],
  };
  const t0 = Date.now();
  let res, usedShadow = true;
  try {
    res = await client.chat.completions.create({ ...base, ...shadow });
  } catch (e) {
    usedShadow = false; // fall back if this model/format combination refuses the shadow tool
    res = await client.chat.completions.create(base);
  }
  const msg = res.choices[0].message;
  let out;
  try { out = JSON.parse(msg.content); } catch { throw new Error(`Claim ${claim.id}: model did not return valid JSON`); }
  if (!schema.schema.required.every((k) => k in out)) throw new Error(`Claim ${claim.id}: missing fields`);
  return { review: out, meta: { id: res.id, model: res.model, ms: Date.now() - t0, usage: res.usage, shadow: usedShadow } };
}

// --- run ------------------------------------------------------------------------
const rows = [];
const awarded = {}; // contributor -> points
const approvedTitles = {}; // contributor|title -> claim id
for (const claim of batch.claims) {
  const keyT = `${claim.contributor}|${claim.title.toLowerCase().trim()}`;
  const facts = { daysLate: daysLate(claim.submitted), duplicateOf: approvedTitles[keyT] || null, pointsSoFar: awarded[claim.contributor] || 0 };
  process.stdout.write(`${claim.id} ${claim.contributor.padEnd(7)} ${claim.title.slice(0, 40).padEnd(40)} … `);
  const { review: r, meta } = await review(claim, facts);

  // exact maths in code
  const notes = [];
  let pts = 0, decision = r.decision;
  if ((decision === "approve" || decision === "partial") && POINTS[r.category]?.[r.tier]) {
    pts = POINTS[r.category][r.tier];
    if (facts.daysLate > 3) { pts = 0; decision = "reject"; notes.push(`system: ${facts.daysLate} days late, over the 3-day limit`); }
    else if (facts.daysLate > 0) { const before = pts; pts = Math.floor(pts * 0.75); notes.push(`system: ${facts.daysLate} day(s) late, −25% (${before} → ${pts})`); }
    const room = CAP - facts.pointsSoFar;
    if (pts > room) { notes.push(`system: monthly cap of ${CAP}, ${pts} → ${Math.max(0, room)}`); pts = Math.max(0, room); decision = pts > 0 ? "partial" : "reject"; }
  } else if (decision === "approve" || decision === "partial") {
    decision = "escalate"; notes.push("system: model approved without a valid category/tier, escalated");
  }
  if (pts > 0) { awarded[claim.contributor] = (awarded[claim.contributor] || 0) + pts; approvedTitles[keyT] ||= claim.id; }
  rows.push({ claim, facts, review: r, decision, points: pts, notes, meta });
  console.log(`${decision.toUpperCase().padEnd(8)} ${String(pts).padStart(2)} pts  (${meta.ms} ms${meta.shadow ? ", shadow-checked" : ""})`);
}

// budget: pro-rata if over
const totalPts = rows.reduce((a, r) => a + r.points, 0);
const fullUsd = totalPts * batch.point_value_usd;
const scale = fullUsd > batch.budget_usd ? batch.budget_usd / fullUsd : 1;
for (const r of rows) r.usd = Math.floor(r.points * batch.point_value_usd * scale * 100) / 100;

// --- outputs ----------------------------------------------------------------------
fs.writeFileSync(path.join(OUT, "audit.json"), JSON.stringify({ program: batch.program, month: batch.month, model: MODEL, generated: new Date().toISOString(), rows }, null, 2));
const perPerson = {};
for (const r of rows) if (r.usd > 0) perPerson[r.claim.contributor] = (perPerson[r.claim.contributor] || 0) + r.usd;
fs.writeFileSync(path.join(OUT, "payout.csv"), "contributor,usd\n" + Object.entries(perPerson).map(([c, u]) => `${c},${u.toFixed(2)}`).join("\n") + "\n");

const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const count = (d) => rows.filter((r) => r.decision === d).length;
const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Fairshare · ${esc(batch.program)} · ${esc(batch.month)}</title>
<style>
:root{--bg:#f6f6f3;--fg:#141414;--mute:#6b6b66;--line:#e2e2dc;--card:#fff;--ok:#0f8a5f;--okb:#e3f5ec;--part:#8a5a00;--partb:#fbf0d9;--rej:#a33a3a;--rejb:#f9e5e5;--esc:#4b3bc2;--escb:#ece8fb}
@media (prefers-color-scheme:dark){:root{--bg:#0d0e10;--fg:#ececea;--mute:#9a9a94;--line:#26292e;--card:#16181b;--okb:#12291f;--partb:#2c2312;--rejb:#331818;--escb:#221c3a;--ok:#4cd29a;--part:#e8b75a;--rej:#ff8c8c;--esc:#a995ff}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 Inter,system-ui,sans-serif}
.w{max-width:1040px;margin:0 auto;padding:32px 16px 64px}h1{font-size:28px;margin:0 0 4px;letter-spacing:-.02em}.sub{color:var(--mute)}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:10px;margin:22px 0}
.stat{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:12px 14px}.stat b{display:block;font:600 22px ui-monospace,Menlo,monospace}.stat span{color:var(--mute);font-size:12.5px}
.c{background:var(--card);border:1px solid var(--line);border-radius:12px;margin:10px 0;overflow:hidden}
.h{display:grid;grid-template-columns:90px 1fr auto auto;gap:12px;align-items:center;padding:12px 16px;border-bottom:1px solid var(--line)}
.id{font:12px ui-monospace,Menlo,monospace;color:var(--mute)}.pill{font-weight:600;font-size:12px;border-radius:6px;padding:2px 8px;text-transform:uppercase}
.approve{color:var(--ok);background:var(--okb)}.partial{color:var(--part);background:var(--partb)}.reject{color:var(--rej);background:var(--rejb)}.escalate{color:var(--esc);background:var(--escb)}
.pts{font:600 14px ui-monospace,Menlo,monospace;min-width:90px;text-align:right}.b{padding:10px 16px 14px;display:grid;grid-template-columns:150px 1fr;gap:6px 14px;font-size:14px}
.b dt{color:var(--mute)}.b dd{margin:0}ul{margin:0;padding-left:18px}.sys{color:var(--esc);font-family:ui-monospace,Menlo,monospace;font-size:12.5px}
.foot{color:var(--mute);font-size:12.5px;margin-top:24px}@media(max-width:640px){.h{grid-template-columns:1fr auto}.h .id{display:none}.b{grid-template-columns:1fr}}
</style></head><body><div class="w">
<h1>${esc(batch.program)}: ${esc(batch.month)} rewards</h1>
<div class="sub">Reviewed by Fairshare on SERV Reasoning (${esc(MODEL)}). Draft for the treasurer to sign off. Nothing is paid until a person approves it.</div>
<div class="stats">
<div class="stat"><b>${rows.length}</b><span>claims reviewed</span></div>
<div class="stat"><b>${count("approve")}</b><span>approved</span></div>
<div class="stat"><b>${count("partial")}</b><span>partial</span></div>
<div class="stat"><b>${count("reject")}</b><span>rejected</span></div>
<div class="stat"><b>${count("escalate")}</b><span>escalated to a person</span></div>
<div class="stat"><b>$${rows.reduce((a, r) => a + r.usd, 0).toFixed(2)}</b><span>to pay of $${batch.budget_usd} budget${scale < 1 ? " (pro-rata)" : ""}</span></div>
</div>
${rows.map((r) => `<div class="c"><div class="h"><span class="id">${esc(r.claim.id)} · ${esc(r.claim.contributor)}</span><span><b>${esc(r.claim.title)}</b></span><span class="pill ${r.decision}">${r.decision}</span><span class="pts">${r.points} pts · $${r.usd.toFixed(2)}</span></div>
<dl class="b"><dt>Category · tier</dt><dd>${esc(r.review.category)} · ${esc(r.review.tier)} (evidence: ${esc(r.review.evidence_supports)})</dd>
<dt>Why</dt><dd><ul>${r.review.reasons.map((x) => `<li>${esc(x)}</li>`).join("")}</ul></dd>
<dt>Policy used</dt><dd>${r.review.policy_rules.map(esc).join(" · ")}</dd>
${r.review.missing_info ? `<dt>Missing</dt><dd>${esc(r.review.missing_info)}</dd>` : ""}
${r.notes.length ? `<dt>Applied in code</dt><dd>${r.notes.map((n) => `<div class="sys">${esc(n)}</div>`).join("")}</dd>` : ""}
<dt>Trace</dt><dd class="sys">${esc(r.meta.id)} · ${r.meta.ms} ms · ${r.meta.usage?.total_tokens ?? "?"} tokens${r.meta.shadow ? " · shadow agent validated" : ""}</dd></dl></div>`).join("")}
<div class="foot">Judgment (category, tier, decision, reasons) comes from SERV Reasoning with a strict JSON schema, Multipath for the policy's branching rules and a Shadow Agent check. Late penalties, the ${CAP}-point cap and the budget are applied in code. Full trail: audit.json · payout sheet: payout.csv</div>
</div></body></html>`;
fs.writeFileSync(path.join(OUT, "report.html"), html);
console.log(`\nDone. ${totalPts} points → $${rows.reduce((a, r) => a + r.usd, 0).toFixed(2)}. Open out/report.html`);
