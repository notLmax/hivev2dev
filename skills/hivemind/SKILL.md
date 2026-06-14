---
name: hivemind
description: "Agent-to-agent communication reference. Use when you need to send messages to other agents, understand hivemind routing, or troubleshoot inter-agent messaging."
---

# Hivemind — Agent-to-Agent Communication

The **#hivemind** Discord channel is where agents talk to each other. All inter-agent messages route through this channel so the owner can monitor, but it stays out of direct conversation channels.

## How to Send a Message

Use the `SendMessage` MCP tool:

```
SendMessage(to: "your-analyst", message: "Research competitor TikTok Shop activity and send your findings back to me.")
```

This posts a formatted message in #hivemind:
> **[house-md → your-analyst]**
> Research competitor TikTok Shop activity and send your findings back to me.

The target agent picks it up, processes it, and responds:
> **[your-analyst → house-md]**
> Here are the findings...

Your bot automatically picks up responses addressed to you.

## Rules

- **Non-blocking**: After calling `SendMessage`, continue your conversation immediately. Don't wait.
- **Tell the owner**: "I've asked your analyst agent to research that. I'll share results when they come in."
- **Responses arrive as new messages**: Tagged with `[Message from <agent> via #hivemind]`.
- **Be specific**: Include what you need and ask them to send results back.
- **Don't over-respond**: If another agent tells you to stop messaging, STOP. Silence IS the correct response.
- **Don't relay what's already visible**: If the owner is talking to an agent in that agent's channel, don't summarize what they're discussing.

## Closing a thread gracefully — `[NO_REPLY]` marker

When you receive a hivemind message that doesn't need a response (acknowledgement, "thanks", info-only update), respond with **`[NO_REPLY]`** as the entire message, OR start your reply with `[NO_REPLY] ` followed by an optional one-liner. The bot recognises the marker and skips relaying anything to #hivemind. The thread closes cleanly on both sides.

Example:

> **You receive:** "**[house-md → your-analyst]** Got the report, thanks. Filing it."
> **Your response:** `[NO_REPLY]` (or: `[NO_REPLY] acknowledged`)

Without the marker, your reply would relay back to house-md, which would spin them up to read another acknowledgement, which they might also acknowledge, etc. The bot has a per-direction circuit breaker (5 relays / 60s) as backup, but the marker is the clean way.

When NOT to use it:
- Real responses to substantive questions — those should relay normally so the requester sees them.
- Errors or status changes the requester should know about.

## Available Agents

| Agent | Role | What to ask them |
|-------|------|-----------------|
| `house-md` | Chief of Staff / Generalist | Strategy, research, company context |
| `your-coder` | CTO / Coding | Code changes, deployments, technical work |
| `your-finance-agent` | CFO | Finance, QBO, Ramp, P&L, invoices |
| `your-analyst` | CIO | Data, BigQuery, Snowflake, market intelligence |
| `house-md` | Hive Architect | Agent issues, infrastructure, Hive maintenance |