/**
 * normalizer.ts — per-provider message-shape normalization (04 §3).
 *
 * "Where the bodies are buried" (house-md, live experience): providers that
 * speak the Anthropic Messages format still 400 on shapes Anthropic accepts —
 * historically compact-JSON tool inputs and empty-content assistant turns on
 * deepseek/kimi via ollama. Every request body passes through here first.
 *
 * Profiles are named in the model catalog (`quirks:` key).
 */

export interface MsgBlock {
  type: string;
  [k: string]: any;
}

export interface Msg {
  role: "user" | "assistant";
  content: string | MsgBlock[];
}

export interface ProviderQuirks {
  name: string;
  /** Place explicit cache_control breakpoints (Anthropic direct only). */
  supportsCacheControl: boolean;
  /** Pass image blocks through; false = replace with a text placeholder. */
  supportsImages: boolean;
  /** Drop thinking blocks from assistant turns before sending/persisting. */
  stripThinking: boolean;
  /** Guarantee assistant content arrays are never empty. */
  requireNonEmptyContent: boolean;
}

const PROFILES: Record<string, ProviderQuirks> = {
  anthropic: {
    name: "anthropic",
    supportsCacheControl: true,
    supportsImages: true,
    stripThinking: false,
    requireNonEmptyContent: false,
  },
  deepseek: {
    name: "deepseek",
    supportsCacheControl: false, // implicit caching; unknown fields risk 400s
    supportsImages: false,       // vision unverified on this lane
    stripThinking: true,         // models emit thinking blocks; replaying them wastes tokens
    requireNonEmptyContent: true,
  },
  kimi: {
    name: "kimi",
    supportsCacheControl: false,
    supportsImages: false,
    stripThinking: true,
    requireNonEmptyContent: true,
  },
};

export function getQuirks(profile?: string): ProviderQuirks {
  return PROFILES[profile ?? "anthropic"] ?? PROFILES.anthropic;
}

/**
 * Normalizes a transcript for a provider. Pure — returns new arrays, never
 * mutates input (the persisted transcript keeps its original shape).
 */
export function normalizeMessages(messages: Msg[], quirks: ProviderQuirks): Msg[] {
  const out: Msg[] = [];
  for (const msg of messages) {
    if (typeof msg.content === "string") {
      // Empty string content 400s on some providers — make it a space.
      out.push({ role: msg.role, content: msg.content.length > 0 ? msg.content : " " });
      continue;
    }

    let blocks = msg.content
      .filter((b) => !(quirks.stripThinking && (b.type === "thinking" || b.type === "redacted_thinking")))
      .filter((b) => !(b.type === "text" && (!b.text || String(b.text).trim() === "")))
      .map((b) => {
        if (b.type === "tool_use") {
          // Coerce input to a plain object — string-encoded JSON has 400'd live.
          let input = b.input;
          if (typeof input === "string") {
            try {
              input = JSON.parse(input);
            } catch {
              input = {};
            }
          }
          if (input === null || typeof input !== "object") input = {};
          return { ...b, input };
        }
        if (b.type === "tool_result") {
          // Guarantee content exists; coerce non-string/non-array to string.
          let content = b.content;
          if (content === undefined || content === null) content = "";
          if (typeof content !== "string" && !Array.isArray(content)) content = String(content);
          return { ...b, content };
        }
        return { ...b };
      });

    if (blocks.length === 0) {
      if (msg.role === "assistant" && quirks.requireNonEmptyContent) {
        blocks = [{ type: "text", text: "(continuing)" }];
      } else if (msg.role === "user") {
        blocks = [{ type: "text", text: " " }];
      } else {
        // assistant, provider tolerant of empties — drop the message entirely
        continue;
      }
    }
    out.push({ role: msg.role, content: blocks });
  }
  return out;
}

/** Replaces image blocks per quirks (placeholder text for non-vision lanes). */
export function normalizeImages(blocks: MsgBlock[], quirks: ProviderQuirks): MsgBlock[] {
  if (quirks.supportsImages) return blocks;
  return blocks.map((b) =>
    b.type === "image"
      ? { type: "text", text: `[image attached: ${b.source?.url ?? "(inline)"} — this model cannot view images]` }
      : b
  );
}
