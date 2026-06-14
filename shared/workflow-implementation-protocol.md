# Workflow Implementation Protocol

> How new workflows are designed, implemented, tested, and maintained. Every agent follows this protocol when adding or modifying workflows.

---

## 1. How Workflows Are Born

All workflows originate from one of two sources:

**Source A — The Hive Owner**
The owner designs the workflow, either on their own or in conversation with an agent. The owner hands the spec to the appropriate agent for implementation.

**Source B — Agent Identified**
An agent identifies a workflow gap while working — a process that should be automated, a recurring task that should be documented. The agent drafts the spec and presents it to the owner for approval before implementation.

Regardless of source, every workflow must be documented as a spec before implementation.

---

## 2. Workflow Specification Format

Every workflow, before implementation, must be documented in this format:

```
# Workflow Spec: [NAME]

## Summary
[One paragraph: what this workflow does and why it exists.]

## Owner
[Which agent manages and executes this workflow.]

## Trigger
[When does this workflow run? Options: manual request / scheduled cron / event-driven]

## Inputs Required
[What data, systems, files, or information is needed to execute.]
- [Input 1: source and access method]
- [Input 2: source and access method]

## Steps
1. [Step-by-step procedure. Specific enough that following mechanically produces correct output.]
2. [Include which tools to use, which APIs to query, which files to read.]
3. [Include verification checkpoints within the procedure.]

## Expected Output
[What the deliverable looks like — format, structure, content, where it's saved.]

## Quality Criteria
[What "good" looks like. Specific enough to self-evaluate.]

## Verification Steps
[How the agent verifies output before delivering.]

## Escalation Conditions
[When the agent should stop and ask the owner instead of continuing.]

## Error Handling
[What to do when common failure modes occur — API failures, missing data, unexpected formats.]

## Schedule (if recurring)
[Cron expression or frequency. When it runs, how often.]

## Approval
- **Designed by:** [Owner / Agent name]
- **Approved by owner:** [Yes / Pending]
- **Date approved:** [date]
- **Version:** 1.0
```

---

## 3. Implementation Checklist

When a workflow spec is approved, the implementing agent follows EVERY step:

### Step 1 — Write the Procedure
Document the workflow in the agent's behavior files or a dedicated workflow file in the agent's directory. Include: task name, trigger, inputs, steps, expected output, quality criteria, escalation conditions.

### Step 2 — Configure Scheduling (if recurring)
If the workflow runs on a schedule, set up the cron job or scheduled task. Document the schedule clearly.

### Step 3 — Update Agent Memory
Log the new workflow in the agent's MEMORY.md so it persists across sessions. Include: what the workflow does, when it runs, where the spec is stored.

### Step 4 — Test Run
Execute the workflow once in a monitored test:
- Agent executes following the procedure.
- Verify the output meets quality criteria.
- If it passes: workflow is live.
- If it fails: diagnose, revise the procedure, re-test. Do not mark as active until it passes.

### Step 5 — Log the Completion
Write to the agent's daily memory file and OUTPUT-LOG.md.

---

## 4. Workflow Modification Protocol

When an existing workflow needs to change:

1. Draft the updated spec. Increment the version number.
2. Present to the owner for approval (unless the change is minor — fixing a typo, adding a clarification).
3. Update all affected files.
4. Test the modified workflow.
5. Log the change in the agent's daily memory.

---

## 5. Workflow Retirement Protocol

When a workflow is no longer needed:

1. Confirm with the owner.
2. Remove the cron job if scheduled.
3. Archive the spec (don't delete — move to an archive location).
4. Update the agent's MEMORY.md to reflect the retirement.
5. Log in daily memory.

---

## 6. Workflow Design Standards

### Idempotency
Every workflow should be idempotent when possible — running it twice with the same inputs should produce the same result without creating duplicates or side effects. If a workflow cannot be idempotent, it must include duplicate detection as an explicit step.

### Error Recovery
Every workflow must define what happens on failure. "Escalate to owner" is acceptable for unusual failures, but common failure modes (API timeout, missing data, format change) should have documented recovery steps.

### Verification Built In
Verification is not a separate step after the workflow — it's checkpoints within the workflow. A 10-step workflow should have at least 2-3 verification checkpoints, not just one check at the end.

### Single Responsibility
Each workflow does one thing. "Process invoices into accounting system" is one workflow. "Process invoices into accounting system and also reconcile last month's statements" is two workflows. If you're using the word "and" to describe what a workflow does, it might need to be split.

---

*Shared reference file. Available to all agents in the Hive.*
