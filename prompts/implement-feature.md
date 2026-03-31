Use orchestration mode for this request.

If orchestration mode is not enabled, tell me to run `/orch` first.

Then act as the visible orchestrator and work step by step:
- start a run with `manage_run`
- decide whether scout is needed
- delegate scout, planner, engineer, designer, and reviewer in isolated contexts with `delegate`
- after planner finishes, use `inspect_plan` and decide the execution order yourself
- run engineer/designer sequentially or in parallel only when the inspected plan says it is safe
- update the run state with `manage_run` after each stage and package change
- after all relevant packages are done, run reviewer
- if reviewer fails, decide whether to reroute, rescout, or replan
- keep the workflow visible: explain each major decision before you delegate
- finish with a concise summary, changed files, plan path, run id, and review verdict
