# Fairshare

**An AI reviewer for DAO contributor rewards. It reads each month's work claims against your written reward policy, decides what each one earns, and says which rule it used. A person signs off before anything is paid.**

Built on [SERV Reasoning](https://docs.openserv.ai/serv-reasoning/introduction) for the SERV Hackathon, Edition 02 (Open Track).

## The problem

I designed the contribution and reward structure for a DAO ambassador program that paid 100+ contributors. Every month went the same way. Dozens of claims came in: articles, bots, onboarding calls, graphics. Someone had to check each one against the policy: is there evidence, which tier is it, is it late, is it a duplicate, has this person hit the monthly cap, did a grant already pay for it?

That review is slow, people avoid it, and it is inconsistent. Contributors wait weeks to be paid and argue about decisions nobody can explain.

## What Fairshare does

```
claims.json + policy.md
        │
        ▼
 code computes the facts it can know exactly
 (days late, duplicate of an approved claim, points already awarded)
        │
        ▼
 SERV Reasoning judges each claim                 ← model: gpt-5.4-mini-serv-multipath
 · strict JSON schema: decision, category, tier,
   evidence strength, reasons, policy sections, missing info
 · Multipath: the policy's branching exceptions
   (late / duplicate / conflict of interest / paid elsewhere / unclear)
 · Shadow Agent: a second pass checks the decision
   follows the evidence and exception rules
        │
        ▼
 code applies the exact maths
 (tier points, −25% late penalty, 30-point monthly cap, budget pro-rata)
        │
        ▼
 out/report.html   one card per claim: decision, reasons, rules used, what code changed, trace id
 out/payout.csv    who gets paid what, for the treasurer
 out/audit.json    the full trail
```

The split follows SERV's own advice: the model makes the **judgment** (which category and tier, whether the evidence shows the work, which exception applies), and code does everything **exact** (dates, arithmetic, caps, budget). Every decision cites the policy sections it relied on, and anything the model can't decide is escalated to a person, not guessed.

## Run it

```bash
npm install
cp .env.example .env              # then put your key after SERV_API_KEY=
node fairshare.mjs claims.json    # or your own claims file
open out/report.html
```

To use your own program, edit `policy.md` (it is the system prompt, in plain English) and `claims.json`.

## The sample month

`claims.json` is a made-up October for an ambassador program. It includes the cases a real reviewer meets:

| Claim | What makes it tricky |
|---|---|
| c01 | Clean long-form article |
| c02 | Weekly onboarding calls with attendance in the recordings |
| c03 | The dev workgroup lead claiming dev work: a conflict of interest |
| c04 | The same article re-claimed as an X thread: a duplicate |
| c05 | Two days late: accepted with a penalty |
| c06 | AMA with no attendance number: scored down a tier |
| c07 | Video already paid by the marketing grant |
| c08 | "Helped out", with no link |
| c09–c10 | One contributor hitting the 30-point monthly cap |
| c11 | Five days late: rolls to next month |

## Why it can make money

Every DAO, grants program and ambassador program does this review monthly, by hand. Fairshare can be sold per review cycle (a flat fee per 100 claims) or as the review step inside payout tools. The audit trail is what treasurers and token-holders ask for when payouts are questioned.

## Built during the hackathon

Everything in this repo was written on 15 Nov 2026. The idea comes from an earlier project of mine, Payday Room (an agent that tallies contributor work in a chat). Fairshare is new: a policy-driven reviewer with schema-forced, auditable decisions on SERV Reasoning.

## Author

Kenichi (Olanrewaju Animashaun) · [0xkenichi.github.io](https://0xkenichi.github.io) · X [@0xKenichi](https://x.com/0xKenichi)
