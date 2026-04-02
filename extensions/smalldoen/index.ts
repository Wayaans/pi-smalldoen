import * as fs from "node:fs/promises";
import * as fsSync from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { complete, StringEnum } from "@mariozechner/pi-ai";
import { BorderedLoader, getMarkdownTheme, type ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Container, Markdown, Spacer, Text, type AutocompleteItem } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { getAgentConfig } from "./agents";
import { findProjectRoot, getConfiguredModelSpec, getConfiguredSubagentLogMode, getConfigPath, hasSmalldoenConfig } from "./config";
import { buildDocsContext, fetchUrl, searchDocs } from "./docs";
import { runDelegatedRole, workerRoles, type WorkerRole } from "./delegate";
import {
	assertArtifactPathAllowed,
	assertPlannerPathAllowed,
	getRuntimeRole,
	isReadOnlyBashCommand,
	isTopLevelOrchestrationModeEnabled,
	isTopLevelSmalldoenModeEnabled,
} from "./guards";
import { buildAgentHookContent } from "./hooks";
import { buildRoleMemoryContext } from "./memory";
import {
	applyModeIndicator,
	getSmalldoenMode,
	restoreOrchestrationMode,
	setOrchestrationMode,
	toggleOrchestrationMode,
} from "./mode";
import {
	getLatestPlanPath,
	loadParsedPlan,
	slugifyFeatureName,
	type ParsedPlan,
} from "./plan";
import {
	ensureRuntimeLayout,
	getReviewReportPath,
	getRunSummaryPath,
	getScoutReportPath,
	getSmalldoenPaths,
} from "./paths";
import { parseChangedFiles, parseReviewOutput } from "./reviewer";
import {
	appendRunEvent,
	createRunManifest,
	loadLatestRunManifest,
	loadRunManifest,
	markRunFinished,
	markRunStale,
	replacePackageStates,
	updateRunManifest,
	upsertPackageState,
	upsertSubagentState,
	type RunManifest,
	type RunPackageState,
} from "./run-state";
import { schedulePackages } from "./scheduler";
import {
	DELEGATE_TOOL_NAME,
	type AgentRole,
	type DelegateToolDetails,
	type ManageRunDetails,
	type OrchestrationModeState,
	type PlanIdeaDetails,
	type PlanInspectionDetails,
	type ReviewSummary,
	type SmalldoenMode,
	type SubagentLogMode,
} from "./types";

const DOCS_LOOKUP_TOOL_NAME = "docs_lookup" as const;
const INSPECT_PLAN_TOOL_NAME = "inspect_plan" as const;
const MANAGE_RUN_TOOL_NAME = "manage_run" as const;
const SAVE_PLAN_IDEA_TOOL_NAME = "save_plan_idea" as const;
const SMALLDOEN_RUN_WIDGET_KEY = "smalldoen-run-widget" as const;
const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const DISCOVERY_MODE_DEFAULT_MODEL_SPEC = "github-copilot/gpt-5.4-mini";
const modeState: OrchestrationModeState = { mode: "off" };
const runtimeRole = getRuntimeRole();

let activeRunId: string | undefined;
let commitsModelSpec: string | undefined;
let subagentLogsOverride: SubagentLogMode | undefined;
let runSummaryCwd: string | undefined;

const SMALLDOEN_COMMITS_MODEL_ENTRY = "smalldoen-commits-model" as const;
const SMALLDOEN_SUBAGENT_LOGS_ENTRY = "smalldoen-subagent-logs" as const;
const ORCH_IMPLEMENT_TEMPLATE = `Use orchestration mode for this request.

If orchestration mode is not enabled, tell me to run \`/orch\` first.

Then act as the visible orchestrator and work step by step:
- start a run with \`manage_run\`
- decide whether scout is needed
- delegate scout, planner, engineer, designer, and reviewer in isolated contexts with \`delegate\`
- after planner finishes, use \`inspect_plan\` and decide the execution order yourself
- run engineer/designer sequentially or in parallel only when the inspected plan says it is safe
- update the run state with \`manage_run\` after each stage and package change
- after all relevant packages are done, run reviewer
- if reviewer fails, decide whether to reroute, rescout, or replan
- keep the workflow visible: explain each major decision before you delegate
- finish with a concise summary, changed files, plan path, run id, and review verdict`;
const ORCH_CONTINUE_TEMPLATE = `Use orchestration mode for this request.

If orchestration mode is not enabled, tell me to run \`/orch\` first.

Continue work as the visible orchestrator:
- load the latest run state with \`manage_run\` if one exists
- if the feature already has a plan, create a new plan version instead of overwriting the old one
- delegate scout or planner as needed in isolated contexts
- inspect the resulting plan with \`inspect_plan\`
- continue package execution and run-state updates step by step
- keep the workflow visible by explaining each major delegation decision
- finish with the updated run status, plan path, changed files, and review state`;
const ORCH_REVIEW_TEMPLATE = `Use orchestration mode for this request.

If orchestration mode is not enabled, tell me to run \`/orch\` first.

Load the latest orchestration run state with \`manage_run\`, inspect the latest plan, and rerun the reviewer in an isolated context with \`delegate\`. Keep the review workflow visible, then return the verdict, critical issues, warnings, rerouting guidance, and updated run status.`;
const ORCH_USAGE = "Usage: /orch [toggle|on|ask|brainstorm|off|status|implement <description>|continue [context]|review|summary]";
const ORCH_SUBCOMMAND_COMPLETIONS: AutocompleteItem[] = [
	{ value: "toggle", label: "toggle", description: "Toggle smalldoen mode on or off." },
	{ value: "on", label: "on", description: "Enable orchestration mode." },
	{ value: "ask", label: "ask", description: "Enable ask mode for direct, read-only answers without delegation." },
	{ value: "brainstorm", label: "brainstorm", description: "Enable brainstorm mode for refining ideas into a concrete spec idea before implementation." },
	{ value: "off", label: "off", description: "Disable smalldoen mode." },
	{ value: "status", label: "status", description: "Show the current smalldoen mode." },
	{ value: "implement ", label: "implement", description: "Load the implementation template. Continue typing the feature description." },
	{ value: "continue ", label: "continue", description: "Load the continue template. Continue typing extra context." },
	{ value: "review", label: "review", description: "Load the review template for the latest orchestration run." },
	{ value: "summary", label: "summary", description: "List saved orchestration run summaries." },
];
const ORCH_KNOWN_COMMANDS = new Set(["", ...ORCH_SUBCOMMAND_COMPLETIONS.map((item) => item.label)]);
const COMMITS_SYSTEM_PROMPT = `You write concise, high-signal git commit messages.

Rules:
- Output only the commit message text.
- No markdown fences, bullets, quotes, or commentary.
- Prefer a conventional-commit style prefix when it is clearly justified, such as feat, fix, refactor, docs, test, or chore.
- Use imperative mood.
- Keep the subject line under 72 characters when possible.
- Focus on user-visible behavior and meaningful implementation changes, not incidental tooling noise.`;

interface CommitsModelEntry {
	spec?: string;
	updatedAt: string;
}

interface SubagentLogsEntry {
	mode?: SubagentLogMode;
	updatedAt: string;
}

const ORCHESTRATOR_RUNTIME_PROMPT = `
Orchestration mode is enabled for this session.

You are the orchestrator: the visible top-level agent, project manager, and decision-maker for the full workflow.

Hard rules:
- Do not use write or edit.
- Do not implement product code directly.
- Keep orchestration decisions in your own turns. Do not hide the workflow inside macro tools.
- Use manage_run to create and update the live run artifact.
- Use delegate to run scout, planner, engineer, designer, and reviewer in isolated child sessions.
- Use inspect_plan after planner completes so you can inspect package metadata and safe parallel groups yourself.
- Before each major delegation, briefly tell the user what you decided and why.
- After each delegated role finishes, read its result yourself and decide the next step.
- Planner is mandatory before any implementation work.
- Only launch multiple engineer or designer delegates in the same turn when you intentionally chose a parallel-safe group from inspect_plan.
- After each package finishes, update the run package state with manage_run.
- Run reviewer only after the relevant packages are complete.
- If reviewer fails, you decide whether to reroute work, rescout, or replan.
`;

const ASK_MODE_RUNTIME_PROMPT = `
Ask mode is enabled for this session.

You are still the visible orchestrator, but this mode is answer-only.

Hard rules:
- Answer the user directly.
- Do not use write or edit.
- Do not implement product code directly.
- Do not use delegate, manage_run, or inspect_plan.
- Do not create plans or execute workflow steps.
- Stay read-only when inspecting the repository.
- You may use read, read-only bash commands, and docs_lookup when they help you answer accurately.
- If the user asks you to implement something, explain that ask mode is for questions only and tell them to switch back to normal orchestration mode.
`;

const BRAINSTORM_MODE_RUNTIME_PROMPT = `
Brainstorm mode is enabled for this session.

You are still the visible orchestrator, but this mode is for collaborative idea refinement before implementation.

Hard rules:
- Do not use write or edit.
- Do not implement product code directly.
- Do not use delegate, manage_run, or inspect_plan.
- Do not create implementation plans.
- Stay in brainstorming mode until the user explicitly says the brainstorming is done or explicitly asks you to write or save the spec idea.
- Until that moment, do not write files.
- Start by understanding the current project state. Inspect relevant files, docs, and nearby context before you refine the idea.
- Assess scope early. If the request actually contains multiple independent subsystems, say so immediately, help decompose it into smaller spec ideas, and then brainstorm the first slice.
- Ask one focused question per message. Prefer multiple-choice questions when they make the answer easier.
- Focus on purpose, users, constraints, success criteria, non-goals, and the first realistic slice.
- Once the idea is clear enough, propose 2-3 approaches with tradeoffs. Lead with your recommendation and explain why it fits best.
- Do not jump from a rough idea to a vague summary. Make the design concrete: architecture, components, data flow, error handling, testing, scope, and success criteria.
- Before presenting the design, ask if the user is ready for it. Then present it section by section and check whether each section looks right.
- Use YAGNI. Prefer smaller, well-bounded units with clear interfaces and responsibilities.
- Keep the discussion collaborative, concrete, and explanatory. Avoid bland one-line bullets, vague claims, and second-person recap.
- When the user explicitly asks you to write or save the spec idea, use save_plan_idea.
- The only file brainstorm mode produces is a SPEC_IDEA.
- The resulting SPEC_IDEA should read like a collaborative build brief, for example "Let's build ...", and it should explain the recommendation, tradeoffs, and structure clearly.
- You may use read, read-only bash commands, and docs_lookup when they help the brainstorm.
`;

const DelegateParams = Type.Object({
	role: StringEnum(workerRoles, { description: "Specialized child role to run in an isolated pi subprocess." }),
	task: Type.String({ description: "Task for the delegated role." }),
	feature: Type.Optional(
		Type.String({ description: "Feature name or feature slug. Required for planner so the runtime can version the plan path." }),
	),
	runId: Type.Optional(Type.String({ description: "Optional orchestration run id from manage_run start. Enables live run status tracking." })),
	label: Type.Optional(Type.String({ description: "Optional short UI label such as Scout pass, Planner, PKG-001, or Review." })),
	packageId: Type.Optional(Type.String({ description: "Optional package id for engineer or designer work such as PKG-001." })),
});

