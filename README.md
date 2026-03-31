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
- visible orchestrator-led delegation flow
- isolated child agents per role
- package-based plan inspection and scheduling
- live run widget and status tracking
- `/commits` command for model-assisted git commits in `/orch` mode
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

You can copy the packaged example first:

```bash
mkdir -p .pi
cp /absolute/path/to/@wayanary/pi-smalldoen/defaults/smalldoen.example.json .pi/smalldoen.json
```

When the config file is missing, `/orch` prints the exact example path for your installation.

```bash
/orch on
```

Then ask for a full feature workflow.

## Configuration

Create this file in the target project:

- `.pi/smalldoen.json`

The packaged full example lives at `defaults/smalldoen.example.json` inside the installed package.

Minimal example:

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

## Role hooks

When orchestration mode is active, the runtime looks for additive hook files in `.pi/smalldoen/hooks/`.

These files do not replace the normal role prompt chain. The existing role prompt behavior stays the same:
- `.pi/smalldoen.json` can point a role at a custom prompt
- `.pi/agents/<role>.md` can override a role in the project
- packaged defaults still act as the fallback

Role hooks are appended at runtime to the effective system prompt after that normal resolution step. They are extra project-local guidance, not a new prompt source.

If the `.pi/smalldoen/hooks/` directory does not exist, or if any hook file is missing, the runtime skips it silently.

### Supported hook files

| File | Loaded for |
|------|------------|
| `.pi/smalldoen/hooks/agent.md` | Top-level orchestrator only |
| `.pi/smalldoen/hooks/subagent.md` | All delegated subagents |
| `.pi/smalldoen/hooks/scout.md` | Scout subagent only |
| `.pi/smalldoen/hooks/planner.md` | Planner subagent only |
| `.pi/smalldoen/hooks/engineer.md` | Engineer subagent only |
| `.pi/smalldoen/hooks/designer.md` | Designer subagent only |
| `.pi/smalldoen/hooks/reviewer.md` | Reviewer subagent only |

### Layering order

- Top-level orchestrator: `agent.md`
- Delegated subagents: `subagent.md`, then the matching role file such as `engineer.md` or `designer.md`

When more than one hook applies, the runtime concatenates the non-empty files in that order and appends them as runtime guidance. The injected block is labeled `Project-local hook:`.

## Available tools in orchestration mode

When `/orch` mode is enabled, the top-level session can use:

- `manage_run` — create and update the live orchestration run state
- `inspect_plan` — parse a plan and inspect safe package groups
- `delegate` — isolated child-role execution
- `docs_lookup` — framework and library documentation validation

## Commands

- `/orch`
- `/orch on`
- `/orch off`
- `/orch status`
- `/smalldoen-status`
- `/commits`
- `/commits model`
- `/commits model reset`

## Commits command

While `/orch` mode is active, run `/commits` to stage and commit the current project changes.

The command generates a commit message with an auto-selected fast/cheap model by default, then lets you review the message before the commit is created.

Use `/commits model` to choose a specific model for commit-message generation, or `/commits model reset` to go back to automatic model selection.

## Workflow

Typical full workflow:

1. **orchestrator** starts and updates the run
2. optional **scout** runs in an isolated child session
3. **planner** writes a versioned plan
4. **orchestrator** inspects the plan and chooses execution order
5. **engineer/designer** run isolated work packages sequentially or in parallel only when safe
6. **orchestrator** marks package progress and then starts **reviewer**
7. **orchestrator** decides reroute, rescout, or replan if needed

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
