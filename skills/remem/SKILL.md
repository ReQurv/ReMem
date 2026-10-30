---
name: remem
description: Use when a fact, decision, agreement, or preference should be remembered across conversations (mem_remember); when past project context, decisions, or user preferences should be retrieved (mem_recall); when the user asks to delete or forget a remembered memory (mem_forget); when the file/folder map of a configured document source is needed (mem_index); or when ReMem calls fail and connectivity or configuration must be diagnosed (mem_status).
---

# ReMem — persistent memory for the agent

ReMem is a decisional memory system behind five MCP tools. All writes go
through one entry point (`mem_remember`), all reads through one exit point
(`mem_recall`), backed by three subsystems: a **vector store** (semantic
memories), a **knowledge graph** (entities and relations extracted from
memories), and a **file/folder index** (short descriptions of configured
document sources). Every call degrades gracefully — a downed subsystem is
annotated in the result, never a crash.

## Tool quick reference

| Tool | What it does | Typical trigger |
|------|--------------|-----------------|
| `mem_remember` | Stores a memory. Async — returns a queue ack, not a write receipt | A fact, decision, agreement, or preference is established |
| `mem_recall` | Retrieves related memories, graph facts, and index entries in one prompt-ready block | Past context is plausibly relevant to the current task |
| `mem_forget` | Deletes a memory by UUID (vector + graph via provenance) | The user explicitly asks to remove/forget something |
| `mem_index` | Rescans the configured file/folder sources (incremental), returns the file map | The file tree changed significantly; "what documents exist?" |
| `mem_status` | Reports tenant, router, backends, and index sources | ReMem calls are failing; the user asks how ReMem is configured |

## When to call `mem_remember`

Store information that is **durable and decision-relevant** and **not
derivable** from the current workspace or a fresh search:

- Decisions and their rationale ("we chose X over Y because …")
- Agreements and commitments made with the user
- User preferences and working style (language, formatting, review habits)
- Corrections and feedback ("the endpoint is /v2, not /api")
- Project facts absent from the code: roadmap, constraints, deadlines, stakeholders, environment quirks
- Non-trivial debugging learnings that will apply again

Use `source` for provenance (e.g. `meeting-2026-10-20`, `user-feedback`,
`debugging-auth`) and `collection` to scope a topic or project (default
`"default"`). Keep each memory a single focused fact — one decision per call.

**Never store:**

- Secrets — keys, tokens, passwords, credentials. Ever.
- Transient session state: file contents you just read, command output, intermediate results.
- Anything derivable from the repo itself (filenames, signatures, git history).
- Long verbatim text — distill to the fact or decision.
- Duplicates — if you are unsure a memory already exists, `mem_recall` it first.

`mem_remember` is **asynchronous**: it returns "Memory queued" immediately and
the write (embedding + graph extraction) runs in the background. If you need
to confirm a memory landed, `mem_recall` for it a moment later.

## When to call `mem_recall`

- **At the start of a task** that likely depends on prior context: project decisions, user preferences, constraints, past agreements.
- When the user refers to earlier work ("as we discussed", "what did we decide about …?").
- Before a decision that prior agreements may influence.
- When the user asks what you know about a topic.

One call usually covers all subsystems — the router picks the stores. Pass
`collections`, `only`, or `limit` only with a specific reason (e.g.
`collections: "project-a"` to stay inside one project's memories).

**Reading the output:**

- `## Memory` — related memories, one per line: `(score) [uuid] snippet`. The
  `[uuid]` is the id `mem_forget` takes — keep it if the user might later ask
  to remove that memory.
- `## Knowledge` — related knowledge-graph facts (entities, relations).
- `## Index` — matching file/folder entries with short descriptions: use them
  to know *where* to look without scanning the disk.
- `## Company memory` (enterprise mode only) — the same sections from the
  shared company tenant.
- Sections read `(no results)` when empty; degraded subsystems are annotated.

## When to call `mem_forget`

Only when the user **explicitly** asks to remove, delete, or forget something.
Find the memory first with `mem_recall` (each line shows its `[uuid]`), then
call `mem_forget` with that id. Forgetting an unknown id is a no-op. Never
forget speculatively or "to keep things clean".

## When to call `mem_index`

- After significant changes to the configured file trees (new documents, reorgs)
  when you need an up-to-date map.
- When the user asks what files or documents exist in a configured source.

Otherwise skip it: file-related queries are already answered by the `## Index`
section of `mem_recall`. Scans are incremental and cheap, but do not re-scan
without a reason.

## When to call `mem_status`

Only for diagnostics: when ReMem tool calls fail, to check which tenant,
router, backends, and index sources are configured, or when the user asks how
ReMem is set up.

## Enterprise mode (multi-tenant HTTP)

- `mem_recall` fuses your **personal** memory with the shared **company**
  memory (labeled `## Company memory`) in a single result.
- Writes go to your personal tenant by default. `scope: "company"` targets the
  company tenant and **requires the admin role** — use it only when the user
  explicitly wants something recorded for the whole team.
- In single-tenant (stdio) mode the `scope` parameter is ignored.

## Anti-patterns

- Recalling on every turn — memory is for when past context is plausibly relevant, not a preamble ritual.
- Storing what the workspace already says.
- Storing the same fact repeatedly — check with `mem_recall` first when unsure.
- Forgetting anything the user did not ask to remove.
- Treating "Memory queued" as confirmation — it is an ack, not a receipt.