const InspectPlanParams = Type.Object({
	feature: Type.Optional(Type.String({ description: "Feature name or feature slug. Used to resolve the latest plan if planPath is omitted." })),
	planPath: Type.Optional(Type.String({ description: "Explicit path to a plan file. If omitted, the latest plan for feature is used." })),
	packageIds: Type.Optional(Type.Array(Type.String({ description: "Optional subset of package ids to inspect and schedule." }))),
});

const ManageRunParams = Type.Object({
	action: StringEnum(["start", "status", "stage", "package", "review", "finish"] as const, {
		description: "Run state operation to perform.",
	}),
	runId: Type.Optional(Type.String({ description: "Run id. Required for all actions except start and latest-status lookups." })),
	feature: Type.Optional(Type.String({ description: "Feature name or slug. Required for start." })),
	objective: Type.Optional(Type.String({ description: "Feature objective. Required for start." })),
	stage: Type.Optional(Type.String({ description: "Current orchestration stage, for example intake, scout, planning, execution, review, repair." })),
	note: Type.Optional(Type.String({ description: "Optional event or status note to store alongside the update." })),
	planPath: Type.Optional(Type.String({ description: "Optional plan path to attach to the run. If provided on stage, package states are initialized from the plan." })),
	packageId: Type.Optional(Type.String({ description: "Package id to update." })),
	packageStatus: Type.Optional(
		StringEnum(["pending", "running", "completed", "failed", "blocked"] as const, {
			description: "New package status for action package.",
		}),
	),
	changedFiles: Type.Optional(Type.Array(Type.String({ description: "Files actually changed by the completed package." }))),
	verdict: Type.Optional(
		StringEnum(["pass", "pass_with_warnings", "fail"] as const, {
			description: "Review verdict for action review.",
		}),
	),
	routingHint: Type.Optional(
		StringEnum(["none", "engineer", "designer", "both"] as const, {
			description: "Reviewer routing hint for action review.",
		}),
	),
	needRescout: Type.Optional(Type.Boolean({ description: "Whether reviewer requested a new scout pass." })),
	reportPath: Type.Optional(Type.String({ description: "Optional report path, usually from a scout or review delegate result." })),
	finalStatus: Type.Optional(
		StringEnum(["completed", "failed", "stale"] as const, {
			description: "Final run status for action finish.",
		}),
	),
});

const DocsLookupParams = Type.Object({
	query: Type.Optional(Type.String({ description: "Search query for framework or library documentation." })),
	url: Type.Optional(Type.String({ description: "Direct documentation URL to fetch." })),
});

const SavePlanIdeaParams = Type.Object({
	title: Type.String({ description: "Short name for the spec idea." }),
	summary: Type.String({ description: "A short collaborative build brief in 1-3 paragraphs. Explain what we are building, why it matters, and what the first version should prove." }),
	problem: Type.Optional(Type.String({ description: "Problem, opportunity, or motivation behind the idea." })),
	users: Type.Optional(Type.Array(Type.String({ description: "Primary users or audiences." }))),
	goals: Type.Optional(Type.Array(Type.String({ description: "What this idea should achieve." }))),
	nonGoals: Type.Optional(Type.Array(Type.String({ description: "What is intentionally out of scope." }))),
	recommendedApproach: Type.Optional(Type.String({ description: "Recommended approach and why it is the best fit." })),
	alternatives: Type.Optional(Type.Array(Type.String({ description: "Alternative approaches and their tradeoffs." }))),
	architecture: Type.Optional(Type.Array(Type.String({ description: "Major architectural decisions and boundaries." }))),
	components: Type.Optional(Type.Array(Type.String({ description: "Main components or units, each with a clear purpose." }))),
	coreFlows: Type.Optional(Type.Array(Type.String({ description: "Key user flows, capabilities, or experiences." }))),
	dataFlow: Type.Optional(Type.Array(Type.String({ description: "How data or requests move through the system." }))),
	errorHandling: Type.Optional(Type.Array(Type.String({ description: "Important failure cases and how the system should respond." }))),
	testing: Type.Optional(Type.Array(Type.String({ description: "How the idea should be tested or validated." }))),
	scope: Type.Optional(Type.Array(Type.String({ description: "Concrete scope items for the first build." }))),
	successCriteria: Type.Optional(Type.Array(Type.String({ description: "Signals that the idea works well." }))),
	risks: Type.Optional(Type.Array(Type.String({ description: "Main risks, dependencies, or sharp edges." }))),
	openQuestions: Type.Optional(Type.Array(Type.String({ description: "Questions that still need answers." }))),
	followUpSlices: Type.Optional(Type.Array(Type.String({ description: "Follow-up sub-projects or later slices if the broader idea should be decomposed." }))),
	slug: Type.Optional(Type.String({ description: "Optional custom file slug. Defaults to a slugified title." })),
});

function resolveEffectiveRole(): AgentRole | undefined {
	if (runtimeRole) return runtimeRole;
	return isTopLevelSmalldoenModeEnabled(modeState.mode) ? "orchestrator" : undefined;
}

function describeMode(mode: SmalldoenMode): string {
	if (mode === "orchestrate") return "Orchestration mode is ON";
	if (mode === "ask") return "Ask mode is ON";
	if (mode === "brainstorm") return "Brainstorm mode is ON";
	return "Smalldoen modes are OFF";
}

function resolveOptionalUserPath(cwd: string, input?: string): string | undefined {
	if (!input) return undefined;
	const normalized = input.startsWith("@") ? input.slice(1) : input;
	return path.resolve(cwd, normalized);
}

function syncTopLevelTools(pi: ExtensionAPI): void {
	if (runtimeRole) return;
	const activeTools = new Set(pi.getActiveTools());
	const orchestrationOnlyTools = [DELEGATE_TOOL_NAME, INSPECT_PLAN_TOOL_NAME, MANAGE_RUN_TOOL_NAME];
	for (const toolName of orchestrationOnlyTools) {
		if (modeState.mode === "orchestrate") activeTools.add(toolName);
		else activeTools.delete(toolName);
	}
	if (isTopLevelSmalldoenModeEnabled(modeState.mode)) activeTools.add(DOCS_LOOKUP_TOOL_NAME);
	else activeTools.delete(DOCS_LOOKUP_TOOL_NAME);
	if (modeState.mode === "brainstorm") activeTools.add(SAVE_PLAN_IDEA_TOOL_NAME);
	else activeTools.delete(SAVE_PLAN_IDEA_TOOL_NAME);
	pi.setActiveTools(Array.from(activeTools));
}

function summarizeText(value: string, lineCount = 3): string {
	const lines = value
		.split("\n")
		.map((line) => line.trimEnd())
		.filter(Boolean)
		.slice(0, lineCount);
	return lines.join("\n");
}

function relativePath(cwd: string, filePath?: string): string | undefined {
	if (!filePath) return undefined;
	const relative = path.relative(cwd, filePath);
	return relative && !relative.startsWith("..") ? relative : filePath;
}

function compactPath(cwd: string, filePath?: string, segmentCount = 3): string | undefined {
	const relative = relativePath(cwd, filePath);
	if (!relative) return undefined;
	const parts = relative.split(/[\\/]/).filter(Boolean);
	return parts.length <= segmentCount ? relative : `…/${parts.slice(-segmentCount).join("/")}`;
}

function formatDelegateLogMeta(details: Pick<DelegateToolDetails, "traceLogPath" | "rawLogPath" | "stderrLogPath">, cwd?: string): string[] {
	return [
		details.traceLogPath ? `trace ${cwd ? compactPath(cwd, details.traceLogPath, 4) : details.traceLogPath}` : undefined,
		details.rawLogPath ? `raw ${cwd ? compactPath(cwd, details.rawLogPath, 4) : details.rawLogPath}` : undefined,
		details.stderrLogPath ? `stderr ${cwd ? compactPath(cwd, details.stderrLogPath, 4) : details.stderrLogPath}` : undefined,
	].filter((line): line is string => Boolean(line));
}

function restoreCommitsModel(ctx: any): void {
	commitsModelSpec = undefined;
	for (const entry of ctx.sessionManager.getBranch() as Array<any>) {
		if (entry.type !== "custom" || entry.customType !== SMALLDOEN_COMMITS_MODEL_ENTRY) continue;
		const spec = (entry.data as CommitsModelEntry | undefined)?.spec?.trim();
		commitsModelSpec = spec || undefined;
	}
}

function persistCommitsModel(pi: ExtensionAPI, spec?: string): string | undefined {
	const normalized = spec?.trim() || undefined;
	commitsModelSpec = normalized;
	pi.appendEntry(SMALLDOEN_COMMITS_MODEL_ENTRY, {
		spec: normalized,
		updatedAt: new Date().toISOString(),
	});
	return normalized;
}

function restoreSubagentLogsMode(ctx: any): void {
	subagentLogsOverride = undefined;
	for (const entry of ctx.sessionManager.getBranch() as Array<any>) {
		if (entry.type !== "custom" || entry.customType !== SMALLDOEN_SUBAGENT_LOGS_ENTRY) continue;
		const mode = (entry.data as SubagentLogsEntry | undefined)?.mode;
		subagentLogsOverride = mode === "off" || mode === "trace" || mode === "full" ? mode : undefined;
	}
}

function persistSubagentLogsMode(pi: ExtensionAPI, mode?: SubagentLogMode): SubagentLogMode | undefined {
	const normalized = mode === "off" || mode === "trace" || mode === "full" ? mode : undefined;
	subagentLogsOverride = normalized;
	pi.appendEntry(SMALLDOEN_SUBAGENT_LOGS_ENTRY, {
		mode: normalized,
		updatedAt: new Date().toISOString(),
	});
	return normalized;
}

function getEffectiveSubagentLogsMode(cwd: string): SubagentLogMode {
	return subagentLogsOverride ?? getConfiguredSubagentLogMode(cwd);
}

function enableSubagentLogsForSession(pi: ExtensionAPI, cwd: string): { effective: SubagentLogMode; source: "config" | "session" } {
	const configured = getConfiguredSubagentLogMode(cwd);
	if (configured !== "off") {
		persistSubagentLogsMode(pi, undefined);
		return { effective: configured, source: "config" };
	}
	persistSubagentLogsMode(pi, "trace");
	return { effective: "trace", source: "session" };
}

function describeSubagentLogsStatus(cwd: string): string {
	const configured = getConfiguredSubagentLogMode(cwd);
	const effective = getEffectiveSubagentLogsMode(cwd);
	const source = subagentLogsOverride ? "session override" : "config default";
	const logsDir = getSmalldoenPaths(cwd).logsDir;
	return [
		`Subagent logs: ${effective.toUpperCase()} (${source})`,
		`Configured default: ${configured.toUpperCase()}`,
		`Logs directory: ${logsDir}`,
	].join("\n");
}

function formatModelSpec(model: { provider: string; id: string }): string {
	return `${model.provider}/${model.id}`;
}

function rankCommitModel(model: any): [number, number, string] {
	const identity = `${formatModelSpec(model)} ${String(model.name ?? "")}`.toLowerCase();
	const cost = Number(model.cost?.input ?? 0)
		+ Number(model.cost?.output ?? 0)
		+ Number(model.cost?.cacheRead ?? 0)
		+ Number(model.cost?.cacheWrite ?? 0);
	let tier = 1;
	if (/(flash|mini|haiku|nano|small|lite|instant)/.test(identity)) tier = 0;
	if (/(opus|pro|reasoning|thinking|o1|o3|r1|grok-4|large)/.test(identity)) tier = 3;
	if (/(sonnet|gpt-4o|gpt-4\.1(?!-mini)|gemini-2\.5-pro)/.test(identity)) tier = Math.max(tier, 2);
	return [tier, cost, formatModelSpec(model)];
}

