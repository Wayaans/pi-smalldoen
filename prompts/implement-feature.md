Use orchestration mode for this request.

If orchestration mode is not enabled, tell me to run `/orch` first.

Then execute the full workflow:
- decide whether scout is needed
- if needed, run scout first
- require planner to create or version the plan file
- read the plan
- execute worker packages sequentially or in parallel only when safe
- run reviewer
- if reviewer fails, reroute fixes up to the configured limit
- finish with a concise summary, changed files, plan path, and review verdict
