/**
 * hooks.ts
 * Pre-tool hooks that intercept tool calls before execution.
 * This is the safety layer — it blocks dangerous commands,
 * enforces path restrictions, and requires confirmation for risky ops.
 */

interface SafetyConfig {
  blocked_commands: string[];
  allowed_paths: string[];
  protected_paths: string[];
  approval: {
    auto: string[];
    notify: string[];
    confirm: string[];
  };
}

interface ToolCall {
  tool_name: string;
  input: Record<string, unknown>;
}

export type ApprovalResult =
  | { action: "allow" }
  | { action: "notify"; message: string }
  | { action: "confirm"; message: string }
  | { action: "block"; reason: string };

/**
 * Checks a bash command against the blocklist.
 * Returns the matched blocked pattern or null if safe.
 */
function matchesBlockedCommand(
  command: string,
  blocklist: string[]
): string | null {
  const normalized = command.trim().toLowerCase();
  for (const blocked of blocklist) {
    if (normalized.includes(blocked.toLowerCase())) {
      return blocked;
    }
  }
  return null;
}

/**
 * Checks if a file path is within allowed directories.
 */
function isPathAllowed(filepath: string, allowedPaths: string[]): boolean {
  return allowedPaths.some((allowed) => filepath.startsWith(allowed));
}

/**
 * Checks if a file path is in a protected directory.
 */
function isPathProtected(filepath: string, protectedPaths: string[]): boolean {
  return protectedPaths.some((protected_) => filepath.startsWith(protected_));
}

/**
 * Main safety check — called before every tool execution.
 * Returns an ApprovalResult that determines what happens next.
 */
export function checkToolSafety(
  toolCall: ToolCall,
  config: SafetyConfig
): ApprovalResult {
  const { tool_name, input } = toolCall;

  // --- Bash commands get extra scrutiny ---
  if (tool_name === "Bash" || tool_name === "bash") {
    const command = (input.command as string) || "";

    // Check blocklist first — absolute block, no override
    const blocked = matchesBlockedCommand(command, config.blocked_commands);
    if (blocked) {
      return {
        action: "block",
        reason: `Blocked command pattern detected: \`${blocked}\`. This command is never allowed.`,
      };
    }

    // Check if command references protected paths
    for (const protPath of config.protected_paths) {
      if (command.includes(protPath)) {
        return {
          action: "confirm",
          message: `This command touches a protected path (${protPath}):\n\`\`\`\n${command}\n\`\`\`\nApprove? (yes/no)`,
        };
      }
    }

    // Catch sudo
    if (command.trim().startsWith("sudo")) {
      return {
        action: "confirm",
        message: `Sudo command requires approval:\n\`\`\`\n${command}\n\`\`\`\nApprove? (yes/no)`,
      };
    }

    // If command is in allowed paths, auto-approve
    // Otherwise, notify
    return { action: "notify", message: `Executing: \`${command}\`` };
  }

  // --- File writes check path restrictions ---
  if (tool_name === "Write" || tool_name === "Edit" || tool_name === "write" || tool_name === "edit") {
    const filepath = (input.file_path as string) || (input.path as string) || "";

    if (isPathProtected(filepath, config.protected_paths)) {
      return {
        action: "confirm",
        message: `Writing to protected path: \`${filepath}\`. Approve? (yes/no)`,
      };
    }

    if (!isPathAllowed(filepath, config.allowed_paths)) {
      return {
        action: "confirm",
        message: `Writing outside allowed directories: \`${filepath}\`. Approve? (yes/no)`,
      };
    }

    return { action: "allow" };
  }

  // --- Auto-approve safe tools ---
  if (config.approval.auto.includes(tool_name)) {
    return { action: "allow" };
  }

  // --- Notify-tier tools ---
  if (config.approval.notify.includes(tool_name)) {
    return {
      action: "notify",
      message: `Tool \`${tool_name}\` executed.`,
    };
  }

  // --- Confirm-tier tools ---
  if (config.approval.confirm.includes(tool_name)) {
    return {
      action: "confirm",
      message: `Tool \`${tool_name}\` requires your approval. Input: ${JSON.stringify(input, null, 2)}`,
    };
  }

  // Default: allow (unknown tools are probably SDK built-ins)
  return { action: "allow" };
}
