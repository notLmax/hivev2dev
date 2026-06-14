/**
 * relay-guards.ts
 *
 * Hivemind loop-prevention guards. Two layers:
 *
 *   1. `[NO_REPLY]` marker — agents emit this as the entire response (or
 *      as a leading marker with optional commentary) to gracefully end a
 *      hivemind exchange without spinning a new auto-reply on the other
 *      side. The bot recognises the marker and skips relay.
 *
 *   2. Per-direction circuit breaker — counts isRequest relays in a
 *      sliding 60-second window keyed by (sender → receiver). If more
 *      than 5 fire in that window, further relays are suppressed and a
 *      warning is logged. Returns to normal automatically once traffic
 *      dies down. This catches future loop bugs even if the marker
 *      contract is missed.
 *
 * Both guards apply only to the isRequest auto-reply path in bot.ts.
 * isResponse and isEscalation are absorb-only and never relay, so loops
 * can't form there.
 *
 * Ported from neato-hive 2026-05-02 (their v1.3.8). Same fix; same
 * implementation — applies to any hive equally well.
 */

export const NO_REPLY_MARKER = "[NO_REPLY]";

/** True iff `text` opts out of relay via the NO_REPLY marker. */
export function isNoReply(text: string): boolean {
  const t = text.trim();
  if (t === NO_REPLY_MARKER) return true;
  // Allow leading marker + optional commentary, e.g.
  // "[NO_REPLY] acknowledged, moving on."
  return (
    t.startsWith(NO_REPLY_MARKER + " ") ||
    t.startsWith(NO_REPLY_MARKER + "\n")
  );
}

export const RELAY_LOOP_WINDOW_MS = 60_000;
export const RELAY_LOOP_THRESHOLD = 5;

const recentRelays = new Map<string, number[]>();

/**
 * Record this relay attempt and report whether the directional rate has
 * exceeded the loop threshold. Counter naturally decays: entries older
 * than the window are pruned on each call.
 *
 * `nowMs` is injectable for deterministic tests; defaults to Date.now().
 */
export function relayLoopGuardTripped(
  from: string,
  to: string,
  nowMs: number = Date.now(),
): boolean {
  const key = `${from}->${to}`;
  const arr = (recentRelays.get(key) ?? []).filter(
    (t) => nowMs - t < RELAY_LOOP_WINDOW_MS,
  );
  arr.push(nowMs);
  recentRelays.set(key, arr);
  return arr.length > RELAY_LOOP_THRESHOLD;
}

/** Test helper — clears all per-pair counters. */
export function _resetRelayLoopGuardForTesting(): void {
  recentRelays.clear();
}
