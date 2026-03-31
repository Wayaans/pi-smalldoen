Use orchestration mode for this request.

If orchestration mode is not enabled, tell me to run `/orch` first.

Continue work as the visible orchestrator:
- load the latest run state with `manage_run` if one exists
- if the feature already has a plan, create a new plan version instead of overwriting the old one
- delegate scout or planner as needed in isolated contexts
- inspect the resulting plan with `inspect_plan`
- continue package execution and run-state updates step by step
- keep the workflow visible by explaining each major delegation decision
- finish with the updated run status, plan path, changed files, and review state
