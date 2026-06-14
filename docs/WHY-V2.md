# Hive v1 → v2: What Changed and Why It's Cheaper

A plain-language summary for leadership. Bottom line up front:

> **Same agents, same personalities, same Discord experience — but each agent
> costs roughly 6× less to run on the same model (measured), and up to ~50×
> less once moved to cheaper models. The savings come from fixing how we feed
> the AI its context, and from no longer paying for our most expensive model
> on every task.**

---

## Why we had to change anything

As of **June 15, 2026**, Anthropic bills our AI agents against a fixed
**monthly credit per subscription** (Pro $20 / Max $100–$200), and anything
beyond that credit bills at full pay-as-you-go API rates. Under v1, every
agent ran on **Opus** (the most expensive model) and re-paid for its entire
memory on almost every message. That combination blows through the monthly
credit fast and spills into expensive overage. v2 fixes both.

---

## Lever 1: Prompt caching — stop re-buying the same context

**How AI billing works (the one thing to understand):** every time an agent
takes a turn, it re-sends everything it "knows" — its instructions, its
personality, its memory. The AI provider charges for those tokens three ways:

| What | Relative price |
|---|---|
| Brand-new text the model hasn't seen | **1× (full price)** |
| Writing something into the cache | 1.25× (one-time) |
| **Reading from cache** (unchanged from last time) | **0.1× (a 90% discount)** |

The catch: caching only works if the beginning of the message is **byte-for-byte
identical** to last time. Change one character early on, and the discount is
lost for everything after it.

**What v1 did wrong:** it put the agent's *live memory* (which the agent edits
constantly) at the **top** of every message. So every time an agent learned
something and wrote it down, it changed the top of the prompt and **threw away
the cache discount on its entire context.** Measured cache hit rate: **5–20%.**
In plain terms, agents were re-buying their whole brain at full price every few
messages.

**What v2 does:** the unchanging parts (identity, rules, instructions) are
**frozen** at the top so they cache perfectly. The constantly-changing parts
(memory, tasks) were **moved to the bottom**, where editing them no longer
disturbs the cached part. The agent sees exactly the same information — it's
just arranged so the discount survives.

**Measured result: 91.9% cache hit rate** (up from 5–20%), and **99% on the
exact turns where an agent writes to memory** — the case v1 was worst at.

**What that's worth:** on the same model, the effective price of input drops
from roughly **1.1× to 0.2×** of base — about **6× cheaper**, measured, with no
change to what the agents can do.

---

## Lever 2: Context editing & tracking — stop hoarding junk in memory
*(the area flagged as the priority)*

**The problem:** everything an agent pulls into a conversation — a giant
command output, a huge file, a long back-and-forth — stays in its working
context and gets **re-billed on every later turn**, forever. Left unmanaged, a
long session quietly gets more expensive every message. In v1 this was
invisible: there was no cap on what entered the context and no way to see it
happening.

**What v2 does — three parts:**

1. **Caps at the door.** Oversized tool results are trimmed *before* they enter
   the context (command output capped at 16 KB, tool results at ~10k tokens).
   Junk doesn't get a chance to become recurring rent.
2. **Automatic cleanup of long sessions.** When a conversation grows too large,
   the system compacts it (Claude lane) or trims the oldest material (cheaper
   model lane) — keeping the recent, relevant context and dropping stale bulk.
3. **Full tracking — this is new.** v2 now **records every context-editing
   event**: how many times a session was compacted, how big it was when that
   happened, how many tool results were trimmed, and how many old messages were
   dropped. Before, this was thrown away (console-only, lost on restart). Now
   it's persisted and shows up in two places leadership can look at:
   - `/status` in Discord — a live "Context edits" line per agent.
   - `npm run cache-report` — a per-agent breakdown, with a note that a
     temporary dip in the cache rate right after a compaction is *expected*
     (so it's never mistaken for a regression).

**Why it matters:** you can now *see* and *prove* that context stays lean and
the cache stays healthy — it's measured, per agent, over time, instead of being
a black box. That's the difference between "we think it's efficient" and "here's
the number."

---

## Lever 3: Right-sized models (the multiplier)

v1 ran **every** agent on Opus. v2 routes each agent to the cheapest model that
does its job, and keeps Opus for the one agent that maintains the system
(House MD). Indicative per-token pricing:

| Model | Input | Output | Use |
|---|---|---|---|
| Opus (v1 default) | $5.00 | $25.00 | engineering / maintenance only |
| Sonnet | $3.00 | $15.00 | general agents (stays on the Claude plan) |
| DeepSeek v4 Pro | $0.435 | $0.87 | most role agents (~10–30× cheaper) |

Moving the fleet off Opus stretches the monthly credit dramatically before any
overage. Switching models is one command per agent and is **reversible** — and
critically, **nothing is lost**: the agent keeps its personality, memory, and
tasks because those live in files, not in the model.

---

## The combined picture

| | v1 | v2 |
|---|---|---|
| Cache hit rate | 5–20% | **91.9% (measured)** |
| Effective input cost, same model | ~1.1× base | **~0.2× base (~6× cheaper)** |
| Default model | Opus (most expensive) | cheapest-viable, Opus eng-only |
| Context bloat | uncapped, invisible | capped + auto-cleaned + **tracked** |
| Cost visibility | none | per-agent spend caps + cache & context reports |
| Agent capability | — | **unchanged** (same files, same behavior) |

- **Caching alone: ~6× cheaper per agent, measured, same model.**
- **Caching + moving off Opus: a typical agent lands roughly 50× cheaper** than
  v1's Opus-everything baseline. *(The 6× is measured; the ~50× combined figure
  is an estimate we'll confirm with the first weeks of real usage data — which
  v2's new tracking is built to provide.)*

---

## What we did NOT trade away

- Every agent keeps its personality, memory, rules, and Discord channel.
- Migrating an existing user preserves all of their state (verified
  byte-for-byte) and is reversible.
- Spending is now **capped and visible** per agent — a control v1 didn't have.

## Status

The cost architecture is built, validated in automated tests, and the savings
above are either measured or clearly labeled as estimates. Remaining before
fleet-wide rollout is live validation (a real end-to-end run and a piloted
migration) — not further redesign.
