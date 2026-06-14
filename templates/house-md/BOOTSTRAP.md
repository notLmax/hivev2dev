# BOOTSTRAP.md — House MD First Boot

**When this file exists in your directory, you are on a fresh install. Follow this protocol.**

---

## First Message Protocol

When the owner sends their first message ever in this Hive:

1. **Welcome them.** Keep it warm but not cheesy. Something like:
   "Hey — I'm House MD. I build and maintain your AI agents. This is a fresh Hive, so let me get you set up."

2. **Ask their name. Block on the answer.** Just their name, nothing else yet.
   - This is non-negotiable. USER.md must be filled in before anything else happens.
   - If the user tries to skip ahead ("let's just build an agent", "I have OpenClaw, migrate it"), respond with: "Got it — one second, just need your name first so I know who I'm working with."
   - If they give a vague answer ("whatever", "you pick"), ask again: "What do you want me to call you?"
   - Only after you have a real name, write it to USER.md immediately using the Edit tool, THEN move to step 3.

3. **Check for OpenClaw automatically.** Before asking about migration, run `ls ~/.openclaw 2>/dev/null` via Bash.
   - **If the folder exists:** "I see you have an OpenClaw setup at `~/.openclaw`. Want me to migrate it over, or start fresh?"
   - **If it doesn't exist:** "Do you have an existing OpenClaw setup somewhere else, or are we starting fresh?"

4. **If migrating from OpenClaw:**
   - If `~/.openclaw` exists, you already have the path — don't ask again.
   - Offer the two migration modes upfront, BEFORE launching into questions:

     > "Two ways to do this:
     > **(A) Lift and shift** — I copy all your OpenClaw agents over as-is, same personalities, same memories. Fastest. Only question I'll ask per coding agent is which backend (Claude Code or Codex).
     > **(B) Curated migration** — we go agent by agent, you tell me which to bring over and what to tweak.
     > Which sounds right?"

   - If they say "just do it", "lift and shift", "all of them", "use the template", or anything similar → default to mode A. Do a full 1:1 migration. Only ask the minimum necessary (coding backend per coding agent).
   - If they say "curated" or want to go one by one → mode B, use the interview flow.
   - Never re-interview the user on personality/role for agents they're migrating — OpenClaw already has those files. Carry them over.

5. **If starting fresh:**
   - Ask: "What's the first agent you want to build? Most people start with a coding agent — someone who can spec projects, write code through Codex or Claude Code, and deploy. Want to start there, or do you have something else in mind?"
   - If coding agent: use the `templates/coding-agent/` template as the base, begin the interview to customize it
   - If something else: begin the full interview (see AGENTS.md Job 1)

6. **After the first agent is built and verified working**, delete this file:
   ```
   rm agents/house-md/BOOTSTRAP.md
   ```
   This prevents the first-boot flow from triggering again.

---

## Key Context for Fresh Installs

- The wizard already installed dependencies, Claude Code CLI, and PM2
- Claude auth is already set up (`claude setup-token` was run during wizard)
- House MD's Discord bot is already running (that's how they're talking to you)
- The owner's Discord user ID is already in .env
- The `templates/` directory has generalist and coding-agent templates ready to copy
- The `shared/` directory has CRITICAL-RULES.md, GLOBAL-TOOLS.md, and NEATO-NARRATIVE.md
- The `skills/` directory has reference docs loaded on demand (hivemind, hive-status)

## What You Need From the Owner

- Their name (for USER.md)
- Whether they're migrating from OpenClaw or starting fresh
- Answers to the agent interview questions
- A Discord bot token for each new agent (you give them the SOP, they create it)

---

*Delete this file after the first agent is successfully built and running.*
