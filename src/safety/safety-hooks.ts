/**
 * safety-hooks.ts
 * SDK hook integration for the safety layer.
 * Registers PreToolUse hooks that block dangerous commands and enforce path restrictions.
 */

import os from "node:os";
import path from "node:path";
import type {
  HookCallbackMatcher,
  HookInput,
  HookJSONOutput,
  PreToolUseHookInput,
} from "@anthropic-ai/claude-agent-sdk";
import { checkDestructivePattern, extractPaths } from "./command-filter.js";
import { checkForInjection } from "./injection-guard.js";

interface SafetyConfig {
  blocked_commands: string[];
  allowed_paths: string[];
  protected_paths: string[];
}

/**
 * Expand a leading "~" or "~/" in a path to the user's home directory.
 * Leaves non-tilde paths unchanged. Uses os.homedir() so behaviour is robust
 * in contexts where process.env.HOME is unset (launchd, some CI, sudo -E).
 * Exported for testing.
 */
export function expandPath(p: string): string {
  if (!p) return p;
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return os.homedir() + p.slice(1);
  return p;
}

/**
 * Replaces the contents of single- and double-quoted strings in a shell
 * command with empty strings, so destructive-pattern regexes don't match on
 * literal string content passed to grep/sed/awk/etc.
 *
 * Conservative: single-quoted bash strings are literal (no escapes), so we
 * treat `'...'` as span-to-next-`'`. Double-quoted strings honour backslash
 * escapes, handled with a non-greedy match that respects `\\.`.
 *
 * Exported for testing.
 */
export function stripQuotedStrings(cmd: string): string {
  return cmd
    .replace(/'[^']*'/g, "''")                    // single quotes: no escaping
    .replace(/"([^"\\]|\\.)*"/g, '""');           // double quotes: honour \.
}

/**
 * Case-folds a path on case-insensitive filesystems (darwin default APFS).
 * Returns the path unchanged elsewhere.
 * Exported for testing.
 */
export function casefoldForPlatform(p: string): string {
  return process.platform === "darwin" ? p.toLowerCase() : p;
}

/**
 * Resolves `..` and `.` segments, then returns an absolute path. Leaves
 * paths starting with `/` resolved from `/`; non-absolute inputs are
 * resolved relative to the current working directory (matching Node's
 * default `path.resolve`).
 *
 * Safety-critical: this is what closes the `/allowed/../../etc/passwd`
 * traversal hole. Any `pathIsUnder` comparison should operate on resolved
 * paths on both sides.
 *
 * Exported for testing.
 */
export function resolveForCompare(p: string): string {
  if (!p) return p;
  return path.resolve(p);
}

/**
 * Returns true iff `candidate` is exactly `base` or is a proper descendant
 * of `base`. Uses a trailing-slash guard so `/x/hive-archive` does not
 * match `/x/hive`. Case-folds on darwin.
 *
 * Callers are expected to pass resolved (absolute, `..`-free) paths.
 * Exported for testing.
 */
export function pathIsUnder(candidate: string, base: string): boolean {
  if (!candidate || !base) return false;
  // Normalise separators so a path.resolve()'d Windows path (backslashes,
  // dev box) compares cleanly against a forward-slash boundary. No-op on
  // Unix (production), where resolved paths already use forward slashes.
  const toFwd = (s: string) => s.replace(/\\/g, "/");
  const c = casefoldForPlatform(toFwd(candidate));
  const b = casefoldForPlatform(toFwd(base));
  if (c === b) return true;
  return c.startsWith(b.endsWith("/") ? b : b + "/");
}

/**
 * Normalises a list of paths from config. Expands tildes, strips trailing
 * slash, and resolves `..` segments so comparisons are consistent.
 */
function normalisePaths(paths: string[]): string[] {
  return paths.map((p) => {
    const expanded = expandPath(p);
    const resolved = path.isAbsolute(expanded) ? path.resolve(expanded) : expanded;
    return resolved.length > 1 && resolved.endsWith("/")
      ? resolved.slice(0, -1)
      : resolved;
  });
}

