# pi-smalldoen

A project-local orchestration package for [pi](https://www.npmjs.com/package/@mariozechner/pi-coding-agent).

`pi-smalldoen` turns pi into a structured development workflow with specialized roles instead of one undifferentiated coding agent.

It adds an opt-in orchestration mode with:
- **orchestrator** — top-level controller
- **scout** — codebase and docs validation
- **planner** — versioned implementation plans
- **engineer** — logic and code execution
- **designer** — UI, UX, and frontend execution
- **reviewer** — direct review of changed and affected files

Everything stays project-local under `.pi/`.

## Why use this

Use `pi-smalldoen` when you want pi to behave more like a disciplined personal development workflow:

- planning before implementation
- optional discovery before planning
- implementation split into work packages
- parallel execution only when safe
- review and repair loops
- per-role model/provider config
- project-local memory, reports, and run manifests

## Features

- `/orch` toggle for orchestration mode
- footer indicator: **Orchestration mode**
- per-role prompt customization
- per-role provider/model selection
- project-local config via `.pi/smalldoen.json`
- versioned plan files
- package-based execution scheduling
- parallel-safe worker grouping
- reviewer with repair loops
- project-local memory, reports, and run manifests
- docs validation tool for orchestrator and scout

## Install

Install the package into the current project:

```bash
pi install -l git@github.com:Wayaans/pi-smalldoen.git
```

Use `-l` so pi writes the package into project-local `.pi/settings.json`.

Then reload pi:

```bash
/reload
```

## Quick start

1. Install the package
2. Create `.pi/smalldoen.json`
3. Configure per-role models
4. Start pi
5. Enable orchestration mode:

```bash
/orch on
```

Then ask for a full feature workflow.

## Configuration

Create this file in the target project:

- `.pi/smalldoen.json`

Example:

```json
{
  "ui": {
    "modeIndicatorText": "Orchestration mode"
  },
  "agents": {
    "orchestrator": {
      "provider": "github-copilot",
      "model": "claude-opus-4.6"
    },
    "scout": {
      "provider": "github-copilot",
      "model": "gemini-3-pro"
    },
    "planner": {
      "provider": "github-copilot",
      "model": "claude-sonnet-4.5"
    },
    "engineer": {
      "provider": "github-copilot",
      "model": "claude-sonnet-4.5"
    },
    "designer": {
      "provider": "github-copilot",
      "model": "claude-sonnet-4.5"
    },
    "reviewer": {
      "provider": "github-copilot",
      "model": "claude-opus-4.6"
    }
  }
}
```

## Prompt override order

For each role, prompt resolution order is:

1. prompt path from `.pi/smalldoen.json`
2. project override at `.pi/agents/<role>.md`
3. packaged default prompt at `defaults/agents/<role>.md`

This means the package works immediately after install, while projects can override only the roles they need.

## Available tools in orchestration mode

When `/orch` mode is enabled, the top-level session can use:

- `run_feature` — full end-to-end flow
- `plan_feature` — scout + planner stage
- `execute_plan` — execute packages from a validated plan
- `delegate` — manual child-role execution
- `docs_lookup` — framework and library documentation validation

## Commands

- `/orch`
- `/orch on`
- `/orch off`
- `/orch status`
- `/smalldoen-status`

## Workflow

Typical full workflow:

1. **orchestrator**
2. optional **scout**
3. **planner**
4. **engineer/designer** work packages
5. **reviewer**
6. repair loop if needed

## Project-local artifacts

By default, the package writes artifacts under:

- `.pi/smalldoen/plans/`
- `.pi/smalldoen/memory/`
- `.pi/smalldoen/runs/`
- `.pi/smalldoen/reports/scout/`
- `.pi/smalldoen/reports/review/`

These can be overridden in `.pi/smalldoen.json`.

## Limitations

- package conflict detection is file-list based
- changed-file extraction depends on worker output format
- docs lookup is lightweight, not a full crawler
- smoke testing in a real target project is strongly recommended before relying on it for important work

## Safety

This package runs extension code and child agents with your local permissions.
Review the code before using it in sensitive repositories.
