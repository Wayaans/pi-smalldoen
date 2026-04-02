---
title: "Ctx7-first docs lookup with planner access"
slug: "ctx7-first-docs-lookup-planner-access"
created_at: "2026-04-02T02:00:56.973Z"
source_mode: "brainstorm"
artifact_type: "SPEC_IDEA"
---

# SPEC_IDEA: Ctx7-first docs lookup with planner access

## Summary

Let's build a more reliable `docs_lookup` tool that uses the installed `ctx7` CLI first, retries the ctx7 flow up to three times, and only falls back to the current URL/search behavior if ctx7 keeps failing. At the same time, planner should gain access to `docs_lookup` and receive explicit guidance to use it when plan quality depends on external API, CLI, or library behavior. The first version should prove that documentation validation is dependable during planning without making the tool surface or orchestration flow much larger.

## Why this matters

The current `docs_lookup` implementation relies on brittle direct web fetching/search and has not been dependable enough when agents need current documentation. Planner also lacks direct access, which makes it easier for plans to drift from real library behavior.

## Who this is for
- orchestrator
- scout
- planner

## Goals
- Use ctx7 as the primary documentation source
- Retry ctx7 lookup up to 3 times before fallback
- Preserve graceful fallback when ctx7 is unavailable or fails
- Allow planner to use docs_lookup while drafting plans
- Keep the tool output structured and readable

## Non-goals
- Do not redesign the whole tool contract
- Do not make docs lookup per-repo configurable in the first version
- Do not add new external services beyond the installed ctx7 CLI
- Do not expand docs_lookup into a general search engine

## Recommended approach

Keep `docs_lookup` as one shared tool and change only the lookup backend. For query lookups, try the ctx7 CLI first: resolve a library ID when needed, then fetch docs for that ID. Treat CLI errors, malformed output, empty results, or timeouts as failures, retry the ctx7 flow three times, and only then fall back to the existing fetch/search behavior. Add planner to the tool allowlist and update the planner prompt so it explicitly uses docs_lookup to verify external behavior before finalizing a plan.

## Alternatives considered
- ctx7-only with no fallback: simplest, but too brittle when the CLI or local environment is unavailable
- Configurable docs backend: flexible, but it adds config complexity before the need is proven
- Expand docs_lookup with explicit library inputs: useful later, but it changes the public tool contract too early

## Architecture
- docs.ts becomes the lookup engine and owns ctx7 subprocess calls, parsing, retries, and fallback
- index.ts expands docs_lookup availability from top-level/scout to include planner
- defaults/agents/planner.md gains docs_lookup in its tools list plus guidance on when to use it
- README.md documents ctx7-first lookup, retry budget, fallback behavior, and planner access

## Components
- Ctx7 runner: shells out to `ctx7` and captures stdout/stderr/exit code
- Library resolution step: resolves a library ID for query-based lookups
- Docs fetch step: queries ctx7 docs with the resolved library ID
- Fallback path: existing URL fetch / searchDocs behavior
- Planner prompt update: tells planner to verify external facts with docs_lookup

## Core flows
- Scout or planner asks docs_lookup about a library or URL
- Tool tries ctx7 first and retries up to three times on failure
- If ctx7 succeeds, structured docs content is returned
- If ctx7 fails three times, the existing fallback lookup is used
- Planner receives docs_lookup as an available tool and can use it while writing the plan

## Data flow
- User request reaches docs_lookup
- The tool normalizes the input and decides whether it needs library resolution or direct URL handling
- ctx7 library/docs commands run in a subprocess and return structured output
- If ctx7 succeeds, the result is converted into readable tool content and details
- If ctx7 fails repeatedly, the tool calls the existing fetchUrl/searchDocs path and returns that result instead

## Error handling
- Treat missing binary, non-zero exit codes, malformed output, empty docs, and timeouts as ctx7 failures
- Count each failed ctx7 attempt toward the 3-attempt budget
- Only enter fallback after all 3 ctx7 attempts fail
- Keep fallback errors visible in the tool result so failures are understandable
- Update the runtime error message so it no longer implies scout-only access

## Testing
- Smoke test a known library lookup through ctx7
- Verify ctx7 failure triggers 3 retries before fallback
- Verify planner can see and use docs_lookup
- Verify scout still retains access
- Verify disallowed roles still cannot call docs_lookup
- Verify returned output remains readable in collapsed and expanded tool views

## Scope for the first build
- Backend docs lookup switch to ctx7-first
- Three-attempt retry budget
- Planner tool access update
- Planner prompt guidance update
- Documentation update in README

## Success criteria
- docs_lookup uses ctx7 for normal lookups when ctx7 is available
- Fallback only happens after three ctx7 failures
- Planner can use docs_lookup during plan creation
- Plans reference verified external behavior more reliably
- The tool still degrades gracefully when ctx7 is unavailable

## Risks
- ctx7 output format may differ across versions or terminal environments
- Library resolution may be ambiguous for some package names
- Subprocess timeouts could slow planning if not bounded
- Fallback behavior might still mask ctx7 issues if logging is too quiet

## Open questions
- Should the ctx7 retry budget use a short fixed timeout per attempt or a shared overall timeout?
- Should direct URL lookups also try ctx7 first when the URL looks like a docs page, or only query-based lookups?
- Should planner guidance be a short sentence or a more explicit checklist?

## Follow-up slices
- Make the docs backend configurable per repo if a second provider becomes useful
- Add richer structured output for library IDs and snippets
- Expand docs lookup to other roles if planning proves especially helpful
