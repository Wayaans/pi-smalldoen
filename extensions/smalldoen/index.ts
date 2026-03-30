import * as fs from "node:fs/promises";
import * as path from "node:path";
import { StringEnum } from "@mariozechner/pi-ai";
import { getMarkdownTheme, type ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { getAgentConfig } from "./agents";
import { getConfiguredModelSpec } from "./config";
import { buildDocsContext, fetchUrl, searchDocs } from "./docs";
import { runDelegatedRole, workerRoles, type WorkerRole } from "./delegate";
import {
	assertArtifactPathAllowed,
	assertPlannerPathAllowed,
	getRuntimeRole,
	isReadOnlyBashCommand,
	isTopLevelOrchestrationModeEnabled,
} from "./guards";
import { buildRoleMemoryContext, recordRoleExecution } from "./memory";
import {
	applyModeIndicator,
	getOrchestrationMode,
	restoreOrchestrationMode,
	setOrchestrationMode,
	toggleOrchestrationMode,
} from "./mode";
import {
	getLatestPlanPath,
	loadParsedPlan,
	slugifyFeatureName,
	type ParsedPlan,
	type PlanPackage,
} from "./plan";
import {
	ensureRuntimeLayout,
	getReviewReportPath,
	getScoutReportPath,
} from "./paths";
import {
	buildReviewTask,
	collectChangedFiles,
	parseChangedFiles,
	parseReviewOutput,
	type ReviewVerdict,
} from "./reviewer";
import {
	appendRunEvent,
	createRunManifest,
	loadLatestRunManifest,
	markRunFinished,
	markRunStale,
	updateRunManifest,
	type RunManifest,
} from "./run-state";
import { schedulePackages } from "./scheduler";
import {
	DELEGATE_TOOL_NAME,
	type AgentRole,
	type DelegateToolDetails,
	type ExecutePlanDetails,
	type ExecutedPackageDetails,
	type OrchestrationModeState,
	type PlanFeatureDetails,
	type ReviewExecutionDetails,
	type RunFeatureDetails,
} from "./types";

const PLAN_FEATURE_TOOL_NAME = "plan_feature" as const;
const EXECUTE_PLAN_TOOL_NAME = "execute_plan" as const;
const DOCS_LOOKUP_TOOL_NAME = "docs_lookup" as const;
const RUN_FEATURE_TOOL_NAME = "run_feature" as const;
const modeState: OrchestrationModeState = { enabled: false };
const runtimeRole = getRuntimeRole();
const MAX_REVIEW_LOOPS = 3;

let activeRun: RunManifest | undefined;
let activeRunAbortController: AbortController | undefined;

const ORCHESTRATOR_RUNTIME_PROMPT = `
Orchestration mode is enabled for this session.

You are acting as the project orchestrator.

Hard rules:
- Do not use write or edit.
- Do not implement code directly.
- Require a planner-generated plan before any worker implementation.
- Skip scout only for tiny, local, or already-clear tasks.
- Use scout for broader analysis and documentation validation when needed.
- Use planner to create a detailed versioned plan.
- Prefer the run_feature tool for full end-to-end execution.
- Prefer the plan_feature tool to run the scout -> planner phase.
- Prefer the execute_plan tool to execute parsed work packages from a validated plan.
- Use delegate only for targeted manual child-role work.
- Use reviewer after worker execution.
- Use docs_lookup to validate framework or library guidance when needed.
`;

const DelegateParams = Type.Object({
	role: StringEnum(workerRoles, { description: "Specialized child role to run" }),
	task: Type.String({ description: "Task for the delegated role" }),
	feature: Type.Optional(
		Type.String({ description: "Feature name or feature slug. Required for planner so the runtime can version the plan." }),
	),
});

const PlanFeatureParams = Type.Object({
	feature: Type.String({ description: "Feature name or feature slug used for versioned plan generation." }),
	objective: Type.String({ description: "Implementation objective that the planner must turn into a versioned plan." }),
	scoutMode: Type.Optional(
		StringEnum(["auto", "run", "skip"] as const, {
			description: "Whether to run scout before planner. Use run for complex work, skip for tiny local work, auto for runtime heuristic.",
		}),
	),
	scoutTask: Type.Optional(Type.String({ description: "Optional custom scout instruction. If omitted, the runtime generates one from the objective." })),
});

const ExecutePlanParams = Type.Object({
	feature: Type.Optional(Type.String({ description: "Feature name or feature slug. Used to resolve the latest plan version when planPath is omitted." })),
	planPath: Type.Optional(Type.String({ description: "Optional explicit path to a plan file. If omitted, the runtime resolves the latest plan for the feature." })),
	packageIds: Type.Optional(Type.Array(Type.String({ description: "Optional subset of package ids to execute from the plan." }))),
});

const DocsLookupParams = Type.Object({
	query: Type.Optional(Type.String({ description: "Search query for framework or library documentation." })),
	url: Type.Optional(Type.String({ description: "Direct documentation URL to fetch." })),
});

const RunFeatureParams = Type.Object({
	feature: Type.String({ description: "Feature name or feature slug." }),
	objective: Type.String({ description: "End-to-end objective for planning, execution, and review." }),
	scoutMode: Type.Optional(
		StringEnum(["auto", "run", "skip"] as const, {
			description: "Whether to run scout before planner. Use run for complex work, skip for tiny local work, auto for runtime heuristic.",
		}),
	),
	maxReviewLoops: Type.Optional(Type.Number({ description: "Maximum review/repair loops. Defaults to 3.", minimum: 1, maximum: 3 })),
});

function resolveEffectiveRole(): AgentRole | undefined {
	if (runtimeRole) return runtimeRole;
	return isTopLevelOrchestrationModeEnabled(modeState.enabled) ? "orchestrator" : undefined;
}

function describeMode(enabled: boolean): string {
	return enabled ? "Orchestration mode is ON" : "Orchestration mode is OFF";
}

function resolveOptionalUserPath(cwd: string, input?: string): string | undefined {
	if (!input) return undefined;
	const normalized = input.startsWith("@") ? input.slice(1) : input;
	return path.resolve(cwd, normalized);
}

function syncTopLevelTools(pi: ExtensionAPI): void {
	if (runtimeRole) return;
	const activeTools = new Set(pi.getActiveTools());
	for (const toolName of [DELEGATE_TOOL_NAME, PLAN_FEATURE_TOOL_NAME, EXECUTE_PLAN_TOOL_NAME, DOCS_LOOKUP_TOOL_NAME, RUN_FEATURE_TOOL_NAME]) {
		if (modeState.enabled) activeTools.add(toolName);
		else activeTools.delete(toolName);
	}
	pi.setActiveTools(Array.from(activeTools));
}

function shouldRunScout(objective: string, scoutMode: "auto" | "run" | "skip"): boolean {
	if (scoutMode === "run") return true;
	if (scoutMode === "skip") return false;

	const normalized = objective.toLowerCase();
	const heuristicTerms = [
		"refactor",
		"architecture",
		"migrate",
		"framework",
		"integration",
		"security",
		"unknown",
		"explore",
		"analyze",
		"research",
		"multiple files",
		"parallel",
		"docs",
	];
	return objective.length > 140 || heuristicTerms.some((term) => normalized.includes(term));
}

function buildDefaultScoutTask(feature: string, objective: string): string {
	return [
		`Analyze the project codebase for feature: ${feature}`,
		`Objective: ${objective}`,
		"Validate relevant framework or library guidance against current documentation when possible.",
		"Return compressed findings for the planner, including likely files to change, affected files, risks, and implementation boundaries.",
	].join("\n");
}

function buildWorkerTask(plan: ParsedPlan, pkg: PlanPackage): string {
	return [
		`Execute work package ${pkg.packageId} from the validated plan.`,
		`Plan path: ${plan.path}`,
		`Feature slug: ${plan.frontmatter.feature_slug}`,
		`Plan version: ${plan.frontmatter.plan_version}`,
		`Owner: ${pkg.owner}`,
		`Goal: ${pkg.goal}`,
		`Files To Change: ${pkg.filesToChange.length > 0 ? pkg.filesToChange.join(", ") : "none"}`,
		`Affected Files: ${pkg.affectedFiles.length > 0 ? pkg.affectedFiles.join(", ") : "none"}`,
		`Depends On: ${pkg.dependsOn.length > 0 ? pkg.dependsOn.join(", ") : "none"}`,
		`Acceptance Checks: ${pkg.acceptanceChecks.length > 0 ? pkg.acceptanceChecks.join("; ") : "none"}`,
		"Read the plan file and only the local files needed for this package.",
		"Implement only this package. Do not perform broad repo analysis.",
	].join("\n");
}

function linkAbortSignals(parent: AbortSignal | undefined, child: AbortController): void {
	if (!parent) return;
	if (parent.aborted) child.abort();
	else parent.addEventListener("abort", () => child.abort(), { once: true });
}

function selectPackageIdsForRouting(plan: ParsedPlan, routingHint: ReviewVerdict["routingHint"]): string[] | undefined {
	if (routingHint === "none" || routingHint === "both") return undefined;
	const packageIds = plan.packages.filter((pkg) => pkg.owner === routingHint).map((pkg) => pkg.packageId);
	return packageIds.length > 0 ? packageIds : undefined;
}

function formatManifestSummary(manifest: RunManifest): string {
	const lines = [
		`Run ID: ${manifest.runId}`,
		`Status: ${manifest.status}`,
		`Stage: ${manifest.stage}`,
		`Feature: ${manifest.feature} (${manifest.featureSlug})`,
		`Objective: ${manifest.objective}`,
		`Plan: ${manifest.planPath ?? "(none)"}`,
		`Scout used: ${manifest.scoutUsed ? "yes" : "no"}`,
		`Review loops: ${manifest.reviewLoops}`,
		`Updated: ${manifest.updatedAt}`,
	];
	if (manifest.staleReason) lines.push(`Stale reason: ${manifest.staleReason}`);
	if (manifest.review) lines.push(`Review verdict: ${manifest.review.verdict}`);
	if (manifest.execution) lines.push(`Executed packages: ${manifest.execution.results.length}`);
	if (manifest.events.length > 0) {
		lines.push("", "Recent events:");
		for (const event of manifest.events.slice(-8)) {
			lines.push(`- [${event.timestamp}] ${event.type}: ${event.message}`);
		}
	}
	return lines.join("\n");
}

async function writeReport(filePath: string, content: string): Promise<void> {
	await fs.mkdir(path.dirname(filePath), { recursive: true });
	await fs.writeFile(filePath, content, "utf8");
}

async function markActiveRunAsStale(cwd: string, reason: string): Promise<void> {
	if (!activeRun) return;
	activeRun = await markRunStale(cwd, activeRun, reason);
}

function clearActiveRun(): void {
	activeRun = undefined;
	activeRunAbortController = undefined;
}

interface PlanStageResult {
	parsedPlan: ParsedPlan;
	details: PlanFeatureDetails;
}

async function runPlanFeatureStage(input: {
	cwd: string;
	feature: string;
	objective: string;
	scoutMode: "auto" | "run" | "skip";
	scoutTask?: string;
	signal?: AbortSignal;
	onUpdate?: (message: string, details?: unknown) => void;
	runId?: string;
}): Promise<PlanStageResult> {
	const scoutUsed = shouldRunScout(input.objective, input.scoutMode);
	let scoutSummary: string | undefined;

	if (scoutUsed) {
		const scoutResult = await runDelegatedRole({
			cwd: input.cwd,
			role: "scout",
			task: input.scoutTask?.trim() || buildDefaultScoutTask(input.feature, input.objective),
			signal: input.signal,
			onUpdate: (details) => input.onUpdate?.(details.finalOutput || "(scout running...)", details),
		});
		scoutSummary = scoutResult.details.finalOutput;
		if (input.runId) {
			await writeReport(getScoutReportPath(input.cwd, input.runId), scoutSummary || "");
		}
	}

	const plannerTask = [
		`Create or version the implementation plan for feature: ${input.feature}`,
		`Objective: ${input.objective}`,
		scoutSummary ? `Scout findings:\n${scoutSummary}` : "Scout findings: skipped",
		"Produce a deterministic plan with explicit work packages and scheduling metadata.",
	].join("\n\n");

	const plannerResult = await runDelegatedRole({
		cwd: input.cwd,
		role: "planner",
		task: plannerTask,
		feature: input.feature,
		signal: input.signal,
		onUpdate: (details) => input.onUpdate?.(details.finalOutput || "(planner running...)", details),
	});

	if (!plannerResult.parsedPlan) throw new Error("Planner did not return parsed plan metadata.");

	const details: PlanFeatureDetails = {
		scoutUsed,
		featureSlug: plannerResult.parsedPlan.frontmatter.feature_slug || input.feature,
		planPath: plannerResult.parsedPlan.path,
		packageCount: plannerResult.parsedPlan.packages.length,
		parallelAllowed: plannerResult.parsedPlan.frontmatter.parallel_allowed,
		scoutSummary,
		plannerSummary: plannerResult.details.finalOutput,
	};
	return { parsedPlan: plannerResult.parsedPlan, details };
}

async function runExecutePlanStage(input: {
	cwd: string;
	planPath: string;
	packageIds?: string[];
	signal?: AbortSignal;
	onUpdate?: (message: string, details?: unknown) => void;
}): Promise<ExecutePlanDetails> {
	const plan = await loadParsedPlan(input.planPath);
	const groups = schedulePackages(plan, input.packageIds);
	const executedResults: ExecutedPackageDetails[] = [];

	const emit = (message: string) => {
		const details: ExecutePlanDetails = {
			featureSlug: plan.frontmatter.feature_slug,
			planPath: plan.path,
			groupCount: groups.length,
			packageCount: groups.reduce((count, group) => count + group.packages.length, 0),
			groups: groups.map((group) => ({ index: group.index, packageIds: group.packages.map((pkg) => pkg.packageId) })),
			results: [...executedResults],
		};
		input.onUpdate?.(message, details);
	};

	for (const group of groups) {
		emit(`Executing group ${group.index}/${groups.length}: ${group.packages.map((pkg) => pkg.packageId).join(", ")}`);
		const settled = await Promise.allSettled(
			group.packages.map((pkg) =>
				runDelegatedRole({
					cwd: input.cwd,
					role: pkg.owner as WorkerRole,
					task: buildWorkerTask(plan, pkg),
					signal: input.signal,
					onUpdate: (details) => emit(`${pkg.packageId} (${pkg.owner}) running` + (details.finalOutput ? `\n\n${details.finalOutput}` : "")),
				}),
			),
		);

		const errors: string[] = [];
		for (let index = 0; index < settled.length; index++) {
			const outcome = settled[index];
			const pkg = group.packages[index];
			if (outcome.status === "rejected") {
				errors.push(`${pkg.packageId}: ${outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason)}`);
				continue;
			}
			executedResults.push({
				packageId: pkg.packageId,
				owner: pkg.owner,
				goal: pkg.goal,
				filesToChange: pkg.filesToChange,
				affectedFiles: pkg.affectedFiles,
				changedFiles: parseChangedFiles(outcome.value.details.finalOutput),
				exitCode: outcome.value.details.exitCode,
				finalOutput: outcome.value.details.finalOutput,
				stderr: outcome.value.details.stderr,
				model: outcome.value.details.model,
			});
		}

		if (errors.length > 0) throw new Error(`Execution failed in group ${group.index}: ${errors.join(" | ")}`);
	}

	return {
		featureSlug: plan.frontmatter.feature_slug,
		planPath: plan.path,
		groupCount: groups.length,
		packageCount: groups.reduce((count, group) => count + group.packages.length, 0),
		groups: groups.map((group) => ({ index: group.index, packageIds: group.packages.map((pkg) => pkg.packageId) })),
		results: executedResults,
	};
}

async function runReviewStage(input: {
	cwd: string;
	runId: string;
	planPath: string;
	execution: ExecutePlanDetails;
	signal?: AbortSignal;
	onUpdate?: (message: string, details?: unknown) => void;
}): Promise<{ details: ReviewExecutionDetails; verdict: ReviewVerdict }> {
	const plan = await loadParsedPlan(input.planPath);
	const reviewTask = buildReviewTask({ runId: input.runId, plan, results: input.execution.results });
	const reviewerResult = await runDelegatedRole({
		cwd: input.cwd,
		role: "reviewer",
		task: reviewTask,
		signal: input.signal,
		onUpdate: (delegateDetails) => input.onUpdate?.(delegateDetails.finalOutput || "(reviewer running...)", delegateDetails),
	});
	const verdict = parseReviewOutput(reviewerResult.details.finalOutput);
	const reportPath = getReviewReportPath(input.cwd, input.runId);
	await writeReport(reportPath, reviewerResult.details.finalOutput || "");
	return {
		verdict,
		details: {
			runId: input.runId,
			featureSlug: plan.frontmatter.feature_slug,
			planPath: plan.path,
			reportPath,
			verdict: verdict.verdict,
			routingHint: verdict.routingHint,
			needRescout: verdict.needRescout,
			summary: verdict.summary,
			filesReviewed: verdict.filesReviewed,
			criticalIssueCount: verdict.criticalIssues.length,
			warningCount: verdict.warnings.length,
		},
	};
}

function renderDelegateResult(details: DelegateToolDetails, expanded: boolean, theme: any) {
	const icon = details.exitCode === 0 ? theme.fg("success", "✓") : theme.fg("error", "✗");
	const header = `${icon} ${theme.fg("toolTitle", theme.bold(details.role))}${details.planPath ? theme.fg("dim", `  ${details.planPath}`) : ""}`;
	if (!expanded) {
		const preview = details.finalOutput ? details.finalOutput.split("\n").slice(0, 3).join("\n") : "(no output)";
		return new Text(`${header}\n${theme.fg("toolOutput", preview)}`, 0, 0);
	}
	const container = new Container();
	container.addChild(new Text(header, 0, 0));
	if (details.featureSlug) container.addChild(new Text(theme.fg("dim", `feature: ${details.featureSlug}`), 0, 0));
	if (details.model) container.addChild(new Text(theme.fg("dim", `model: ${details.model}`), 0, 0));
	if (details.planPath) container.addChild(new Text(theme.fg("dim", `plan: ${details.planPath}`), 0, 0));
	if (details.stderr) container.addChild(new Text(theme.fg("warning", details.stderr.trim()), 0, 0));
	container.addChild(new Spacer(1));
	container.addChild(new Markdown(details.finalOutput || "(no output)", 0, 0, getMarkdownTheme()));
	return container;
}

function renderExecutePlanResult(details: ExecutePlanDetails, expanded: boolean, theme: any) {
	const header = `${theme.fg("success", "✓")} ${theme.fg("toolTitle", theme.bold("execute_plan"))}${theme.fg("dim", `  ${details.planPath}`)}`;
	if (!expanded) {
		return new Text(`${header}\n${theme.fg("dim", `groups:${details.groupCount} packages:${details.packageCount} completed:${details.results.length}`)}`, 0, 0);
	}
	const container = new Container();
	container.addChild(new Text(header, 0, 0));
	container.addChild(new Text(theme.fg("dim", `feature: ${details.featureSlug}`), 0, 0));
	container.addChild(new Text(theme.fg("dim", `groups: ${details.groupCount}`), 0, 0));
	container.addChild(new Text(theme.fg("dim", `packages: ${details.packageCount}`), 0, 0));
	container.addChild(new Spacer(1));
	for (const group of details.groups) container.addChild(new Text(theme.fg("muted", `Group ${group.index}: ${group.packageIds.join(", ")}`), 0, 0));
	for (const result of details.results) {
		container.addChild(new Spacer(1));
		container.addChild(new Text(`${result.exitCode === 0 ? theme.fg("success", "✓") : theme.fg("error", "✗")} ${theme.fg("accent", result.packageId)} ${theme.fg("dim", `(${result.owner}) ${result.goal}`)}`, 0, 0));
		container.addChild(new Markdown(result.finalOutput || "(no output)", 0, 0, getMarkdownTheme()));
	}
	return container;
}

async function applyConfiguredOrchestratorModel(pi: ExtensionAPI, ctx: any, state: OrchestrationModeState): Promise<void> {
	const spec = getConfiguredModelSpec(ctx.cwd, "orchestrator");
	if (!spec) return;
	const [provider, ...rest] = spec.split("/");
	const modelId = rest.join("/");
	if (!provider || !modelId) return;
	if (ctx.model?.provider === provider && ctx.model?.id === modelId) return;
	if (!state.previousModelSpec && ctx.model?.provider && ctx.model?.id) {
		state.previousModelSpec = `${ctx.model.provider}/${ctx.model.id}`;
	}
	const model = ctx.modelRegistry.find(provider, modelId);
	if (!model) {
		ctx.ui.notify(`Configured orchestrator model not found: ${spec}`, "warning");
		return;
	}
	const success = await pi.setModel(model);
	if (!success) ctx.ui.notify(`No credentials for orchestrator model: ${spec}`, "warning");
}

async function restorePreviousModel(pi: ExtensionAPI, ctx: any, state: OrchestrationModeState): Promise<void> {
	const spec = state.previousModelSpec;
	if (!spec) return;
	const [provider, ...rest] = spec.split("/");
	const modelId = rest.join("/");
	if (provider && modelId) {
		const model = ctx.modelRegistry.find(provider, modelId);
		if (model) await pi.setModel(model);
	}
	state.previousModelSpec = undefined;
}

async function buildOrchestratorPrompt(cwd: string): Promise<string> {
	const agent = getAgentConfig(cwd, "orchestrator");
	const prompt = agent?.systemPrompt?.trim();
	return [ORCHESTRATOR_RUNTIME_PROMPT.trim(), prompt].filter(Boolean).join("\n\n");
}

export default function smalldoenExtension(pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx) => {
		await ensureRuntimeLayout(ctx.cwd);
		restoreOrchestrationMode(ctx, modeState);
		syncTopLevelTools(pi);
		if (modeState.enabled && !runtimeRole) await applyConfiguredOrchestratorModel(pi, ctx, modeState);
	});

	pi.on("session_switch", async (_event, ctx) => {
		await ensureRuntimeLayout(ctx.cwd);
		restoreOrchestrationMode(ctx, modeState);
		syncTopLevelTools(pi);
		if (modeState.enabled && !runtimeRole) await applyConfiguredOrchestratorModel(pi, ctx, modeState);
	});

	pi.on("input", async (event, ctx) => {
		if (!isTopLevelOrchestrationModeEnabled(modeState.enabled)) return { action: "continue" as const };
		if (!activeRun || !event.text.trim()) return { action: "continue" as const };
		if (event.text.trim().startsWith("/orch")) return { action: "continue" as const };
		await markActiveRunAsStale(ctx.cwd, `Superseded by new user input: ${event.text.trim().slice(0, 200)}`);
		activeRunAbortController?.abort();
		if (!ctx.isIdle()) ctx.abort();
		return { action: "continue" as const };
	});

	pi.registerCommand("orch", {
		description: "Toggle orchestration mode for this session (/orch, /orch on, /orch off, /orch status)",
		handler: async (args, ctx) => {
			const command = (args || "").trim().toLowerCase();
			const current = getOrchestrationMode(modeState);
			if (!["", "toggle", "on", "off", "status"].includes(command)) {
				ctx.ui.notify("Usage: /orch, /orch on, /orch off, /orch status", "warning");
				return;
			}
			if (command === "status") {
				ctx.ui.notify(describeMode(current), "info");
				applyModeIndicator(ctx, current);
				return;
			}
			if ((command === "" || command === "toggle" || command === "off") && !ctx.isIdle()) {
				if (activeRun) await markActiveRunAsStale(ctx.cwd, "Orchestration mode turned off during active run.");
				activeRunAbortController?.abort();
				ctx.abort();
			}
			let next = current;
			if (command === "on") next = true;
			else if (command === "off") next = false;
			else next = toggleOrchestrationMode(pi, ctx, modeState);
			if (command === "on" || command === "off") setOrchestrationMode(pi, ctx, modeState, next);
			if (!runtimeRole) {
				if (next) await applyConfiguredOrchestratorModel(pi, ctx, modeState);
				else await restorePreviousModel(pi, ctx, modeState);
			}
			syncTopLevelTools(pi);
			ctx.ui.notify(describeMode(next), "info");
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
			ctx.ui.notify(`Loaded status for ${manifest.runId}`, "info");
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
				if (!runtimeRole && !isTopLevelOrchestrationModeEnabled(modeState.enabled)) {
					throw new Error("docs_lookup is available only in /orch mode or to the scout child role.");
				}
				if (!params.url && !params.query) throw new Error("Provide either url or query.");
				const result = params.url ? await fetchUrl(params.url) : await searchDocs(params.query!);
				return { content: [{ type: "text", text: buildDocsContext(result) }], details: result };
			},
			renderCall(args, theme) {
				return new Text(`${theme.fg("toolTitle", theme.bold("docs_lookup "))}${theme.fg("accent", args.url ?? args.query ?? "")}`, 0, 0);
			},
			renderResult(result, { expanded }, theme) {
				const text = result.content[0]?.type === "text" ? result.content[0].text : "(no output)";
				if (!expanded) return new Text(text.split("\n").slice(0, 4).join("\n"), 0, 0);
				return new Markdown(text, 0, 0, getMarkdownTheme());
			},
		});
	}

	if (!runtimeRole) {
		pi.registerTool({
			name: DELEGATE_TOOL_NAME,
			label: "Delegate",
			description: "Run a specialized child role in an isolated pi subprocess. Roles: scout, planner, engineer, designer, reviewer. Planner requires the feature field so the runtime can version the plan path.",
			promptSnippet: "Delegate targeted work to scout, planner, engineer, designer, or reviewer in isolated child pi processes.",
			promptGuidelines: [
				"Use this tool instead of implementing directly when orchestration mode is enabled.",
				"Run planner before any engineer or designer implementation work.",
			],
			parameters: DelegateParams,
			async execute(_toolCallId, params, signal, onUpdate, ctx) {
				if (!isTopLevelOrchestrationModeEnabled(modeState.enabled)) throw new Error("delegate is available only when /orch mode is enabled.");
				const result = await runDelegatedRole({
					cwd: ctx.cwd,
					role: params.role as WorkerRole,
					task: params.task,
					feature: params.feature,
					signal,
					onUpdate: (details) => onUpdate?.({ content: [{ type: "text", text: details.finalOutput || `(${details.role} running...)` }], details }),
				});
				return {
					content: [{ type: "text", text: [
						`Role: ${result.details.role}`,
						result.details.planPath ? `Plan: ${result.details.planPath}` : undefined,
						result.details.finalOutput || "(no output)",
					].filter(Boolean).join("\n\n") }],
					details: result.details,
				};
			},
			renderCall(args, theme) {
				const preview = args.task.length > 60 ? `${args.task.slice(0, 60)}...` : args.task;
				return new Text(`${theme.fg("toolTitle", theme.bold("delegate "))}${theme.fg("accent", args.role)}${theme.fg("dim", ` ${preview}`)}`, 0, 0);
			},
			renderResult(result, { expanded }, theme) {
				const details = result.details as DelegateToolDetails | undefined;
				if (!details) return new Text(result.content[0]?.type === "text" ? result.content[0].text : "(no output)", 0, 0);
				return renderDelegateResult(details, expanded, theme);
			},
		});

		pi.registerTool({
			name: PLAN_FEATURE_TOOL_NAME,
			label: "Plan Feature",
			description: "Run the planning stage for a feature. The runtime optionally runs scout, then planner, versions the plan file, validates the plan, and returns parsed work-package metadata.",
			promptSnippet: "Use this tool to create or version a feature plan before any implementation work.",
			promptGuidelines: [
				"Use this tool before engineer or designer work begins.",
				"Set scoutMode to skip only for tiny, local, already-clear work.",
			],
			parameters: PlanFeatureParams,
			async execute(_toolCallId, params, signal, onUpdate, ctx) {
				if (!isTopLevelOrchestrationModeEnabled(modeState.enabled)) throw new Error("plan_feature is available only when /orch mode is enabled.");
				const result = await runPlanFeatureStage({
					cwd: ctx.cwd,
					feature: params.feature,
					objective: params.objective,
					scoutMode: (params.scoutMode ?? "auto") as "auto" | "run" | "skip",
					scoutTask: params.scoutTask,
					signal,
					onUpdate: (message, details) => onUpdate?.({ content: [{ type: "text", text: message }], details }),
				});
				await recordRoleExecution("orchestrator", ctx.cwd, {
					task: `plan_feature: ${params.feature}`,
					status: "success",
					output: `Plan created at ${result.details.planPath}`,
					metadata: { featureSlug: result.details.featureSlug, planPath: result.details.planPath },
				});
				const packageSummary = result.parsedPlan.packages.map((pkg) => `- ${pkg.packageId} (${pkg.owner}) ${pkg.goal}`).join("\n");
				return {
					content: [{ type: "text", text: [
						`Feature slug: ${result.details.featureSlug}`,
						`Plan path: ${result.details.planPath}`,
						`Scout used: ${result.details.scoutUsed ? "yes" : "no"}`,
						`Parallel allowed: ${result.details.parallelAllowed ? "yes" : "no"}`,
						`Packages: ${result.details.packageCount}`,
						packageSummary || "- no packages parsed",
						"",
						result.details.plannerSummary || "(no planner output)",
					].join("\n") }],
					details: result.details,
				};
			},
			renderCall(args, theme) {
				return new Text(`${theme.fg("toolTitle", theme.bold("plan_feature "))}${theme.fg("accent", args.feature)}${theme.fg("dim", ` [${args.scoutMode ?? "auto"}]`)}`, 0, 0);
			},
			renderResult(result, { expanded }, theme) {
				const details = result.details as PlanFeatureDetails | undefined;
				if (!details) return new Text(result.content[0]?.type === "text" ? result.content[0].text : "(no output)", 0, 0);
				const header = `${theme.fg("success", "✓")} ${theme.fg("toolTitle", theme.bold("plan_feature"))}${theme.fg("dim", `  ${details.planPath}`)}`;
				if (!expanded) return new Text(`${header}\n${theme.fg("dim", `packages:${details.packageCount} parallel:${details.parallelAllowed ? "yes" : "no"} scout:${details.scoutUsed ? "yes" : "no"}`)}`, 0, 0);
				const container = new Container();
				container.addChild(new Text(header, 0, 0));
				container.addChild(new Text(theme.fg("dim", `feature: ${details.featureSlug}`), 0, 0));
				container.addChild(new Text(theme.fg("dim", `packages: ${details.packageCount}`), 0, 0));
				container.addChild(new Text(theme.fg("dim", `parallel allowed: ${details.parallelAllowed ? "yes" : "no"}`), 0, 0));
				container.addChild(new Text(theme.fg("dim", `scout used: ${details.scoutUsed ? "yes" : "no"}`), 0, 0));
				if (details.scoutSummary) {
					container.addChild(new Spacer(1));
					container.addChild(new Text(theme.fg("muted", "Scout Summary"), 0, 0));
					container.addChild(new Markdown(details.scoutSummary, 0, 0, getMarkdownTheme()));
				}
				container.addChild(new Spacer(1));
				container.addChild(new Text(theme.fg("muted", "Planner Summary"), 0, 0));
				container.addChild(new Markdown(details.plannerSummary || "(no output)", 0, 0, getMarkdownTheme()));
				return container;
			},
		});

		pi.registerTool({
			name: EXECUTE_PLAN_TOOL_NAME,
			label: "Execute Plan",
			description: "Execute work packages from a validated plan file. The runtime parses package metadata, groups parallel-safe packages, and delegates each package to engineer or designer child roles.",
			promptSnippet: "Use this tool after plan_feature to execute plan packages from the latest or explicit plan file.",
			promptGuidelines: [
				"Use this tool only after a valid planner-generated plan exists.",
				"Provide feature to resolve the latest plan version automatically.",
			],
			parameters: ExecutePlanParams,
			async execute(_toolCallId, params, signal, onUpdate, ctx) {
				if (!isTopLevelOrchestrationModeEnabled(modeState.enabled)) throw new Error("execute_plan is available only when /orch mode is enabled.");
				const explicitPlanPath = resolveOptionalUserPath(ctx.cwd, params.planPath);
				let resolvedPlanPath = explicitPlanPath;
				if (!resolvedPlanPath) {
					if (!params.feature?.trim()) throw new Error("execute_plan requires either planPath or feature.");
					resolvedPlanPath = await getLatestPlanPath(ctx.cwd, slugifyFeatureName(params.feature));
					if (!resolvedPlanPath) throw new Error(`No plan found for feature: ${params.feature}`);
				}
				const details = await runExecutePlanStage({
					cwd: ctx.cwd,
					planPath: resolvedPlanPath,
					packageIds: params.packageIds,
					signal,
					onUpdate: (message, partial) => onUpdate?.({ content: [{ type: "text", text: message }], details: partial }),
				});
				await recordRoleExecution("orchestrator", ctx.cwd, {
					task: `execute_plan: ${details.planPath}`,
					status: "success",
					output: `Executed ${details.packageCount} package(s) from ${details.planPath}`,
					metadata: { featureSlug: details.featureSlug, planPath: details.planPath, packageCount: details.packageCount },
				});
				return { content: [{ type: "text", text: [
					`Plan path: ${details.planPath}`,
					`Feature slug: ${details.featureSlug}`,
					`Groups executed: ${details.groupCount}`,
					`Packages executed: ${details.packageCount}`,
					...details.results.map((result) => `- ${result.packageId} (${result.owner}) ${result.goal}`),
				].join("\n") }], details };
			},
			renderCall(args, theme) {
				const label = args.planPath ? args.planPath : args.feature || "latest-plan";
				return new Text(`${theme.fg("toolTitle", theme.bold("execute_plan "))}${theme.fg("accent", label)}`, 0, 0);
			},
			renderResult(result, { expanded }, theme) {
				const details = result.details as ExecutePlanDetails | undefined;
				if (!details) return new Text(result.content[0]?.type === "text" ? result.content[0].text : "(no output)", 0, 0);
				return renderExecutePlanResult(details, expanded, theme);
			},
		});

		pi.registerTool({
			name: RUN_FEATURE_TOOL_NAME,
			label: "Run Feature",
			description: "Run the full feature workflow: optional scout, planner, worker execution, reviewer, and up to 3 repair loops with project-local run manifests and reports.",
			promptSnippet: "Use this tool for the full end-to-end orchestration flow for a feature.",
			promptGuidelines: [
				"Use this tool when the user wants full end-to-end implementation flow.",
				"This tool plans, executes, reviews, and retries fixes automatically up to the configured limit.",
			],
			parameters: RunFeatureParams,
			async execute(_toolCallId, params, signal, onUpdate, ctx) {
				if (!isTopLevelOrchestrationModeEnabled(modeState.enabled)) throw new Error("run_feature is available only when /orch mode is enabled.");
				const scoutMode = (params.scoutMode ?? "auto") as "auto" | "run" | "skip";
				const featureSlug = slugifyFeatureName(params.feature);
				const scoutUsed = shouldRunScout(params.objective, scoutMode);
				let manifest = await createRunManifest(ctx.cwd, {
					feature: params.feature,
					featureSlug,
					objective: params.objective,
					scoutUsed,
				});
				const controller = new AbortController();
				linkAbortSignals(signal, controller);
				activeRun = manifest;
				activeRunAbortController = controller;

				try {
					await appendRunEvent(ctx.cwd, manifest, "run_start", `Started run for ${params.feature}`);
					const planStage = await runPlanFeatureStage({
						cwd: ctx.cwd,
						feature: params.feature,
						objective: params.objective,
						scoutMode,
						signal: controller.signal,
						runId: manifest.runId,
						onUpdate: (message, details) => onUpdate?.({ content: [{ type: "text", text: message }], details }),
					});
					manifest = await updateRunManifest(ctx.cwd, manifest, {
						stage: "execution",
						planPath: planStage.details.planPath,
						scoutUsed: planStage.details.scoutUsed,
					});
					await appendRunEvent(ctx.cwd, manifest, "plan_ready", `Plan ready at ${planStage.details.planPath}`, { planPath: planStage.details.planPath });

					let currentPlanPath = planStage.details.planPath;
					let currentPlan = planStage.parsedPlan;
					let currentExecution = await runExecutePlanStage({
						cwd: ctx.cwd,
						planPath: currentPlanPath,
						signal: controller.signal,
						onUpdate: (message, details) => onUpdate?.({ content: [{ type: "text", text: message }], details }),
					});
					manifest = await updateRunManifest(ctx.cwd, manifest, { execution: currentExecution, stage: "review" });
					await appendRunEvent(ctx.cwd, manifest, "execution_complete", `Executed ${currentExecution.packageCount} package(s).`, { packageCount: currentExecution.packageCount });

					const maxReviewLoops = Math.min(MAX_REVIEW_LOOPS, Math.max(1, Math.floor(params.maxReviewLoops ?? MAX_REVIEW_LOOPS)));
					let loopCount = 0;
					let review = await runReviewStage({
						cwd: ctx.cwd,
						runId: manifest.runId,
						planPath: currentPlanPath,
						execution: currentExecution,
						signal: controller.signal,
						onUpdate: (message, details) => onUpdate?.({ content: [{ type: "text", text: message }], details }),
					});
					manifest = await updateRunManifest(ctx.cwd, manifest, { review: review.verdict, stage: "review", reviewLoops: loopCount });
					await appendRunEvent(ctx.cwd, manifest, "review_complete", `Review verdict: ${review.verdict.verdict}`, {
						verdict: review.verdict.verdict,
						routingHint: review.verdict.routingHint,
						needRescout: review.verdict.needRescout,
					});

					while (review.verdict.verdict === "fail" && loopCount < maxReviewLoops) {
						loopCount += 1;
						manifest = await updateRunManifest(ctx.cwd, manifest, { reviewLoops: loopCount, stage: "repair" });

						if (review.verdict.needRescout) {
							await appendRunEvent(ctx.cwd, manifest, "rescout_requested", `Reviewer requested a new scout pass on loop ${loopCount}.`);
							const repairObjective = [params.objective, "Review feedback:", review.verdict.rawOutput].join("\n\n");
							const replanned = await runPlanFeatureStage({
								cwd: ctx.cwd,
								feature: params.feature,
								objective: repairObjective,
								scoutMode: "run",
								signal: controller.signal,
								runId: manifest.runId,
								onUpdate: (message, details) => onUpdate?.({ content: [{ type: "text", text: message }], details }),
							});
							currentPlanPath = replanned.details.planPath;
							currentPlan = replanned.parsedPlan;
							manifest = await updateRunManifest(ctx.cwd, manifest, { planPath: currentPlanPath, stage: "execution" });
							await appendRunEvent(ctx.cwd, manifest, "plan_replaced", `Replanned to ${currentPlanPath}`, { planPath: currentPlanPath });
							currentExecution = await runExecutePlanStage({
								cwd: ctx.cwd,
								planPath: currentPlanPath,
								signal: controller.signal,
								onUpdate: (message, details) => onUpdate?.({ content: [{ type: "text", text: message }], details }),
							});
						} else {
							const reroutePackageIds = selectPackageIdsForRouting(currentPlan, review.verdict.routingHint);
							await appendRunEvent(ctx.cwd, manifest, "repair_reroute", `Repair loop ${loopCount} rerouted to ${review.verdict.routingHint}.`, {
								routingHint: review.verdict.routingHint,
								packageIds: reroutePackageIds,
							});
							currentExecution = await runExecutePlanStage({
								cwd: ctx.cwd,
								planPath: currentPlanPath,
								packageIds: reroutePackageIds,
								signal: controller.signal,
								onUpdate: (message, details) => onUpdate?.({ content: [{ type: "text", text: message }], details }),
							});
						}

						manifest = await updateRunManifest(ctx.cwd, manifest, { execution: currentExecution, stage: "review" });
						review = await runReviewStage({
							cwd: ctx.cwd,
							runId: manifest.runId,
							planPath: currentPlanPath,
							execution: currentExecution,
							signal: controller.signal,
							onUpdate: (message, details) => onUpdate?.({ content: [{ type: "text", text: message }], details }),
						});
						manifest = await updateRunManifest(ctx.cwd, manifest, { review: review.verdict, reviewLoops: loopCount });
						await appendRunEvent(ctx.cwd, manifest, "review_complete", `Review verdict after loop ${loopCount}: ${review.verdict.verdict}`, {
							verdict: review.verdict.verdict,
							routingHint: review.verdict.routingHint,
							needRescout: review.verdict.needRescout,
						});
					}

					const finalStatus = review.verdict.verdict === "fail" ? "failed" : "completed";
					manifest = await markRunFinished(ctx.cwd, manifest, finalStatus);
					await appendRunEvent(ctx.cwd, manifest, "run_end", `Run finished with verdict ${review.verdict.verdict}.`);
					await recordRoleExecution("orchestrator", ctx.cwd, {
						task: `run_feature: ${params.feature}`,
						status: review.verdict.verdict === "fail" ? "error" : "success",
						output: `Run ${manifest.runId} finished with verdict ${review.verdict.verdict}.`,
						metadata: { runId: manifest.runId, featureSlug, planPath: currentPlanPath, verdict: review.verdict.verdict },
					});

					const resultDetails: RunFeatureDetails = {
						runId: manifest.runId,
						featureSlug: currentExecution.featureSlug,
						planPath: currentPlanPath,
						reviewLoops: loopCount,
						finalVerdict: review.verdict.verdict,
						reportPath: getReviewReportPath(ctx.cwd, manifest.runId),
						scoutUsed: manifest.scoutUsed,
						packageCount: currentExecution.packageCount,
					};

					return {
						content: [{ type: "text", text: [
							`Run ID: ${resultDetails.runId}`,
							`Feature slug: ${resultDetails.featureSlug}`,
							`Plan path: ${resultDetails.planPath}`,
							`Review loops: ${resultDetails.reviewLoops}`,
							`Final verdict: ${resultDetails.finalVerdict}`,
							`Review report: ${resultDetails.reportPath}`,
						].join("\n") }],
						details: resultDetails,
					};
				} catch (error) {
					if (activeRun) {
						if (activeRun.status !== "stale") {
							activeRun = await markRunFinished(ctx.cwd, activeRun, "failed");
						}
						await appendRunEvent(ctx.cwd, activeRun, "run_error", error instanceof Error ? error.message : String(error));
					}
					throw error;
				} finally {
					clearActiveRun();
				}
			},
			renderCall(args, theme) {
				return new Text(`${theme.fg("toolTitle", theme.bold("run_feature "))}${theme.fg("accent", args.feature)}${theme.fg("dim", ` [${args.scoutMode ?? "auto"}]`)}`, 0, 0);
			},
			renderResult(result, { expanded }, theme) {
				const details = result.details as RunFeatureDetails | undefined;
				if (!details) return new Text(result.content[0]?.type === "text" ? result.content[0].text : "(no output)", 0, 0);
				const header = `${details.finalVerdict === "fail" ? theme.fg("error", "✗") : theme.fg("success", "✓")} ${theme.fg("toolTitle", theme.bold("run_feature"))}${theme.fg("dim", `  ${details.runId}`)}`;
				if (!expanded) return new Text(`${header}\n${theme.fg("dim", `verdict:${details.finalVerdict} loops:${details.reviewLoops} packages:${details.packageCount}`)}`, 0, 0);
				return new Markdown([header, `feature: ${details.featureSlug}`, `plan: ${details.planPath}`, `report: ${details.reportPath}`, `verdict: ${details.finalVerdict}`, `review loops: ${details.reviewLoops}`].join("\n"), 0, 0, getMarkdownTheme());
			},
		});
	}

	pi.on("before_agent_start", async (event, ctx) => {
		if (!isTopLevelOrchestrationModeEnabled(modeState.enabled)) return;
		const orchestratorMemory = await buildRoleMemoryContext("orchestrator", ctx.cwd);
		const orchestratorPrompt = await buildOrchestratorPrompt(ctx.cwd);
		return {
			systemPrompt: `${event.systemPrompt}\n\n${orchestratorPrompt}${orchestratorMemory ? `\n\n${orchestratorMemory}` : ""}`,
		};
	});

	pi.on("tool_call", async (event, ctx) => {
		const role = resolveEffectiveRole();
		if (!role) return;
		if (event.toolName === "write" || event.toolName === "edit") {
			const inputPath = (event.input as { path?: string } | undefined)?.path;
			if (!inputPath) return;
			if (role === "orchestrator") return { block: true, reason: "Orchestrator is read-only in /orch mode." };
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
