/**
 * memory.ts
 * Memory search and retrieval tools.
 * Reads from MEMORY.md files in agent behavior directories.
 * Uses simple keyword matching — upgrade to embeddings later if needed.
 */

import { readFileSync, writeFileSync, existsSync, appendFileSync } from "fs";
import { join } from "path";

interface MemoryEntry {
  section: string;
  content: string;
  line: number;
}

/**
 * Parses MEMORY.md into structured entries grouped by section.
 */
function parseMemoryFile(filepath: string): MemoryEntry[] {
  if (!existsSync(filepath)) return [];

  const content = readFileSync(filepath, "utf-8");
  const lines = content.split("\n");
  const entries: MemoryEntry[] = [];
  let currentSection = "General";

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();

    // Track section headers
    if (line.startsWith("## ")) {
      currentSection = line.replace("## ", "").trim();
      continue;
    }

    // Skip empty lines, comments, blockquotes, and top-level headers
    if (!line || line.startsWith("#") || line.startsWith(">")) continue;

    // Capture list items and plain text
    const cleanLine = line.replace(/^[-*]\s+/, "").trim();
    if (cleanLine) {
      entries.push({
        section: currentSection,
        content: cleanLine,
        line: i + 1,
      });
    }
  }

  return entries;
}

/**
 * Simple keyword-based search over memory entries.
 * Scores entries by how many query terms they match.
 */
export function memorySearch(
  behaviorDir: string,
  query: string,
  topK: number = 5
): MemoryEntry[] {
  const filepath = join(behaviorDir, "MEMORY.md");
  const entries = parseMemoryFile(filepath);

  if (entries.length === 0) return [];

  const queryTerms = query
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length > 2);

  // Score each entry by term matches
  const scored = entries.map((entry) => {
    const text = `${entry.section} ${entry.content}`.toLowerCase();
    let score = 0;
    for (const term of queryTerms) {
      if (text.includes(term)) score++;
    }
    return { entry, score };
  });

  // Return top-K entries with score > 0, sorted by score descending
  return scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK)
    .map((s) => s.entry);
}

/**
 * Gets all entries from a specific section of MEMORY.md.
 */
export function memoryGet(
  behaviorDir: string,
  section: string
): MemoryEntry[] {
  const filepath = join(behaviorDir, "MEMORY.md");
  const entries = parseMemoryFile(filepath);

  return entries.filter(
    (e) => e.section.toLowerCase() === section.toLowerCase()
  );
}

/**
 * Appends a new entry to a section in MEMORY.md.
 * Creates the section if it doesn't exist.
 */
export function memoryAppend(
  behaviorDir: string,
  section: string,
  content: string
): void {
  const filepath = join(behaviorDir, "MEMORY.md");

  if (!existsSync(filepath)) {
    // Create the file with the section
    const initial = `# MEMORY.md\n\n## ${section}\n- ${content}\n`;
    appendFileSync(filepath, initial);
    return;
  }

  const fileContent = readFileSync(filepath, "utf-8");

  // Check if section exists
  const sectionHeader = `## ${section}`;
  if (fileContent.includes(sectionHeader)) {
    // Find the section and append after the last entry in it
    const lines = fileContent.split("\n");
    let insertIdx = -1;
    let inSection = false;

    for (let i = 0; i < lines.length; i++) {
      if (lines[i].trim() === sectionHeader) {
        inSection = true;
        continue;
      }
      if (inSection) {
        if (lines[i].startsWith("## ") || lines[i].startsWith("# ")) {
          insertIdx = i;
          break;
        }
        insertIdx = i + 1; // Keep moving to end of section
      }
    }

    if (insertIdx > 0) {
      lines.splice(insertIdx, 0, `- ${content}`);
      const updated = lines.join("\n");
      writeFileSync(filepath, updated);
    }
  } else {
    // Append new section at end of file
    appendFileSync(filepath, `\n## ${section}\n- ${content}\n`);
  }
}
