/**
 * patch.ts
 * Multi-hunk file patching — applies multiple edits to a file in one pass.
 */

import { readFileSync, writeFileSync, existsSync } from "fs";

interface Hunk {
  search: string;
  replace: string;
}

interface PatchResult {
  success: boolean;
  filepath: string;
  hunksApplied: number;
  hunksTotal: number;
  errors: string[];
}

/**
 * Applies multiple search-and-replace hunks to a file.
 * All hunks must match or the patch is rejected (atomic).
 */
export function applyPatch(filepath: string, hunks: Hunk[]): PatchResult {
  const result: PatchResult = {
    success: false,
    filepath,
    hunksApplied: 0,
    hunksTotal: hunks.length,
    errors: [],
  };

  if (!existsSync(filepath)) {
    result.errors.push(`File not found: ${filepath}`);
    return result;
  }

  let content = readFileSync(filepath, "utf-8");

  // Pre-validate: all hunks must have a match
  for (let i = 0; i < hunks.length; i++) {
    if (!content.includes(hunks[i].search)) {
      result.errors.push(
        `Hunk ${i + 1}: search string not found in file`
      );
    }
  }

  if (result.errors.length > 0) return result;

  // Apply hunks in order
  for (const hunk of hunks) {
    content = content.replace(hunk.search, hunk.replace);
    result.hunksApplied++;
  }

  writeFileSync(filepath, content);
  result.success = true;
  return result;
}
