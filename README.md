# pi-smalldoen

Project-local orchestration for [pi](https://www.npmjs.com/package/@mariozechner/pi-coding-agent).

It adds a visible top-level **orchestrator** plus specialized child roles:
- **scout** — repo and docs discovery
- **planner** — versioned plans
- **engineer** — code work
- **designer** — UI work
- **reviewer** — review pass

All artifacts stay under `.pi/`.

## Install

```bash
pi install -l git@github.com:Wayaans/pi-smalldoen.git
/reload
```

## Quick start

1. Enable a mode
2. Start working

If `.pi/smalldoen.json` is missing, smalldoen copies the packaged default config into `.pi/` automatically.

Then use one of these:

```bash
/orch on
/orch ask
/orch brainstorm
```

## Modes

### `/orch on`
Full orchestration mode.

Top-level tools:
- `manage_run`
- `inspect_plan`
- `delegate`
- `docs_lookup`

### `/orch ask`
Direct, read-only Q&A mode.

Rules:
- default model: `github-copilot/gpt-5.4-mini`
- no `delegate`
- no `manage_run`
- no `inspect_plan`
- no writing or implementation
- can still inspect the repo read-only and use `docs_lookup`

### `/orch brainstorm`
Collaborative idea-refinement mode before implementation.

Rules:
- default model: `github-copilot/gpt-5.4-mini`
- no `delegate`
- no `manage_run`
- no `inspect_plan`
- no implementation
- asks focused questions, one at a time
- explores 2-3 approaches with trade-offs before settling on a recommendation
- turns the idea into a concrete design with architecture, components, data flow, error handling, testing, scope, and success criteria
- no file writing until the user explicitly says the brainstorm is done or asks to save the idea
- can save a SPEC_IDEA to `.pi/smalldoen/ideas/<slug>.md`

## Indicator

The footer keeps **ORCH** visible in all top-level modes.

Examples:
- orchestration: `ORCH`
- ask: `ORCH ASK`
- brainstorm: `ORCH BRAINSTORM`

## Commands

- `/orch`
- `/orch on`
- `/orch ask`
- `/orch brainstorm`
- `/orch off`
- `/orch status`
- `/smalldoen-status`
- `/subagent-logs on|off|trace|full|status`
- `/commits`
- `/commits model`
- `/commits model reset`

## Default config

```json
{
  "observability": {
    "subagentLogs": "off"
  },
  "agents": {
    "orchestrator": { "provider": "github-copilot", "model": "claude-opus-4.6" },
    "scout": { "provider": "github-copilot", "model": "gemini-3-pro" },
    "planner": { "provider": "github-copilot", "model": "claude-sonnet-4.5" },
    "engineer": { "provider": "github-copilot", "model": "claude-sonnet-4.5" },
    "designer": { "provider": "github-copilot", "model": "claude-sonnet-4.5" },
    "reviewer": { "provider": "github-copilot", "model": "claude-opus-4.6" }
  }
}
```

## Prompt overrides

Role prompt lookup order:
1. prompt path from `.pi/smalldoen.json`
2. `.pi/agents/<role>.md`
3. packaged default in `defaults/agents/<role>.md`

Optional runtime hooks live in:
- `.pi/smalldoen/hooks/agent.md`
- `.pi/smalldoen/hooks/subagent.md`
- `.pi/smalldoen/hooks/<role>.md`

## Artifacts

Default artifact paths:
- `.pi/smalldoen/plans/`
- `.pi/smalldoen/memory/`
- `.pi/smalldoen/runs/`
- `.pi/smalldoen/logs/`
- `.pi/smalldoen/reports/scout/`
- `.pi/smalldoen/reports/review/`
- `.pi/smalldoen/ideas/`

## Notes

- `/commits` works only in `/orch on`
- `planner` is required before implementation in orchestration mode
- subagent logs are optional
- docs lookup uses ctx7 first, retries up to 3 times, and falls back to URL fetch/search when ctx7 fails
- `planner` and `scout` can use `docs_lookup` to validate current external API, CLI, and library behavior

## Safety

This package runs with your local permissions. Review it before using it in sensitive repositories.
