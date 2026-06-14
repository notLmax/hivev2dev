---
name: hive-status
description: Run a comprehensive health check on all Hive agents. Use when the owner asks about agent status, health, or wants to verify everything is running correctly.
---

# Hive Status Check

Run these checks in order and report results:

## 1. Agent Process Status
```bash
pm2 status
```
Verify all agents show "online" status. Flag any that are errored, stopped, or have high restart counts.

## 2. Memory Health
For each agent, check that daily memory files are being written:
```bash
ls -la agents/*/memory/ | grep "$(date +%Y-%m-%d)"
```
Flag any agent that hasn't written a memory file today.

## 3. Session Health
Check each agent's session file for valid session IDs:
```bash
cat agents/*/session.json
```
Flag any with empty session IDs or very old timestamps.

## 4. Recent Errors
Check PM2 error logs for each agent:
```bash
pm2 logs <agent-name> --lines 10 --nostream --err
```
Flag any real errors (ignore the Discord.js v15 deprecation warning — that's known and harmless).

## Report Format

Summarize as a table:

| Agent | PM2 | Memory Today | Session | Errors |
|-------|-----|-------------|---------|--------|
| name  | ✅/❌ | ✅/❌ | ✅/❌ | ✅/⚠️ |

Follow with details on anything flagged.
