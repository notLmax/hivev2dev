/**
 * command-filter.ts
 * Standalone command filtering utilities.
 * Used by the safety hooks for deeper bash command analysis.
 */

import os from "node:os";

/**
 * Patterns that indicate potentially destructive operations.
 * These trigger a confirmation prompt (not an outright block) — the safety
 * hook may allow them when all referenced paths are within allowed_paths.
 *
 * Narrowing notes:
 * - The redirect pattern requires a non-digit character immediately before
 *   the `>` operator (or start-of-string). This:
 *     (a) excludes file-descriptor redirects like `2>/dev/null` that the
 *         previous `/>\s*\//` form false-positived on, and
 *     (b) keeps catching no-space redirects such as `echo hi>/etc/passwd`
 *         that the earlier "`(?:\d*)`" fix regressed on (it required a
 *         whitespace/separator boundary *before* the optional digits and
 *         therefore no longer matched when the `>` was glued directly to a
 *         preceding non-space token).
 */
const DESTRUCTIVE_PATTERNS = [
  /rm\s+(-[a-z]*f|-[a-z]*r)/i,                  // rm with -f or -r flags
  /chmod\s+[0-7]{3,4}/,                          // chmod with numeric permissions
  /chown\s+/,                                     // changing file ownership
  /mv\s+.*\//,                                    // moving files
  /(?:^|[^\d])>{1,2}\s*\//,                      // redirect to a root path (non-digit lookbehind excludes fd redirects like 2>/dev/null)
  /pip\s+install/,                                // installing packages
  /npm\s+install\s+-g/,                          // global npm installs
  /brew\s+install/,                               // homebrew installs
  /curl\s+.*\|\s*(sh|bash)/,                     // pipe curl to shell
  /wget\s+.*\|\s*(sh|bash)/,                     // pipe wget to shell
];

/**
 * Checks if a command contains destructive patterns.
 * Returns the matched pattern description or null.
 */
export function checkDestructivePattern(command: string): string | null {
  for (const pattern of DESTRUCTIVE_PATTERNS) {
    if (pattern.test(command)) {
      return pattern.source;
    }
  }
  return null;
}

/**
 * Resolve $HOME in a path string. Covers `$HOME/...`, `${HOME}/...`, and
 * quoted forms after quote-stripping has already been applied upstream.
 * Kept module-local; callers should use `os.homedir()` directly when working
 * with parsed tilde paths.
 */
function resolveHomeVar(pathLike: string): string {
  const home = os.homedir();
  return pathLike
    .replace(/^\$HOME(?=\/|$)/, home)
    .replace(/^\$\{HOME\}(?=\/|$)/, home);
}

/**
 * Extracts file paths referenced in a command.
 * Used to check path restrictions.
 *
 * Recognises three forms:
 *  - absolute paths starting with `/`
 *  - home-relative paths starting with `~/` (expanded to `os.homedir()`)
 *  - environment-variable paths starting with `$HOME/` or `${HOME}/`
 *
 * Strips surrounding single/double quotes around token candidates so that
 * `cat "$HOME/.ssh/id_rsa"` and `cat '$HOME/.ssh/id_rsa'` are caught.
 */
export function extractPaths(command: string): string[] {
  const paths: string[] = [];
  const home = os.homedir();

  // Absolute paths. Stop at shell delimiters AND quote characters so a quoted
  // token like "$HOME/.ssh/id_rsa" doesn't bleed past its closing quote.
  const absPathRegex = /(?:^|[\s;|&`('"])(\/[^\s;|&>'"`)]+)/g;
  let match;
  while ((match = absPathRegex.exec(command)) !== null) {
    paths.push(match[1]);
  }

  // Home-relative paths.
  const homePathRegex = /(?:^|[\s;|&`('"])(~\/[^\s;|&>'"`)]+)/g;
  while ((match = homePathRegex.exec(command)) !== null) {
    paths.push(match[1].replace(/^~/, home));
  }

  // $HOME and ${HOME} variants. Matches at token boundary so we don't catch
  // substrings in unrelated words.
  const homeVarRegex = /(?:^|[\s;|&`('"])(\$\{?HOME\}?\/[^\s;|&>'"`)]+)/g;
  while ((match = homeVarRegex.exec(command)) !== null) {
    paths.push(resolveHomeVar(match[1]));
  }

  return paths;
}