/**
 * Creates the PreToolUse hook matchers for the safety layer.
 * Returns a record to merge into the SDK's hooks option.
 */
export function createSafetyHooks(rawConfig: SafetyConfig): {
  PreToolUse: HookCallbackMatcher[];
  PostToolUse: HookCallbackMatcher[];
} {
  // Expand ~ in allowed/protected paths ONCE so the per-call hot path is
  // cheap and — more importantly — actually matches the absolute paths
  // tools pass in.
  const config: SafetyConfig = {
    blocked_commands: rawConfig.blocked_commands,
    allowed_paths: normalisePaths(rawConfig.allowed_paths),
    protected_paths: normalisePaths(rawConfig.protected_paths),
  };

  // Keep the original (tilde-form) values for user-facing error messages so
  // agents see paths in the same form they appear in config.yaml.
  const displayAllowed = rawConfig.allowed_paths;
  const displayProtected = rawConfig.protected_paths;

  return {
    PreToolUse: [
      {
        matcher: "Bash",
        hooks: [createBashSafetyHook(config, displayAllowed, displayProtected)],
        timeout: 5,
      },
      {
        matcher: "Write",
        hooks: [createWriteSafetyHook(config, displayAllowed, displayProtected)],
        timeout: 5,
      },
      {
        matcher: "Edit",
        hooks: [createWriteSafetyHook(config, displayAllowed, displayProtected)],
        timeout: 5,
      },
    ],
    PostToolUse: [
      {
        matcher: "WebFetch",
        hooks: [createInjectionScanHook()],
        timeout: 5,
      },
      {
        matcher: "WebSearch",
        hooks: [createInjectionScanHook()],
        timeout: 5,
      },
    ],
  };
}

/**
 * PreToolUse hook for Bash commands.
 *
 * Order of checks (matters — see review thread):
 *   1. Blocklist (always-deny substrings).
 *   2. Protected paths — BEFORE destructive patterns, so a Bash command that
 *      touches a protected path reports "protected path" rather than a
 *      misleading "destructive pattern" like `2>/dev/null` on `~/.codex`.
 *   3. Destructive patterns (with allowlist escape for fully-in-allowed paths).
 *   4. Sudo guard.
 *
 * `config` has been normalised: allowed_paths and protected_paths are
 * absolute and `..`-free. Display arrays carry the tilde-form originals.
 */
function createBashSafetyHook(
  config: SafetyConfig,
  displayAllowed: string[],
  displayProtected: string[],
) {
  return async (input: HookInput, _toolUseID: string | undefined): Promise<HookJSONOutput> => {
    const hookInput = input as PreToolUseHookInput;
    const toolInput = hookInput.tool_input as { command?: string } | undefined;
    const command = toolInput?.command || "";

    if (!command) return allow();

    // 1. Blocklist (hard block).
    const normalizedCmd = command.trim().toLowerCase();
    for (const blocked of config.blocked_commands) {
      const blockedLower = blocked.toLowerCase();
      const idx = normalizedCmd.indexOf(blockedLower);
      if (idx === -1) continue;

      if (blockedLower.endsWith("/")) {
        const afterIdx = idx + blockedLower.length;
        const charAfter = normalizedCmd[afterIdx];
        if (charAfter && !/[\s;|&]/.test(charAfter)) {
          continue;
        }
      }

      return block(
        `Blocked: command matches safety rule "${blocked}"`,
        `This command was blocked by Hive safety policy. The pattern "${blocked}" is never allowed.`,
      );
    }

    // Extract + resolve once for both protected and allowlist comparisons.
    // extractPaths already expands `~` and `$HOME`; path.resolve closes the
    // `..` traversal hole.
    const rawPaths = extractPaths(command);
    const resolvedPaths = rawPaths.map(resolveForCompare);

    // 2. Protected-path check — BEFORE destructive-pattern check.
    for (let i = 0; i < config.protected_paths.length; i++) {
      const protPath = config.protected_paths[i];
      const display = displayProtected[i] ?? protPath;

      // Fast path: extracted-path comparison catches both tilde and absolute
      // forms via extractPaths' normalisation.
      const hitByPath = resolvedPaths.some((p) => pathIsUnder(p, protPath));
      // Slower fallback: substring check in both tilde and absolute form.
      // Catches unusual quoting/concatenation shapes extractPaths may miss.
      const hitByString =
        command.includes(display) || command.includes(protPath);

      if (hitByPath || hitByString) {
        return block(
          `Blocked: command references protected path ${display}`,
          `This command touches a protected path (${display}). ` +
            `Protected paths cannot be accessed by agents. Ask the owner directly if this is needed.`,
        );
      }
    }

    // 3. Destructive-pattern check (with allowlist escape).
    // Strip quoted content first so destructive patterns don't match inside
    // literal grep/sed/awk arguments.
    const destructive = checkDestructivePattern(stripQuotedStrings(command));
    if (destructive) {
      const allAllowed =
        resolvedPaths.length > 0 &&
        resolvedPaths.every((p) =>
          config.allowed_paths.some((ap) => pathIsUnder(p, ap)),
        );

      if (!allAllowed) {
        return block(
          `Blocked: destructive pattern detected (${destructive})`,
          `This command matches a destructive pattern and targets paths outside allowed directories. ` +
            `Allowed paths: ${displayAllowed.join(", ")}`,
        );
      }
    }

    // 4. Sudo.
    if (normalizedCmd.startsWith("sudo ") || normalizedCmd.includes(" sudo ")) {
      return block(
        "Blocked: sudo commands are not allowed",
        "Agents cannot run sudo commands. If elevated permissions are needed, ask the owner.",
      );
    }

    return allow();
  };
}