function pickDefaultCommitsModel(ctx: any): any | undefined {
	const available = ctx.modelRegistry.getAvailable().filter((model: any) => model.input?.includes("text"));
	if (available.length === 0) return ctx.model;
	return [...available].sort((a, b) => {
		const [tierA, costA, labelA] = rankCommitModel(a);
		const [tierB, costB, labelB] = rankCommitModel(b);
		return tierA - tierB || costA - costB || labelA.localeCompare(labelB);
	})[0];
}

function resolveCommitsModel(ctx: any): { model: any | undefined; source: "selected" | "auto" } {
	if (commitsModelSpec) {
		const [provider, ...rest] = commitsModelSpec.split("/");
		const modelId = rest.join("/");
		if (provider && modelId) {
			const model = ctx.modelRegistry.find(provider, modelId);
			if (model && ctx.modelRegistry.hasConfiguredAuth(model)) return { model, source: "selected" };
		}
	}
	return { model: pickDefaultCommitsModel(ctx), source: "auto" };
}

function normalizeCommitMessage(value: string): string {
	const trimmed = value.trim();
	if (!trimmed) return "";
	const unwrapped = trimmed.replace(/^['"`]+|['"`]+$/g, "");
	return unwrapped
		.split("\n")
		.map((line) => line.trimEnd())
		.join("\n")
		.trim();
}

function extractTextContent(content: unknown): string {
	if (!Array.isArray(content)) return "";
	return content
		.filter((part): part is { type: "text"; text: string } => typeof part === "object" && part !== null && (part as any).type === "text" && typeof (part as any).text === "string")
		.map((part) => part.text)
		.join("\n");
}

function getLastAssistantText(ctx: any): string | undefined {
	for (let index = ctx.sessionManager.getBranch().length - 1; index >= 0; index--) {
		const entry = ctx.sessionManager.getBranch()[index];
		if (entry?.type !== "message") continue;
		const message = entry.message;
		if (message?.role !== "assistant") continue;
		const text = extractTextContent(message.content).trim();
		if (text) return text;
	}
	return undefined;
}

function truncatePromptSection(title: string, value: string | undefined, maxChars: number): string {
	const normalized = value?.trim() || "(none)";
	if (normalized.length <= maxChars) return `${title}:\n${normalized}`;
	return `${title}:\n${normalized.slice(0, maxChars)}\n… [truncated ${normalized.length - maxChars} chars]`;
}

function parseChangedPathsFromStatus(status: string): string[] {
	const files = new Set<string>();
	for (const line of status.split("\n")) {
		const raw = line.trimEnd();
		if (!raw) continue;
		const file = raw.slice(3).split(" -> ").pop()?.trim();
		if (file) files.add(file);
	}
	return Array.from(files);
}

function fallbackCommitMessage(changedFiles: string[]): string {
	if (changedFiles.length === 1) return `chore: update ${path.basename(changedFiles[0])}`;
	if (changedFiles.length > 1 && changedFiles.length <= 3) return `chore: update ${changedFiles.length} project files`;
	return "chore: update project files";
}

async function generateCommitMessageDraft(ctx: any, model: any, promptText: string): Promise<string | null> {
	const run = async (signal?: AbortSignal) => {
		const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
		if (!auth.ok) throw new Error(auth.error);
		if (!auth.apiKey) throw new Error(`No API key for ${model.provider}`);
		const response = await complete(
			model,
			{
				systemPrompt: COMMITS_SYSTEM_PROMPT,
				messages: [{
					role: "user",
					content: [{ type: "text", text: promptText }],
					timestamp: Date.now(),
				}],
			},
			{ apiKey: auth.apiKey, headers: auth.headers, signal },
		);
		if (response.stopReason === "aborted") return null;
		return normalizeCommitMessage(extractTextContent(response.content));
	};

	if (!ctx.hasUI) return run(ctx.signal);
	return ctx.ui.custom((tui: any, theme: any, _kb: any, done: (result: string | null) => void) => {
		const loader = new BorderedLoader(tui, theme, `Generating commit message with ${formatModelSpec(model)}...`);
		loader.onAbort = () => done(null);
		run(loader.signal)
			.then(done)
			.catch((error) => {
				console.error("Commit message generation failed:", error);
				done(null);
			});
		return loader;
	});
}

function packageCounts(manifest: RunManifest) {
	const counts = { pending: 0, running: 0, completed: 0, failed: 0, blocked: 0 };
	for (const pkg of manifest.packages) counts[pkg.status] += 1;
	return counts;
}

function activeSubagents(manifest: RunManifest) {
	return manifest.subagents.filter((subagent) => subagent.status === "running");
}

function statusIcon(status: RunManifest["status"] | DelegateToolDetails["status"] | "completed" | "failed"): string {
	switch (status) {
		case "running":
			return "…";
		case "completed":
		case "success":
			return "✓";
		case "failed":
		case "error":
			return "✗";
		case "active":
			return "●";
		case "stale":
			return "◌";
		case "aborted":
			return "○";
		default:
			return "○";
	}
}

function badge(theme: any, color: string, label: string): string {
	return theme.fg(color, theme.bold(`[${label}]`));
}

function visibleTextLength(value: string): number {
	return value.replace(/\x1b\[[0-9;]*m/g, "").length;
}

function rightAlign(value: string, width: number): string {
	const padding = Math.max(0, width - visibleTextLength(value));
	return `${" ".repeat(padding)}${value}`;
}

function buildModeBadgeLine(theme: any, manifest: RunManifest | undefined, mode: SmalldoenMode): string | undefined {
	if (mode === "off") return undefined;
	const pills: string[] = [];
	if (mode === "orchestrate" && manifest && manifest.status === "active") {
		const counts = packageCounts(manifest);
		if (counts.failed > 0) pills.push(badge(theme, "error", `✗ ${counts.failed}`));
		if (counts.running > 0) pills.push(badge(theme, "warning", `… ${counts.running}`));
		if (counts.completed > 0 && (manifest.stage === "review" || manifest.stage === "repair" || manifest.stage === "execution")) {
			pills.push(badge(theme, "success", `✓ ${counts.completed}`));
		}
		for (const subagent of activeSubagents(manifest).slice(0, 2)) {
			pills.push(badge(theme, "warning", subagent.packageId ? `${subagent.role.toUpperCase()} ${subagent.packageId}` : subagent.role.toUpperCase()));
		}
		pills.push(badge(theme, "muted", effectiveStageLabel(manifest)));
	}
	pills.push(badge(theme, "accent", "ORCH"));
	if (mode === "ask") pills.push(badge(theme, "muted", "ASK"));
	if (mode === "brainstorm") pills.push(badge(theme, "muted", "BRAINSTORM"));
	return pills.join(" ");
}

function applyRunVisualization(ctx: any, manifest: RunManifest | undefined, mode: SmalldoenMode): void {
	if (!ctx.hasUI) return;
	if (mode === "off") {
		ctx.ui.setWidget(SMALLDOEN_RUN_WIDGET_KEY, undefined);
		return;
	}
	ctx.ui.setWidget(SMALLDOEN_RUN_WIDGET_KEY, (_tui: any, theme: any) => ({
		render(width: number): string[] {
			const line = buildModeBadgeLine(theme, manifest, mode);
			return line ? [rightAlign(line, width)] : [];
		},
		invalidate() {},
	}));
}

function setActiveRun(manifest: RunManifest | undefined): void {
	activeRunId = manifest?.status === "active" ? manifest.runId : undefined;
}

async function refreshRunVisualization(ctx: any): Promise<void> {
	if (!isTopLevelSmalldoenModeEnabled(modeState.mode)) {
		setActiveRun(undefined);
		applyRunVisualization(ctx, undefined, "off");
		return;
	}
	if (modeState.mode !== "orchestrate") {
		setActiveRun(undefined);
		applyRunVisualization(ctx, undefined, modeState.mode);
		return;
	}
	if (!activeRunId) {
		applyRunVisualization(ctx, undefined, modeState.mode);
		return;
	}
	const manifest = await loadRunManifest(ctx.cwd, activeRunId);
	const activeManifest = manifest?.status === "active" ? manifest : undefined;
	setActiveRun(activeManifest);
	applyRunVisualization(ctx, activeManifest, modeState.mode);
}

function getDefaultConfigExamplePath(): string {
	return path.join(packageRoot, "defaults", "smalldoen.example.json");
}

function buildConfigSeedFailureGuidance(cwd: string): { message: string; editorText: string } {
	const projectRoot = findProjectRoot(cwd);
	const configPath = getConfigPath(cwd);
	const examplePath = getDefaultConfigExamplePath();
	const copyCommand = `mkdir -p "${path.dirname(configPath)}" && cp "${examplePath}" "${configPath}"`;
	return {
		message: `Failed to create .pi/smalldoen.json automatically: ${configPath}`,
		editorText: [
			"Failed to create smalldoen config automatically.",
			"",
			`Create this file in the project root: ${configPath}`,
			`Project root: ${projectRoot}`,
			`Default example config: ${examplePath}`,
			`Copy example: ${copyCommand}`,
		].join("\n"),
	};
}

async function ensureConfigPresent(cwd: string): Promise<boolean> {
	if (hasSmalldoenConfig(cwd)) return false;
	const configPath = getConfigPath(cwd);
	const examplePath = getDefaultConfigExamplePath();
	try {
		await fs.mkdir(path.dirname(configPath), { recursive: true });
		await fs.copyFile(examplePath, configPath, fsSync.constants.COPYFILE_EXCL);
		return true;
	} catch (error) {
		const code = error && typeof error === "object" ? (error as { code?: string }).code : undefined;
		if (code === "EEXIST") return false;
		const guidance = buildConfigSeedFailureGuidance(cwd);
		const detail = error instanceof Error ? error.message : String(error);
		throw new Error(`${guidance.editorText}\n\nOriginal error: ${detail}`);
	}
}

async function ensureOrchestrationRuntime(cwd: string): Promise<void> {
	await ensureConfigPresent(cwd);
	await ensureRuntimeLayout(cwd);
}

function effectiveStageLabel(manifest: RunManifest): string {
	const roles = new Set(activeSubagents(manifest).map((subagent) => subagent.role));
	if (roles.has("engineer") && !roles.has("designer") && roles.size === 1) return "ENGINEERING";
	if (roles.has("designer") && !roles.has("engineer") && roles.size === 1) return "DESIGNING";
	if (roles.has("engineer") || roles.has("designer")) return "EXECUTING";
	if (roles.has("scout") && roles.size === 1) return "SCOUTING";
	if (roles.has("planner") && roles.size === 1) return "PLANNING";
	if (roles.has("reviewer") && roles.size === 1) return "REVIEWING";
	return manifest.stage.toUpperCase();
}

async function writeReport(filePath: string, content: string): Promise<void> {
	await fs.mkdir(path.dirname(filePath), { recursive: true });
	await fs.writeFile(filePath, content, "utf8");
}

async function resolvePlanIdeaPath(cwd: string, title: string, requestedSlug?: string): Promise<{ slug: string; filePath: string }> {
	const ideasDir = getSmalldoenPaths(cwd).ideasDir;
	const baseSlug = slugifyFeatureName(requestedSlug?.trim() || title);
	let slug = baseSlug;
	let filePath = path.join(ideasDir, `${slug}.md`);
	let counter = 2;
	while (true) {
		try {
			await fs.access(filePath);
			slug = `${baseSlug}-${counter}`;
			filePath = path.join(ideasDir, `${slug}.md`);
			counter += 1;
		} catch {
			return { slug, filePath };
		}
	}
}

function renderPlanIdeaMarkdown(
	input: Omit<PlanIdeaDetails, "path"> & {
		summary: string;
		problem?: string;
		users?: string[];
		goals?: string[];
		nonGoals?: string[];
		recommendedApproach?: string;
		alternatives?: string[];
		architecture?: string[];
		components?: string[];
		coreFlows?: string[];
		dataFlow?: string[];
		errorHandling?: string[];
		testing?: string[];
		scope?: string[];
		successCriteria?: string[];
		risks?: string[];
		openQuestions?: string[];
		followUpSlices?: string[];
	},
): string {
	const quote = (value: string) => JSON.stringify(value);
	const lines = [
		"---",
		`title: ${quote(input.title)}`,
		`slug: ${quote(input.slug)}`,
		`created_at: ${quote(input.createdAt)}`,
		`source_mode: ${quote("brainstorm")}`,
		`artifact_type: ${quote("SPEC_IDEA")}`,
		"---",
		"",
		`# SPEC_IDEA: ${input.title}`,
		"",
		"## Summary",
		"",
		input.summary.trim(),
	];
	const pushParagraphSection = (heading: string, value?: string) => {
		if (!value?.trim()) return;
		lines.push("", heading, "", value.trim());
	};
	const pushSection = (heading: string, value?: string[]) => {
		const items = value?.map((item) => item.trim()).filter(Boolean);
		if (!items || items.length === 0) return;
		lines.push("", heading, ...items.map((item) => `- ${item}`));
	};
	pushParagraphSection("## Why this matters", input.problem);
	pushSection("## Who this is for", input.users);
	pushSection("## Goals", input.goals);
	pushSection("## Non-goals", input.nonGoals);
	pushParagraphSection("## Recommended approach", input.recommendedApproach);
	pushSection("## Alternatives considered", input.alternatives);
	pushSection("## Architecture", input.architecture);
	pushSection("## Components", input.components);
	pushSection("## Core flows", input.coreFlows);
	pushSection("## Data flow", input.dataFlow);
	pushSection("## Error handling", input.errorHandling);
	pushSection("## Testing", input.testing);
	pushSection("## Scope for the first build", input.scope);
	pushSection("## Success criteria", input.successCriteria);
	pushSection("## Risks", input.risks);
	pushSection("## Open questions", input.openQuestions);
	pushSection("## Follow-up slices", input.followUpSlices);
	return `${lines.join("\n")}\n`;
}

async function loadRunManifestRequired(cwd: string, runId: string): Promise<RunManifest> {
	const manifest = await loadRunManifest(cwd, runId);
	if (!manifest) throw new Error(`Run manifest not found: ${runId}`);
	return manifest;
}

function buildPackageStates(plan: ParsedPlan): Array<Omit<RunPackageState, "updatedAt">> {
	return plan.packages.map((pkg) => ({
		packageId: pkg.packageId,
		owner: pkg.owner,
		goal: pkg.goal,
		status: "pending",
	}));
}

function buildReviewSummary(output: string): ReviewSummary {
	const parsed = parseReviewOutput(output);
	return {
		verdict: parsed.verdict,
		routingHint: parsed.routingHint,
		needRescout: parsed.needRescout,
		summary: parsed.summary,
	};
}

function buildPlanInspectionDetails(plan: ParsedPlan, packageIds?: string[]): PlanInspectionDetails {
	const groups = schedulePackages(plan, packageIds);
	return {
		featureSlug: plan.frontmatter.feature_slug,
		planPath: plan.path,
		parallelAllowed: plan.frontmatter.parallel_allowed,
		packageCount: packageIds?.length ? groups.reduce((count, group) => count + group.packages.length, 0) : plan.packages.length,
		groups: groups.map((group) => ({ index: group.index, packageIds: group.packages.map((pkg) => pkg.packageId) })),
		packages: plan.packages.map((pkg) => ({
			packageId: pkg.packageId,
			owner: pkg.owner,
			goal: pkg.goal,
			filesToChange: pkg.filesToChange,
			affectedFiles: pkg.affectedFiles,
			dependsOn: pkg.dependsOn,
			parallelSafe: pkg.parallelSafe,
			acceptanceChecks: pkg.acceptanceChecks,
		})),
	};
}

function buildManageRunDetails(
	action: ManageRunDetails["action"],
	manifest: RunManifest,
	extra?: { packageId?: string },
): ManageRunDetails {
	const counts = packageCounts(manifest);
	return {
		action,
		runId: manifest.runId,
		feature: manifest.feature,
		featureSlug: manifest.featureSlug,
		status: manifest.status,
		stage: manifest.stage,
		updatedAt: manifest.updatedAt,
		planPath: manifest.planPath,
		review: manifest.review,
		packageCount: manifest.packages.length,
		activeSubagentCount: activeSubagents(manifest).length,
		completedPackageCount: counts.completed,
		failedPackageCount: counts.failed,
		packageId: extra?.packageId,
	};
}

function formatManifestSummary(manifest: RunManifest): string {
	const counts = packageCounts(manifest);
	const lines = [
		`Run ID: ${manifest.runId}`,
		`Status: ${manifest.status}`,
		`Stage: ${manifest.stage}`,
		`Feature: ${manifest.feature} (${manifest.featureSlug})`,
		`Objective: ${manifest.objective}`,
		`Plan: ${manifest.planPath ?? "(none)"}`,
		`Scout used: ${manifest.scoutUsed ? "yes" : "no"}`,
		`Updated: ${manifest.updatedAt}`,
		`Packages: total ${manifest.packages.length} | completed ${counts.completed} | running ${counts.running} | failed ${counts.failed} | pending ${counts.pending} | blocked ${counts.blocked}`,
	];
	if (manifest.staleReason) lines.push(`Stale reason: ${manifest.staleReason}`);
	if (manifest.review) lines.push(`Review verdict: ${manifest.review.verdict} (${manifest.review.routingHint})`);
	if (manifest.packages.length > 0) {
		lines.push("", "Package Status:");
		for (const pkg of manifest.packages) {
			lines.push(`- ${pkg.packageId} [${pkg.status}]${pkg.owner ? ` (${pkg.owner})` : ""}${pkg.goal ? ` ${pkg.goal}` : ""}`);
		}
	}
	if (manifest.subagents.length > 0) {
		lines.push("", "Recent Subagents:");
		for (const subagent of manifest.subagents.slice(0, 8)) {
			lines.push(`- [${subagent.updatedAt}] ${subagent.role} ${subagent.label} -> ${subagent.status}`);
			for (const logLine of formatDelegateLogMeta(subagent)) lines.push(`  ${logLine}`);
		}
	}
	if (manifest.events.length > 0) {
		lines.push("", "Recent events:");
		for (const event of manifest.events.slice(-10)) lines.push(`- [${event.timestamp}] ${event.type}: ${event.message}`);
	}
	return lines.join("\n");
}

function renderDelegateResult(details: DelegateToolDetails, expanded: boolean, isPartial: boolean, theme: any) {
	const status = isPartial ? "running" : details.status;
	const statusColor = status === "success" ? "success" : status === "running" ? "warning" : status === "aborted" ? "muted" : "error";
	const metaBits = [
		theme.fg(statusColor, statusIcon(status)),
		details.model ? theme.fg("dim", details.model) : undefined,
		details.runId ? theme.fg("dim", details.runId) : undefined,
	].filter(Boolean).join("  ");
	const preview = details.finalOutput ? summarizeText(details.finalOutput, 4) : "(running...)";
	if (!expanded) return new Text(`${metaBits}\n${theme.fg("toolOutput", preview)}`, 0, 0);

	const container = new Container();
	container.addChild(new Text(metaBits, 0, 0));
	if (details.reportPath) container.addChild(new Text(theme.fg("dim", `report ${details.reportPath}`), 0, 0));
	for (const logLine of formatDelegateLogMeta(details)) container.addChild(new Text(theme.fg("dim", logLine), 0, 0));
	if (details.changedFiles && details.changedFiles.length > 0) container.addChild(new Text(theme.fg("muted", `files ${details.changedFiles.join(", ")}`), 0, 0));
	if (details.review) container.addChild(new Text(theme.fg("muted", `review ${details.review.verdict} / ${details.review.routingHint}`), 0, 0));
	if (details.stderr) container.addChild(new Text(theme.fg("warning", details.stderr.trim()), 0, 0));
	container.addChild(new Spacer(1));
	container.addChild(new Markdown(details.finalOutput || (status === "running" ? "(running...)" : "(no output)"), 0, 0, getMarkdownTheme()));
	return container;
}

function renderInspectPlanResult(details: PlanInspectionDetails, expanded: boolean, theme: any) {
	const header = `${theme.fg("success", "✓")} ${theme.fg("toolTitle", theme.bold("inspect_plan"))}${theme.fg("dim", `  ${details.planPath}`)}`;
	if (!expanded) {
		return new Text(`${header}\n${theme.fg("dim", `packages:${details.packageCount} groups:${details.groups.length} parallel:${details.parallelAllowed ? "yes" : "no"}`)}`, 0, 0);
	}
	const lines = [
		header,
		`feature: ${details.featureSlug}`,
		`parallel allowed: ${details.parallelAllowed ? "yes" : "no"}`,
		"",
		"Groups:",
		...details.groups.map((group) => `- Group ${group.index}: ${group.packageIds.join(", ")}`),
		"",
		"Packages:",
		...details.packages.map((pkg) => `- ${pkg.packageId} (${pkg.owner}) ${pkg.goal}`),
	];
	return new Markdown(lines.join("\n"), 0, 0, getMarkdownTheme());
}

function renderManageRunResult(details: ManageRunDetails, expanded: boolean, theme: any) {
	const contextDetail = details.packageId ?? (details.action === "start" || details.action === "status"
		? details.feature
		: details.action === "finish"
			? details.status
			: details.stage ?? details.feature);
	const metaBits = [
		theme.fg("success", "✓"),
		theme.fg("muted", details.action),
		theme.fg("toolOutput", contextDetail),
		theme.fg("dim", details.runId),
	].filter(Boolean).join("  ");
	const counterLine = details.packageCount > 0
		? [
				theme.fg("muted", `[○ ${details.packageCount}]`),
				theme.fg("success", `[✓ ${details.completedPackageCount}]`),
				theme.fg("error", `[✗ ${details.failedPackageCount}]`),
			].join(" ")
		: undefined;
	if (!expanded) return new Text([metaBits, counterLine].filter(Boolean).join("\n"), 0, 0);
	const lines = [
		metaBits,
		counterLine,
		theme.fg("dim", `stage ${details.stage}`),
		details.planPath ? theme.fg("dim", `plan ${details.planPath}`) : undefined,
		details.review ? theme.fg("dim", `review ${details.review.verdict} / ${details.review.routingHint}`) : undefined,
	].filter(Boolean).join("\n");
	return new Text(lines, 0, 0);
}

function parseModelSpec(spec: string): { provider: string; modelId: string } | undefined {
	const [provider, ...rest] = spec.split("/");
	const modelId = rest.join("/");
	return provider && modelId ? { provider, modelId } : undefined;
}

async function applyModelSpec(
	pi: ExtensionAPI,
	ctx: any,
	state: OrchestrationModeState,
	spec: string,
	messages: { notFound: string; missingAuth: string },
): Promise<void> {
	const parsed = parseModelSpec(spec);
	if (!parsed) return;
	if (ctx.model?.provider === parsed.provider && ctx.model?.id === parsed.modelId) return;
	if (!state.previousModelSpec && ctx.model?.provider && ctx.model?.id) {
		state.previousModelSpec = `${ctx.model.provider}/${ctx.model.id}`;
	}
	const model = ctx.modelRegistry.find(parsed.provider, parsed.modelId);
	if (!model) {
		ctx.ui.notify(messages.notFound, "warning");
		return;
	}
	const success = await pi.setModel(model);
	if (!success) ctx.ui.notify(messages.missingAuth, "warning");
}

async function applyTopLevelModeModel(pi: ExtensionAPI, ctx: any, state: OrchestrationModeState): Promise<void> {
	if (state.mode === "orchestrate") {
		const spec = getConfiguredModelSpec(ctx.cwd, "orchestrator");
		if (!spec) return;
		await applyModelSpec(pi, ctx, state, spec, {
			notFound: `Configured orchestrator model not found: ${spec}`,
			missingAuth: `No credentials for orchestrator model: ${spec}`,
		});
		return;
	}
	if (state.mode === "ask" || state.mode === "brainstorm") {
		const modeLabel = state.mode === "ask" ? "Ask" : "Brainstorm";
		await applyModelSpec(pi, ctx, state, DISCOVERY_MODE_DEFAULT_MODEL_SPEC, {
			notFound: `${modeLabel} mode default model not found: ${DISCOVERY_MODE_DEFAULT_MODEL_SPEC}`,
			missingAuth: `No credentials for ${modeLabel.toLowerCase()} mode default model: ${DISCOVERY_MODE_DEFAULT_MODEL_SPEC}`,
		});
	}
}

async function restorePreviousModel(pi: ExtensionAPI, ctx: any, state: OrchestrationModeState): Promise<void> {
	const spec = state.previousModelSpec;
	if (!spec) return;
	const parsed = parseModelSpec(spec);
	if (!parsed) {
		state.previousModelSpec = undefined;
		return;
	}
	const model = ctx.modelRegistry.find(parsed.provider, parsed.modelId);
	if (model) await pi.setModel(model);
	state.previousModelSpec = undefined;
}

async function buildOrchestratorPrompt(cwd: string, mode: SmalldoenMode): Promise<string> {
	if (mode === "ask") return ASK_MODE_RUNTIME_PROMPT.trim();
	if (mode === "brainstorm") return BRAINSTORM_MODE_RUNTIME_PROMPT.trim();
	const agent = getAgentConfig(cwd, "orchestrator");
	const prompt = agent?.systemPrompt?.trim();
	return [ORCHESTRATOR_RUNTIME_PROMPT.trim(), prompt].filter(Boolean).join("\n\n");
}

function setCommandInput(pi: ExtensionAPI, ctx: any, text: string): void {
	const inputApi = pi as ExtensionAPI & { setInput?: (value: string) => void };
	if (typeof inputApi.setInput === "function") inputApi.setInput(text);
	else ctx.ui.setEditorText(text);
}

function getOrchArgumentCompletions(argumentPrefix: string): AutocompleteItem[] | null {
	const normalizedPrefix = argumentPrefix.replace(/^\s+/, "");
	if (/\s/.test(normalizedPrefix)) return null;
	const query = normalizedPrefix.toLowerCase();
	const matches = ORCH_SUBCOMMAND_COMPLETIONS.filter((item) => item.label.toLowerCase().startsWith(query));
	return matches.length > 0 ? matches : null;
}

function countHistoricalRunsForSummary(): number {
	if (!runSummaryCwd) return 1;
	try {
		const entries = fsSync.readdirSync(getSmalldoenPaths(runSummaryCwd).runsDir, { withFileTypes: true });
		const count = entries.filter((entry) => entry.isFile() && entry.name.endsWith(".json")).length;
		return count > 0 ? count : 1;
	} catch {
		return 1;
	}
}

function buildRunSummary(manifest: RunManifest, note?: string): string {
	const counts = packageCounts(manifest);
	const historicalRunCount = countHistoricalRunsForSummary();
	const subagentLines = manifest.subagents.length > 0
		? [...manifest.subagents]
			.sort((left, right) => left.updatedAt.localeCompare(right.updatedAt))
			.map((subagent) => `- ${subagent.role}${subagent.label ? ` (${subagent.label})` : ""} — ${subagent.model ?? "unknown model"}`)
		: ["- none recorded"];
	const lines = [
		`# ${manifest.feature}`,
		"",
		`- Objective: ${manifest.objective}`,
		`- Run ID: ${manifest.runId}`,
		`- Final status: ${manifest.status}`,
		`- Historical run count: ${historicalRunCount}`,
		"",
		"## Subagents Used",
		...subagentLines,
		"",
		"## Package Totals",
		`- Completed: ${counts.completed}`,
		`- Failed: ${counts.failed}`,
	];
	if (note?.trim()) lines.push("", "## Final Note", note.trim());
	return lines.join("\n");
}

export default function smalldoenExtension(pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx) => {
		restoreOrchestrationMode(ctx, modeState);
		restoreCommitsModel(ctx);
		restoreSubagentLogsMode(ctx);
		syncTopLevelTools(pi);
		if (modeState.mode !== "off" && !runtimeRole) {
			if (modeState.mode === "orchestrate") await ensureOrchestrationRuntime(ctx.cwd);
			else await ensureConfigPresent(ctx.cwd);
			await applyTopLevelModeModel(pi, ctx, modeState);
		}
		setActiveRun(undefined);
		await refreshRunVisualization(ctx);
	});

	pi.on("session_switch", async (_event, ctx) => {
		restoreOrchestrationMode(ctx, modeState);
		restoreCommitsModel(ctx);
		restoreSubagentLogsMode(ctx);
		syncTopLevelTools(pi);
		if (modeState.mode !== "off" && !runtimeRole) {
			if (modeState.mode === "orchestrate") await ensureOrchestrationRuntime(ctx.cwd);
			else await ensureConfigPresent(ctx.cwd);
			await applyTopLevelModeModel(pi, ctx, modeState);
		}
		setActiveRun(undefined);
		await refreshRunVisualization(ctx);
	});

	pi.on("input", async (event, ctx) => {
		if (!isTopLevelSmalldoenModeEnabled(modeState.mode)) return { action: "continue" as const };
		const text = event.text.trim();
		if (!text) return { action: "continue" as const };
		if (text.startsWith("/orch")) return { action: "continue" as const };
		if (modeState.mode !== "orchestrate") return { action: "continue" as const };
		try {
			await ensureOrchestrationRuntime(ctx.cwd);
		} catch (error) {
			ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			return { action: "handled" as const };
		}
		if (!activeRunId) return { action: "continue" as const };
		const manifest = await loadRunManifest(ctx.cwd, activeRunId);
		if (manifest && manifest.status === "active") {
			const stale = await markRunStale(ctx.cwd, manifest, `Superseded by new user input: ${event.text.trim().slice(0, 200)}`);
			await appendRunEvent(ctx.cwd, stale, "run_stale", "Run marked stale because a new user instruction interrupted the workflow.");
			setActiveRun(undefined);
			applyRunVisualization(ctx, stale, modeState.mode);
		}
		if (!ctx.isIdle()) ctx.abort();
		return { action: "continue" as const };
	});

	pi.registerCommand("orch", {
		description: "Control smalldoen modes (toggle|on|ask|brainstorm|off|status|implement|continue|review|summary)",
		getArgumentCompletions: getOrchArgumentCompletions,
		handler: async (args, ctx) => {
			const rawArgs = (args || "").trim();
			const spaceIndex = rawArgs.indexOf(" ");
			const command = (spaceIndex === -1 ? rawArgs : rawArgs.slice(0, spaceIndex)).toLowerCase();
			const commandArgs = spaceIndex === -1 ? "" : rawArgs.slice(spaceIndex + 1).trim();
			const current = getSmalldoenMode(modeState);
			if (!ORCH_KNOWN_COMMANDS.has(command)) {
				ctx.ui.notify(ORCH_USAGE, "warning");
				return;
			}
			if (command === "status") {
				ctx.ui.notify(describeMode(current), "info");
				applyModeIndicator(ctx, current);
				await refreshRunVisualization(ctx);
				return;
			}
			if (command === "implement") {
				const featureLine = commandArgs ? `\n\nFeature request: ${commandArgs}` : "";
				setCommandInput(pi, ctx, `${ORCH_IMPLEMENT_TEMPLATE}${featureLine}`);
				ctx.ui.notify("Loaded /orch implement template into the input.", "info");
				return;
			}
			if (command === "continue") {
				const extraLine = commandArgs ? `\n\nAdditional context: ${commandArgs}` : "";
				setCommandInput(pi, ctx, `${ORCH_CONTINUE_TEMPLATE}${extraLine}`);
				ctx.ui.notify("Loaded /orch continue template into the input.", "info");
				return;
			}
			if (command === "review") {
				setCommandInput(pi, ctx, ORCH_REVIEW_TEMPLATE);
				ctx.ui.notify("Loaded /orch review template into the input.", "info");
				return;
			}
			if (command === "summary") {
				const summariesDir = getSmalldoenPaths(ctx.cwd).summariesDir;
				let files: string[] = [];
				try {
					files = (await fs.readdir(summariesDir)).filter((file) => file.endsWith(".md")).sort().reverse();
				} catch {
					files = [];
				}
				if (files.length === 0) {
					ctx.ui.notify("No saved run summaries found.", "info");
					return;
				}
				ctx.ui.setEditorText([
					`Saved run summaries (${files.length})`,
					"",
					...files.map((file) => `- ${relativePath(ctx.cwd, path.join(summariesDir, file)) ?? path.join(summariesDir, file)}`),
				].join("\n"));
				ctx.ui.notify(`Listed ${files.length} saved summary file(s).`, "info");
				return;
			}
			if ((command === "" || command === "toggle" || command === "on" || command === "ask" || command === "brainstorm" || command === "off") && !ctx.isIdle()) ctx.abort();
			let next: SmalldoenMode = current;
			if (command === "on") next = "orchestrate";
			else if (command === "ask") next = "ask";
			else if (command === "brainstorm") next = "brainstorm";
			else if (command === "off") next = "off";
			else next = toggleOrchestrationMode(pi, ctx, modeState);
			if (command === "on" || command === "ask" || command === "brainstorm" || command === "off") setOrchestrationMode(pi, ctx, modeState, next);
			if (!runtimeRole) {
				if (next === "orchestrate") await ensureOrchestrationRuntime(ctx.cwd);
				else if (next !== "off") await ensureConfigPresent(ctx.cwd);
				if (next !== "off") await applyTopLevelModeModel(pi, ctx, modeState);
				else await restorePreviousModel(pi, ctx, modeState);
			}
			syncTopLevelTools(pi);
			ctx.ui.notify(describeMode(next), "info");
			if (current !== next && next !== "orchestrate") setActiveRun(undefined);
			await refreshRunVisualization(ctx);
		},
	});

	pi.registerCommand("smalldoen-status", {
		description: "Show the latest smalldoen orchestration run status",
		handler: async (_args, ctx) => {
			const manifest = await loadLatestRunManifest(ctx.cwd);
			if (!manifest) {
				ctx.ui.notify("No orchestration runs found.", "info");
				return;
			}
			ctx.ui.setEditorText(formatManifestSummary(manifest));
			applyRunVisualization(ctx, manifest, modeState.mode);
			ctx.ui.notify(`Loaded status for ${manifest.runId}`, "info");
		},
	});

	pi.registerCommand("subagent-logs", {
		description: "Control delegated subagent log capture (/subagent-logs on|off|trace|full|status)",
		handler: async (args, ctx) => {
			const command = (args || "").trim().toLowerCase();
			if (!["on", "off", "trace", "full", "status"].includes(command)) {
				ctx.ui.notify("Usage: /subagent-logs on, /subagent-logs off, /subagent-logs trace, /subagent-logs full, /subagent-logs status", "warning");
				return;
			}
			if (command === "status") {
				ctx.ui.notify(describeSubagentLogsStatus(ctx.cwd), "info");
				return;
			}
			if (command === "on") {
				const enabled = enableSubagentLogsForSession(pi, ctx.cwd);
				ctx.ui.notify(
					enabled.source === "config"
						? `Subagent logs enabled with config default: ${enabled.effective.toUpperCase()}`
						: `Subagent logs enabled for this session: ${enabled.effective.toUpperCase()}`,
					"info",
				);
				return;
			}
			persistSubagentLogsMode(pi, command as SubagentLogMode);
			ctx.ui.notify(`Subagent logs set to ${command.toUpperCase()} for this session.`, "info");
		},
	});

	pi.registerCommand("commits", {
		description: "Commit current project changes in /orch mode. Use /commits model to pick the commit-message model.",
		handler: async (args, ctx) => {
			if (!isTopLevelOrchestrationModeEnabled(modeState.mode)) {
				ctx.ui.notify("/commits is available only when /orch mode is enabled.", "warning");
				return;
			}

			const command = (args || "").trim();
			const lower = command.toLowerCase();
			if (!["", "model", "model reset"].includes(lower)) {
				ctx.ui.notify("Usage: /commits, /commits model, /commits model reset", "warning");
				return;
			}

			if (lower === "model reset") {
				persistCommitsModel(pi, undefined);
				const autoModel = pickDefaultCommitsModel(ctx);
				ctx.ui.notify(autoModel ? `Reset /commits model. Using auto selection: ${formatModelSpec(autoModel)}` : "Reset /commits model. Auto selection will be used.", "info");
				return;
			}

			if (lower === "model") {
				if (!ctx.hasUI) {
					ctx.ui.notify("/commits model requires interactive UI.", "error");
					return;
				}
				const available = ctx.modelRegistry.getAvailable().filter((model: any) => model.input?.includes("text"));
				if (available.length === 0) {
					ctx.ui.notify("No available models found for /commits.", "error");
					return;
				}
				const autoModel = pickDefaultCommitsModel(ctx);
				const sorted = [...available].sort((a, b) => {
					const [tierA, costA, labelA] = rankCommitModel(a);
					const [tierB, costB, labelB] = rankCommitModel(b);
					return tierA - tierB || costA - costB || labelA.localeCompare(labelB);
				});
				const optionMap = new Map<string, string | undefined>();
				const autoLabel = autoModel
					? `Auto (recommended): ${formatModelSpec(autoModel)}${commitsModelSpec ? "" : " [current]"}`
					: `Auto (recommended)${commitsModelSpec ? "" : " [current]"}`;
				optionMap.set(autoLabel, undefined);
				for (const model of sorted) {
					const spec = formatModelSpec(model);
					const label = `${spec}${commitsModelSpec === spec ? " [current]" : ""} — ${model.name}`;
					optionMap.set(label, spec);
				}
				const selected = await ctx.ui.select("Choose the model /commits should use", Array.from(optionMap.keys()));
				if (!selected) return;
				const spec = optionMap.get(selected);
				persistCommitsModel(pi, spec);
				ctx.ui.notify(spec ? `Set /commits model to ${spec}` : autoModel ? `Reset /commits model. Using auto selection: ${formatModelSpec(autoModel)}` : "Reset /commits model. Auto selection will be used.", "info");
				return;
			}

			await ctx.waitForIdle();
			const projectRoot = findProjectRoot(ctx.cwd);
			const repoRootResult = await pi.exec("git", ["-C", projectRoot, "rev-parse", "--show-toplevel"]);
			if (repoRootResult.code !== 0) {
				ctx.ui.notify("/commits requires a git repository.", "error");
				return;
			}
			const repoRoot = repoRootResult.stdout.trim();
			const scopePath = path.relative(repoRoot, projectRoot) || ".";
			const scopeArgs = ["--", scopePath];
			const isWithinScope = (filePath: string) => scopePath === "." || filePath === scopePath || filePath.startsWith(`${scopePath}/`);
			if (scopePath !== ".") {
				const stagedRepoWide = await pi.exec("git", ["-C", repoRoot, "diff", "--cached", "--name-only"]);
				const stagedOutsideScope = stagedRepoWide.stdout
					.split("\n")
					.map((line) => line.trim())
					.filter(Boolean)
					.filter((filePath) => !isWithinScope(filePath));
				if (stagedOutsideScope.length > 0) {
					ctx.ui.notify(`Refusing to commit because staged changes exist outside this project: ${stagedOutsideScope.slice(0, 4).join(", ")}`, "warning");
					return;
				}
			}

			const [statusResult, stagedStatResult, unstagedStatResult, stagedDiffResult, unstagedDiffResult, untrackedResult] = await Promise.all([
				pi.exec("git", ["-C", repoRoot, "status", "--porcelain", ...scopeArgs]),
				pi.exec("git", ["-C", repoRoot, "diff", "--cached", "--stat", ...scopeArgs]),
				pi.exec("git", ["-C", repoRoot, "diff", "--stat", ...scopeArgs]),
				pi.exec("git", ["-C", repoRoot, "diff", "--cached", "--unified=0", "--no-ext-diff", "--no-color", ...scopeArgs]),
				pi.exec("git", ["-C", repoRoot, "diff", "--unified=0", "--no-ext-diff", "--no-color", ...scopeArgs]),
				pi.exec("git", ["-C", repoRoot, "ls-files", "--others", "--exclude-standard", ...scopeArgs]),
			]);

			const status = statusResult.stdout.trim();
			if (!status) {
				ctx.ui.notify("No project changes to commit.", "info");
				return;
			}
			const changedFiles = parseChangedPathsFromStatus(statusResult.stdout);
			const assistantContext = summarizeText(getLastAssistantText(ctx) || "", 12);
			const { model: commitModel, source } = resolveCommitsModel(ctx);
			if (commitsModelSpec && source === "auto") {
				ctx.ui.notify(`Saved /commits model unavailable, falling back to auto selection${commitModel ? ` (${formatModelSpec(commitModel)})` : ""}.`, "warning");
			}

			const promptText = [
				"Generate one git commit message for these project changes.",
				`Project root: ${projectRoot}`,
				`Git repo root: ${repoRoot}`,
				truncatePromptSection("Recent assistant context", assistantContext, 3000),
				truncatePromptSection("Git status", statusResult.stdout, 4000),
				truncatePromptSection("Staged diff stat", stagedStatResult.stdout, 2500),
				truncatePromptSection("Unstaged diff stat", unstagedStatResult.stdout, 2500),
				truncatePromptSection("Untracked files", untrackedResult.stdout, 2000),
				truncatePromptSection("Staged diff excerpt", stagedDiffResult.stdout, 10000),
				truncatePromptSection("Unstaged diff excerpt", unstagedDiffResult.stdout, 10000),
			].join("\n\n");

			let draftMessage = fallbackCommitMessage(changedFiles);
			if (commitModel) {
				const generated = await generateCommitMessageDraft(ctx, commitModel, promptText);
				if (generated === null) {
					ctx.ui.notify("Commit cancelled.", "info");
					return;
				}
				if (generated.trim()) draftMessage = generated.trim();
			} else {
				ctx.ui.notify("No configured model available for /commits, using a fallback draft message.", "warning");
			}

			let finalMessage = draftMessage;
			if (ctx.hasUI) {
				const edited = await ctx.ui.editor("Edit commit message", draftMessage);
				if (edited === undefined) {
					ctx.ui.notify("Commit cancelled.", "info");
					return;
				}
				finalMessage = normalizeCommitMessage(edited);
			}
			if (!finalMessage) {
				ctx.ui.notify("Commit message cannot be empty.", "error");
				return;
			}

			if (ctx.hasUI) {
				const confirm = await ctx.ui.confirm(
					"Create git commit?",
					`This will stage and commit ${changedFiles.length} changed file${changedFiles.length === 1 ? "" : "s"} for ${scopePath === "." ? path.basename(projectRoot) || projectRoot : scopePath}.\n\n${finalMessage}`,
				);
				if (!confirm) {
					ctx.ui.notify("Commit cancelled.", "info");
					return;
				}
			}

			const addResult = await pi.exec("git", ["-C", repoRoot, "add", "-A", ...scopeArgs]);
			if (addResult.code !== 0) {
				ctx.ui.notify(addResult.stderr.trim() || "Failed to stage project changes.", "error");
				return;
			}
			const commitResult = await pi.exec("git", ["-C", repoRoot, "commit", "-m", finalMessage]);
			if (commitResult.code !== 0) {
				ctx.ui.notify(commitResult.stderr.trim() || commitResult.stdout.trim() || "git commit failed.", "error");
				return;
			}
			ctx.ui.notify(`Committed project changes: ${finalMessage}`, "info");
		},
	});


	const shouldRegisterDocsLookup = !runtimeRole || runtimeRole === "scout";
	if (shouldRegisterDocsLookup) {
		pi.registerTool({
			name: DOCS_LOOKUP_TOOL_NAME,
			label: "Docs Lookup",
			description: "Fetch a documentation URL or search documentation results. Returns structured output and degrades gracefully when lookup is unavailable.",
			promptSnippet: "Use this tool to validate framework or library guidance against current documentation.",
			promptGuidelines: ["Use this tool when a framework or library behavior needs fresh documentation validation."],
			parameters: DocsLookupParams,
			async execute(_toolCallId, params) {
				if (!runtimeRole && !isTopLevelSmalldoenModeEnabled(modeState.mode)) {
					throw new Error("docs_lookup is available only when a smalldoen top-level mode is enabled or to the scout child role.");
				}
				if (!params.url && !params.query) throw new Error("Provide either url or query.");
				const result = params.url ? await fetchUrl(params.url) : await searchDocs(params.query!);
				return { content: [{ type: "text", text: buildDocsContext(result) }], details: result };
			},
			renderCall(args, theme) {
				return new Text(`${theme.fg("toolTitle", theme.bold("Looking up "))}${theme.fg("accent", "[DOCS_LOOKUP]")} ${theme.fg("toolOutput", args.url ?? args.query ?? "")}`, 0, 0);
			},
			renderResult(result, { expanded }, _theme) {
				const text = result.content[0]?.type === "text" ? result.content[0].text : "(no output)";
				if (!expanded) return new Text(text.split("\n").slice(0, 4).join("\n"), 0, 0);
				return new Markdown(text, 0, 0, getMarkdownTheme());
			},
		});
	}

	if (!runtimeRole) {
		pi.registerTool({
			name: SAVE_PLAN_IDEA_TOOL_NAME,
			label: "Save Spec Idea",
			description: "Write a brainstormed SPEC_IDEA to .pi/smalldoen/ideas/. Use this only after the user explicitly says the brainstorm is done or asks you to save the idea.",
			promptSnippet: "Save the finalized brainstorm as a SPEC_IDEA artifact.",
			promptGuidelines: [
				"Use this only in brainstorm mode.",
				"Use it only after the user explicitly says the brainstorm is done or explicitly asks to write or save the spec idea.",
				"Write the artifact as a collaborative build brief, not a second-person recap.",
				"Include concrete design sections when they are known: recommendation, alternatives, architecture, components, data flow, error handling, testing, scope, and success criteria.",
			],
			parameters: SavePlanIdeaParams,
			async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
				if (modeState.mode !== "brainstorm") throw new Error("save_plan_idea is available only when /orch brainstorm mode is enabled.");
				const createdAt = new Date().toISOString();
				const target = await resolvePlanIdeaPath(ctx.cwd, params.title, params.slug);
				const markdown = renderPlanIdeaMarkdown({
					title: params.title.trim(),
					slug: target.slug,
					createdAt,
					summary: params.summary.trim(),
					problem: params.problem?.trim() || undefined,
					users: params.users?.map((value) => value.trim()).filter(Boolean),
					goals: params.goals?.map((value) => value.trim()).filter(Boolean),
					nonGoals: params.nonGoals?.map((value) => value.trim()).filter(Boolean),
					recommendedApproach: params.recommendedApproach?.trim() || undefined,
					alternatives: params.alternatives?.map((value) => value.trim()).filter(Boolean),
					architecture: params.architecture?.map((value) => value.trim()).filter(Boolean),
					components: params.components?.map((value) => value.trim()).filter(Boolean),
					coreFlows: params.coreFlows?.map((value) => value.trim()).filter(Boolean),
					dataFlow: params.dataFlow?.map((value) => value.trim()).filter(Boolean),
					errorHandling: params.errorHandling?.map((value) => value.trim()).filter(Boolean),
					testing: params.testing?.map((value) => value.trim()).filter(Boolean),
					scope: params.scope?.map((value) => value.trim()).filter(Boolean),
					successCriteria: params.successCriteria?.map((value) => value.trim()).filter(Boolean),
					risks: params.risks?.map((value) => value.trim()).filter(Boolean),
					openQuestions: params.openQuestions?.map((value) => value.trim()).filter(Boolean),
					followUpSlices: params.followUpSlices?.map((value) => value.trim()).filter(Boolean),
				});
				await writeReport(target.filePath, markdown);
				const details: PlanIdeaDetails = {
					title: params.title.trim(),
					slug: target.slug,
					path: target.filePath,
					createdAt,
				};
				return {
					content: [{ type: "text", text: [`Spec idea saved`, `Title: ${details.title}`, `Path: ${relativePath(ctx.cwd, details.path) ?? details.path}`].join("\n") }],
					details,
				};
			},
			renderCall(args, theme) {
				return new Text(`${theme.fg("toolTitle", theme.bold("Saving "))}${theme.fg("accent", "[SPEC_IDEA]")} ${theme.fg("toolOutput", args.title ?? "idea")}`, 0, 0);
			},
			renderResult(result, _options, theme) {
				const details = result.details as PlanIdeaDetails | undefined;
				if (!details) return new Text(result.content[0]?.type === "text" ? result.content[0].text : "(no output)", 0, 0);
				return new Text([
					theme.fg("success", "✓"),
					theme.fg("toolOutput", details.title),
					theme.fg("dim", details.path),
				].join("  "), 0, 0);
			},
		});

		pi.registerTool({
			name: MANAGE_RUN_TOOL_NAME,
			label: "Manage Run",
			description: "Create or update the live orchestration run artifact. Use this to start runs, change stages, track package progress, store review outcomes, and finish runs.",
			promptSnippet: "Create and update the live orchestration run state while you manage the workflow.",
			promptGuidelines: [
				"Use this tool before and during orchestration so the visible run status stays current.",
				"Start a run before delegating work, update stage changes, and mark packages as running or completed as work progresses.",
			],
			parameters: ManageRunParams,
			async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
				if (!isTopLevelOrchestrationModeEnabled(modeState.mode)) throw new Error("manage_run is available only when /orch mode is enabled.");
				await ensureOrchestrationRuntime(ctx.cwd);

				if (params.action === "start") {
					if (!params.feature?.trim() || !params.objective?.trim()) throw new Error("manage_run start requires feature and objective.");
					if (activeRunId) {
						const current = await loadRunManifest(ctx.cwd, activeRunId);
						if (current && current.status === "active") {
							await markRunStale(ctx.cwd, current, "Superseded by a new orchestration run.");
						}
					}
					let manifest = await createRunManifest(ctx.cwd, {
						feature: params.feature,
						featureSlug: slugifyFeatureName(params.feature),
						objective: params.objective,
						scoutUsed: false,
					});
					manifest = await appendRunEvent(ctx.cwd, manifest, "run_start", `Started orchestration run for ${params.feature}`);
					setActiveRun(manifest);
					applyRunVisualization(ctx, manifest, modeState.mode);
					const details = buildManageRunDetails("start", manifest);
					return {
						content: [{ type: "text", text: `Run started\nRun ID: ${manifest.runId}\nFeature: ${manifest.feature}\nStage: ${manifest.stage}` }],
						details,
					};
				}

				let manifest = params.runId ? await loadRunManifestRequired(ctx.cwd, params.runId) : await loadLatestRunManifest(ctx.cwd);
				if (!manifest) throw new Error("No orchestration run found.");

				if (params.action === "status") {
					setActiveRun(manifest);
					applyRunVisualization(ctx, manifest, modeState.mode);
					return { content: [{ type: "text", text: formatManifestSummary(manifest) }], details: buildManageRunDetails("status", manifest) };
				}

				if (params.action === "stage") {
					if (!params.stage?.trim()) throw new Error("manage_run stage requires stage.");
					const planPath = resolveOptionalUserPath(ctx.cwd, params.planPath) ?? manifest.planPath;
					let nextManifest = await updateRunManifest(ctx.cwd, manifest, { stage: params.stage.trim(), planPath });
					if (planPath && planPath !== manifest.planPath) {
						const plan = await loadParsedPlan(planPath);
						replacePackageStates(nextManifest, buildPackageStates(plan));
						nextManifest = await updateRunManifest(ctx.cwd, nextManifest, { packages: nextManifest.packages, planPath: planPath, stage: params.stage.trim() });
					}
					if (params.note?.trim()) nextManifest = await appendRunEvent(ctx.cwd, nextManifest, "stage_change", params.note.trim(), { stage: params.stage.trim(), planPath });
					setActiveRun(nextManifest);
					applyRunVisualization(ctx, nextManifest, modeState.mode);
					return { content: [{ type: "text", text: formatManifestSummary(nextManifest) }], details: buildManageRunDetails("stage", nextManifest) };
				}

				if (params.action === "package") {
					if (!params.packageId?.trim() || !params.packageStatus) throw new Error("manage_run package requires packageId and packageStatus.");
					upsertPackageState(manifest, {
						packageId: params.packageId.trim(),
						status: params.packageStatus,
						note: params.note?.trim(),
						changedFiles: params.changedFiles,
					});
					let nextManifest = await updateRunManifest(ctx.cwd, manifest, { packages: manifest.packages });
					nextManifest = await appendRunEvent(ctx.cwd, nextManifest, "package_update", `${params.packageId.trim()} -> ${params.packageStatus}`, {
						packageId: params.packageId.trim(),
						status: params.packageStatus,
						changedFiles: params.changedFiles,
					});
					setActiveRun(nextManifest);
					applyRunVisualization(ctx, nextManifest, modeState.mode);
					return {
						content: [{ type: "text", text: formatManifestSummary(nextManifest) }],
						details: buildManageRunDetails("package", nextManifest, { packageId: params.packageId.trim() }),
					};
				}

				if (params.action === "review") {
					if (!params.verdict) throw new Error("manage_run review requires verdict.");
					const reportPath = resolveOptionalUserPath(ctx.cwd, params.reportPath);
					let nextManifest = await updateRunManifest(ctx.cwd, manifest, {
						review: {
							verdict: params.verdict,
							routingHint: params.routingHint ?? "none",
							needRescout: params.needRescout ?? false,
							summary: params.note?.trim() || manifest.review?.summary || "",
							reportPath,
						},
						stage: "review",
					});
					nextManifest = await appendRunEvent(ctx.cwd, nextManifest, "review_update", `Review verdict: ${params.verdict}`, {
						verdict: params.verdict,
						routingHint: params.routingHint ?? "none",
						needRescout: params.needRescout ?? false,
						reportPath,
					});
					setActiveRun(nextManifest);
					applyRunVisualization(ctx, nextManifest, modeState.mode);
					return { content: [{ type: "text", text: formatManifestSummary(nextManifest) }], details: buildManageRunDetails("review", nextManifest) };
				}

				if (params.action === "finish") {
					const finalStatus = params.finalStatus ?? "completed";
					let nextManifest = manifest;
					if (finalStatus === "stale") nextManifest = await markRunStale(ctx.cwd, manifest, params.note?.trim() || "Marked stale.");
					else nextManifest = await markRunFinished(ctx.cwd, manifest, finalStatus);
					nextManifest = await appendRunEvent(ctx.cwd, nextManifest, "run_end", params.note?.trim() || `Run finished with status ${finalStatus}.`);
					if (finalStatus === "completed") {
						runSummaryCwd = ctx.cwd;
						const summaryPath = getRunSummaryPath(ctx.cwd, nextManifest.runId);
						await writeReport(summaryPath, buildRunSummary(nextManifest, params.note?.trim()));
						nextManifest = await updateRunManifest(ctx.cwd, nextManifest, { summaryPath });
					}
					setActiveRun(nextManifest.status === "active" ? nextManifest : undefined);
					applyRunVisualization(ctx, nextManifest, modeState.mode);
					return { content: [{ type: "text", text: formatManifestSummary(nextManifest) }], details: buildManageRunDetails("finish", nextManifest) };
				}

				throw new Error(`Unsupported manage_run action: ${params.action}`);
			},
			renderCall(args, theme) {
				const detail = args.stage ?? args.packageId ?? args.feature ?? "run";
				const runId = args.runId ? ` ${args.runId}` : "";
				return new Text(`${theme.fg("toolTitle", theme.bold("Executing "))}${theme.fg("accent", "[MANAGE_RUN]")} ${theme.fg("muted", args.action)} ${theme.fg("toolOutput", detail)}${theme.fg("dim", runId)}`, 0, 0);
			},
			renderResult(result, { expanded }, theme) {
				const details = result.details as ManageRunDetails | undefined;
				if (!details) return new Text(result.content[0]?.type === "text" ? result.content[0].text : "(no output)", 0, 0);
				return renderManageRunResult(details, expanded, theme);
			},
		});

		pi.registerTool({
			name: INSPECT_PLAN_TOOL_NAME,
			label: "Inspect Plan",
			description: "Load a planner-generated plan file, parse its work packages, and return structured package and scheduling metadata. This does not execute anything.",
			promptSnippet: "Inspect a planner-generated plan file and return packages plus safe parallel groups.",
			promptGuidelines: [
				"Use this after planner finishes so you can decide which packages to run next.",
				"Only launch parallel worker delegates after you inspect the plan and intentionally choose a safe group.",
			],
			parameters: InspectPlanParams,
			async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
				if (!isTopLevelOrchestrationModeEnabled(modeState.mode)) throw new Error("inspect_plan is available only when /orch mode is enabled.");
				await ensureOrchestrationRuntime(ctx.cwd);
				const explicitPlanPath = resolveOptionalUserPath(ctx.cwd, params.planPath);
				let planPath = explicitPlanPath;
				if (!planPath) {
					if (!params.feature?.trim()) throw new Error("inspect_plan requires either planPath or feature.");
					planPath = await getLatestPlanPath(ctx.cwd, slugifyFeatureName(params.feature));
					if (!planPath) throw new Error(`No plan found for feature: ${params.feature}`);
				}
				const plan = await loadParsedPlan(planPath);
				const details = buildPlanInspectionDetails(plan, params.packageIds);
				return {
					content: [{ type: "text", text: [
						`Plan path: ${details.planPath}`,
						`Feature slug: ${details.featureSlug}`,
						`Parallel allowed: ${details.parallelAllowed ? "yes" : "no"}`,
						`Groups: ${details.groups.length}`,
						`Packages: ${details.packageCount}`,
						...details.groups.map((group) => `- Group ${group.index}: ${group.packageIds.join(", ")}`),
					].join("\n") }],
					details,
				};
			},
			renderCall(args, theme) {
				const label = args.planPath ? path.basename(args.planPath) : args.feature || "latest-plan";
				return new Text(`${theme.fg("toolTitle", theme.bold("Inspecting "))}${theme.fg("accent", "[INSPECT_PLAN]")} ${theme.fg("toolOutput", label)}`, 0, 0);
			},
			renderResult(result, { expanded }, theme) {
				const details = result.details as PlanInspectionDetails | undefined;
				if (!details) return new Text(result.content[0]?.type === "text" ? result.content[0].text : "(no output)", 0, 0);
				return renderInspectPlanResult(details, expanded, theme);
			},
		});

		pi.registerTool({
			name: DELEGATE_TOOL_NAME,
			label: "Delegate",
			description: "Run a specialized child role in an isolated pi subprocess. Roles: scout, planner, engineer, designer, reviewer. Planner requires feature so the runtime can version the plan path.",
			promptSnippet: "Delegate isolated work to scout, planner, engineer, designer, or reviewer.",
			promptGuidelines: [
				"Use this instead of implementing directly when orchestration mode is enabled.",
				"Use planner before any engineer or designer work.",
				"Pass runId and label so live run status stays visible while subagents work.",
			],
			parameters: DelegateParams,
			async execute(_toolCallId, params, signal, onUpdate, ctx) {
				if (!isTopLevelOrchestrationModeEnabled(modeState.mode)) throw new Error("delegate is available only when /orch mode is enabled.");
				await ensureOrchestrationRuntime(ctx.cwd);

				const configuredRoleModel = getConfiguredModelSpec(ctx.cwd, params.role as WorkerRole);
				const subagentLogMode = getEffectiveSubagentLogsMode(ctx.cwd);
				onUpdate?.({
					content: [{ type: "text", text: "(running...)" }],
					details: {
						role: params.role as WorkerRole,
						status: "running",
						runId: params.runId,
						label: params.label?.trim() || params.packageId?.trim() || params.role,
						packageId: params.packageId?.trim() || undefined,
						exitCode: 0,
						finalOutput: "",
						model: configuredRoleModel,
					},
				});
				let manifest = params.runId ? await loadRunManifest(ctx.cwd, params.runId) : undefined;
				if (manifest) {
					upsertSubagentState(manifest, {
						role: params.role as WorkerRole,
						label: params.label?.trim() || params.packageId?.trim() || params.role,
						status: "running",
						packageId: params.packageId?.trim() || undefined,
					});
					manifest = await updateRunManifest(ctx.cwd, manifest, {
						scoutUsed: manifest.scoutUsed || params.role === "scout",
						subagents: manifest.subagents,
					});
					manifest = await appendRunEvent(ctx.cwd, manifest, "delegate_start", `Delegated ${params.label?.trim() || params.role} to ${params.role}.`, {
						role: params.role,
						label: params.label,
						packageId: params.packageId,
					});
					setActiveRun(manifest);
					applyRunVisualization(ctx, manifest, modeState.mode);
				}

				try {
					const result = await runDelegatedRole({
						cwd: ctx.cwd,
						role: params.role as WorkerRole,
						task: params.task,
						feature: params.feature,
						runId: params.runId,
						label: params.label,
						packageId: params.packageId,
						signal,
						logMode: subagentLogMode,
						onUpdate: (details) => {
							onUpdate?.({ content: [{ type: "text", text: details.finalOutput || `(${details.role} running...)` }], details });
						},
					});

					const details: DelegateToolDetails = {
						...result.details,
						label: params.label?.trim() || result.details.label,
						packageId: params.packageId?.trim() || result.details.packageId,
						runId: params.runId,
						model: result.details.model || configuredRoleModel,
					};
					if (details.role === "engineer" || details.role === "designer") details.changedFiles = parseChangedFiles(details.finalOutput);
					if (details.role === "reviewer") details.review = buildReviewSummary(details.finalOutput);
					if (details.role === "scout" && params.runId) details.reportPath = getScoutReportPath(ctx.cwd, params.runId);
					if (details.role === "reviewer" && params.runId) details.reportPath = getReviewReportPath(ctx.cwd, params.runId);
					if (details.reportPath) await writeReport(details.reportPath, details.finalOutput || "");

					if (manifest) {
						upsertSubagentState(manifest, {
							role: details.role,
							label: details.label || details.role,
							status: "completed",
							packageId: details.packageId,
							model: details.model || configuredRoleModel,
							summary: summarizeText(details.finalOutput || "", 2),
							traceLogPath: details.traceLogPath,
							rawLogPath: details.rawLogPath,
							stderrLogPath: details.stderrLogPath,
						});
						manifest = await updateRunManifest(ctx.cwd, manifest, { subagents: manifest.subagents, scoutUsed: manifest.scoutUsed || details.role === "scout" });
						manifest = await appendRunEvent(ctx.cwd, manifest, "delegate_complete", `${details.label || details.role} completed.`, {
							role: details.role,
							label: details.label,
							packageId: details.packageId,
							reportPath: details.reportPath,
						});
						setActiveRun(manifest);
						applyRunVisualization(ctx, manifest, modeState.mode);
					}

					return {
						content: [{ type: "text", text: [
							`Role: ${details.role}`,
							details.label ? `Label: ${details.label}` : undefined,
							details.runId ? `Run: ${details.runId}` : undefined,
							details.packageId ? `Package: ${details.packageId}` : undefined,
							details.planPath ? `Plan: ${details.planPath}` : undefined,
							details.reportPath ? `Report: ${details.reportPath}` : undefined,
							...formatDelegateLogMeta(details, ctx.cwd),
							details.changedFiles && details.changedFiles.length > 0 ? `Changed Files: ${details.changedFiles.join(", ")}` : undefined,
							details.review ? `Review Verdict: ${details.review.verdict} / ${details.review.routingHint}` : undefined,
							details.finalOutput || "(no output)",
						].filter(Boolean).join("\n\n") }],
						details,
					};
				} catch (error) {
					const errorDetails = error && typeof error === "object" ? (error as { details?: DelegateToolDetails }).details : undefined;
					if (manifest) {
						upsertSubagentState(manifest, {
							role: params.role as WorkerRole,
							label: params.label?.trim() || params.packageId?.trim() || params.role,
							status: "failed",
							packageId: params.packageId?.trim() || undefined,
							summary: error instanceof Error ? error.message : String(error),
							traceLogPath: errorDetails?.traceLogPath,
							rawLogPath: errorDetails?.rawLogPath,
							stderrLogPath: errorDetails?.stderrLogPath,
						});
						manifest = await updateRunManifest(ctx.cwd, manifest, { subagents: manifest.subagents, scoutUsed: manifest.scoutUsed || params.role === "scout" });
						manifest = await appendRunEvent(ctx.cwd, manifest, "delegate_error", `${params.label?.trim() || params.role} failed.`, {
							role: params.role,
							label: params.label,
							packageId: params.packageId,
							error: error instanceof Error ? error.message : String(error),
						});
						setActiveRun(manifest);
						applyRunVisualization(ctx, manifest, modeState.mode);
					}
					throw error;
				}
			},
			renderCall(args, theme) {
				const label = args.label || args.packageId || args.role;
				return new Text(`${theme.fg("toolTitle", theme.bold("Running "))}${theme.fg("accent", "[DELEGATE]")} ${theme.fg("toolOutput", label)}${theme.fg("dim", ` → ${args.role}`)}`, 0, 0);
			},
			renderResult(result, options, theme) {
				const details = result.details as DelegateToolDetails | undefined;
				if (!details) return new Text(result.content[0]?.type === "text" ? result.content[0].text : "(no output)", 0, 0);
				return renderDelegateResult(details, options.expanded, options.isPartial, theme);
			},
		});
	}

	pi.on("before_agent_start", async (event, ctx) => {
		if (!isTopLevelSmalldoenModeEnabled(modeState.mode)) return;
		const orchestratorPrompt = await buildOrchestratorPrompt(ctx.cwd, modeState.mode);
		if (modeState.mode !== "orchestrate") {
			return {
				systemPrompt: `${event.systemPrompt}\n\n${orchestratorPrompt}`,
			};
		}
		const orchestratorMemory = await buildRoleMemoryContext("orchestrator", ctx.cwd);
		const hookContent = await buildAgentHookContent(ctx.cwd);
		return {
			systemPrompt: `${event.systemPrompt}\n\n${orchestratorPrompt}${orchestratorMemory ? `\n\n${orchestratorMemory}` : ""}${hookContent ? `\n\nProject-local hook:\n${hookContent}` : ""}`,
		};
	});

	pi.on("tool_call", async (event, ctx) => {
		const role = resolveEffectiveRole();
		if (!role) return;
		if (event.toolName === "write" || event.toolName === "edit") {
			const inputPath = (event.input as { path?: string } | undefined)?.path;
			if (!inputPath) return;
			if (role === "orchestrator") return { block: true, reason: "Orchestrator is read-only in smalldoen top-level modes." };
			if (role === "planner" && !assertPlannerPathAllowed(ctx.cwd, inputPath)) return { block: true, reason: "Planner may only write under .pi/smalldoen/plans/." };
			if ((role === "scout" || role === "reviewer") && !assertArtifactPathAllowed(role, ctx.cwd, inputPath)) {
				return { block: true, reason: `${role} may only write project artifacts under .pi/smalldoen/reports/ or .pi/smalldoen/memory/${role}/.` };
			}
		}
		if (event.toolName === "bash") {
			const command = (event.input as { command?: string } | undefined)?.command ?? "";
			if ((role === "orchestrator" || role === "scout" || role === "reviewer") && !isReadOnlyBashCommand(command)) {
				return { block: true, reason: `${role} may only run read-only bash commands.` };
			}
		}
	});
}