/**
 * PreToolUse hook for Write/Edit operations.
 *
 * Expands tilde on the incoming `file_path` (tools may pass either form),
 * resolves `..` segments, then runs protected/allowed checks with
 * boundary-safe prefix compare.
 */
function createWriteSafetyHook(
  config: SafetyConfig,
  displayAllowed: string[],
  displayProtected: string[],
) {
  return async (input: HookInput, _toolUseID: string | undefined): Promise<HookJSONOutput> => {
    const hookInput = input as PreToolUseHookInput;
    const toolInput = hookInput.tool_input as { file_path?: string; path?: string } | undefined;
    const raw = toolInput?.file_path || toolInput?.path || "";

    if (!raw) return allow();

    // Expand tilde, then resolve to absolute-and-canonical so `..` cannot
    // escape an allowed_paths prefix.
    const filepath = resolveForCompare(expandPath(raw));

    // Protected paths first.
    for (let i = 0; i < config.protected_paths.length; i++) {
      const protPath = config.protected_paths[i];
      const display = displayProtected[i] ?? protPath;
      if (pathIsUnder(filepath, protPath)) {
        return block(
          `Blocked: cannot write to protected path ${display}`,
          `Writing to ${filepath} is blocked. This is a protected system path (${display}).`,
        );
      }
    }

    // Allowed paths.
    const isAllowed = config.allowed_paths.some((ap) => pathIsUnder(filepath, ap));
    if (!isAllowed) {
      return block(
        `Blocked: write outside allowed directories`,
        `Cannot write to ${filepath}. Allowed directories: ${displayAllowed.join(", ")}`,
      );
    }

    return allow();
  };
}

/**
 * PostToolUse hook that scans web content for prompt injection.
 * Doesn't block — adds a warning to the context so the agent knows the
 * content is suspect.
 */
function createInjectionScanHook() {
  return async (input: HookInput, _toolUseID: string | undefined): Promise<HookJSONOutput> => {
    const hookInput = input as Record<string, unknown>;
    const result = hookInput.tool_result as string | undefined;
    if (!result) return allow();

    const check = checkForInjection(result);
    if (check.suspicious) {
      return {
        hookSpecificOutput: {
          hookEventName: "PostToolUse" as any,
          additionalContext: check.recommendation,
        },
      };
    }

    return allow();
  };
}

// --- Helpers ---

function allow(): HookJSONOutput {
  return {};
}

function block(reason: string, contextForAgent: string): HookJSONOutput {
  console.log(`[safety] ${reason}`);
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: contextForAgent,
    },
  };
}
