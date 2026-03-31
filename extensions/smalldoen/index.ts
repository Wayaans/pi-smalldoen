import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { StringEnum } from "@mariozechner/pi-ai";
import { getMarkdownTheme, type ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Container, Markdown, Spacer, Text, truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { getAgentConfig } from "./agents";
import { findProjectRoot, getConfiguredModelSpec, getConfigPath, hasSmalldoenConfig } from "./config";
import { buildDocsContext, fetchUrl, searchDocs } from "./docs";
import { runDelegatedRole, workerRoles, type WorkerRole } from "./delegate";
import {
	assertArtifactPathAllowed,
	assertPlannerPathAllowed,
	getRuntimeRole,
	isReadOnlyBashCommand,
	isTopLevelOrchestrationModeEnabled,
} from "./guards";
import { buildAgentHookContent } from "./hooks";
import { buildRoleMemoryContext } from "./memory";
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
} from "./plan";
import {
	ensureRuntimeLayout,
	getReviewReportPath,
	getScoutReportPath,
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
	type PlanInspectionDetails,
	type ReviewSummary,
} from "./types";

const DOCS_LOOKUP_TOOL_NAME = "docs_lookup" as const;
const INSPECT_PLAN_TOOL_NAME = "inspect_plan" as const;
const MANAGE_RUN_TOOL_NAME = "manage_run" as const;
const SMALLDOEN_RUN_WIDGET_KEY = "smalldoen-run-widget" as const;
const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const modeState: OrchestrationModeState = { enabled: false };
const runtimeRole = getRuntimeRole();

let activeRunId: string | undefined;

interface LiveSubagentState {
	key: string;
	slot: number;
	role: WorkerRole;
	label: string;
	packageId?: string;
	runId?: string;
	status: DelegateToolDetails["status"];
	model?: string;
	output: string;
	updatedAt: string;
}

const liveSubagents = new Map<string, LiveSubagentState>();
const liveSubagentOrder: string[] = [];
const liveSubagentOverlays = new Map<number, { handle: { hide(): void }; panel: SubagentOverlayPanel; stateKey: string }>();

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
	for (const toolName of [DELEGATE_TOOL_NAME, INSPECT_PLAN_TOOL_NAME, MANAGE_RUN_TOOL_NAME, DOCS_LOOKUP_TOOL_NAME]) {
		if (modeState.enabled) activeTools.add(toolName);
		else activeTools.delete(toolName);
	}
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

function buildModeBadgeLine(theme: any, manifest: RunManifest | undefined, enabled: boolean): string | undefined {
	if (!enabled) return undefined;
	const pills: string[] = [];
	if (manifest && manifest.status === "active") {
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
	return pills.join(" ");
}

function applyRunVisualization(ctx: any, manifest: RunManifest | undefined, enabled: boolean): void {
	if (!ctx.hasUI) return;
	if (!enabled) {
		ctx.ui.setWidget(SMALLDOEN_RUN_WIDGET_KEY, undefined);
		return;
	}
	ctx.ui.setWidget(SMALLDOEN_RUN_WIDGET_KEY, (_tui: any, theme: any) => ({
		render(width: number): string[] {
			const line = buildModeBadgeLine(theme, manifest, enabled);
			return line ? [rightAlign(line, width)] : [];
		},
		invalidate() {},
	}));
}

function setActiveRun(manifest: RunManifest | undefined): void {
	activeRunId = manifest?.status === "active" ? manifest.runId : undefined;
}

async function refreshRunVisualization(ctx: any): Promise<void> {
	if (!isTopLevelOrchestrationModeEnabled(modeState.enabled)) {
		resetLiveSubagents();
		setActiveRun(undefined);
		applyRunVisualization(ctx, undefined, false);
		return;
	}
	if (!activeRunId) {
		applyRunVisualization(ctx, undefined, true);
		return;
	}
	const manifest = await loadRunManifest(ctx.cwd, activeRunId);
	const activeManifest = manifest?.status === "active" ? manifest : undefined;
	if (!activeManifest) resetLiveSubagents();
	setActiveRun(activeManifest);
	applyRunVisualization(ctx, activeManifest, true);
}

function getDefaultConfigExamplePath(): string {
	return path.join(packageRoot, "defaults", "smalldoen.example.json");
}

function buildMissingConfigGuidance(cwd: string): { message: string; editorText: string } {
	const projectRoot = findProjectRoot(cwd);
	const configPath = getConfigPath(cwd);
	const examplePath = getDefaultConfigExamplePath();
	const copyCommand = `mkdir -p "${path.dirname(configPath)}" && cp "${examplePath}" "${configPath}"`;
	return {
		message: `Missing orchestration config. Create .pi/smalldoen.json in the project root: ${configPath}`,
		editorText: [
			"Missing orchestration config.",
			"",
			`Create this file in the project root: ${configPath}`,
			`Project root: ${projectRoot}`,
			`Default example config: ${examplePath}`,
			`Copy example: ${copyCommand}`,
		].join("\n"),
	};
}

function ensureConfigPresent(cwd: string): void {
	if (hasSmalldoenConfig(cwd)) return;
	throw new Error(buildMissingConfigGuidance(cwd).editorText);
}

function liveSubagentKey(input: { runId?: string; role: WorkerRole; packageId?: string; label?: string }): string {
	return `${input.runId ?? "run"}:${input.role}:${input.packageId ?? input.label ?? input.role}`;
}

function resetLiveSubagents(): void {
	for (const overlay of liveSubagentOverlays.values()) overlay.handle.hide();
	liveSubagentOverlays.clear();
	liveSubagents.clear();
	liveSubagentOrder.splice(0, liveSubagentOrder.length);
}

function upsertLiveSubagent(input: {
	runId?: string;
	role: WorkerRole;
	label?: string;
	packageId?: string;
	status: DelegateToolDetails["status"];
	model?: string;
	output?: string;
}): LiveSubagentState {
	const key = liveSubagentKey(input);
	const existing = liveSubagents.get(key);
	if (!existing) liveSubagentOrder.push(key);
	const state: LiveSubagentState = {
		key,
		slot: existing?.slot ?? liveSubagentOrder.indexOf(key) + 1,
		role: input.role,
		label: input.label?.trim() || input.packageId?.trim() || input.role,
		packageId: input.packageId?.trim() || existing?.packageId,
		runId: input.runId ?? existing?.runId,
		status: input.status,
		model: input.model ?? existing?.model,
		output: input.output ?? existing?.output ?? "",
		updatedAt: new Date().toISOString(),
	};
	liveSubagents.set(key, state);
	return state;
}

function getLiveSubagentForSlot(slot: number): LiveSubagentState | undefined {
	const key = liveSubagentOrder[slot - 1];
	return key ? liveSubagents.get(key) : undefined;
}

function refreshLiveSubagentOverlays(): void {
	for (const overlay of liveSubagentOverlays.values()) overlay.panel.invalidate();
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

class SubagentOverlayPanel {
	constructor(
		private readonly tui: any,
		private readonly theme: any,
		private readonly slot: number,
		private readonly getState: () => LiveSubagentState | undefined,
	) {}

	invalidate(): void {
		this.tui.requestRender();
	}

	render(width: number): string[] {
		const state = this.getState();
		if (!state) return [];
		const innerWidth = Math.max(30, width - 2);
		const pad = (line: string) => line + " ".repeat(Math.max(0, innerWidth - visibleWidth(line)));
		const row = (line = "") => `${this.theme.fg("dim", "│")}${pad(line)}${this.theme.fg("dim", "│")}`;
		const lines: string[] = [];
		lines.push(this.theme.fg("dim", `╭${"─".repeat(innerWidth)}╮`));
		lines.push(row(` ${this.theme.fg("accent", this.theme.bold(`SUBAGENT ${this.slot}`))} ${this.theme.fg("toolTitle", `${state.label} → ${state.role}`)}`));
		lines.push(row(` ${this.theme.fg(state.status === "running" ? "warning" : state.status === "success" ? "success" : "error", state.status.toUpperCase())}${state.model ? this.theme.fg("dim", `  ${state.model}`) : ""}`));
		if (state.runId) lines.push(row(` ${this.theme.fg("dim", `run ${state.runId}`)}`));
		lines.push(row(""));
		const content = state.output?.trim() ? state.output.trim() : "(waiting for subagent output...)";
		for (const line of content.split("\n").slice(-14)) {
			lines.push(row(` ${truncateToWidth(line, innerWidth - 2, "")}`));
		}
		lines.push(this.theme.fg("dim", `╰${"─".repeat(innerWidth)}╯`));
		return lines;
	}
	dispose(): void {}
}

async function toggleSubagentOverlay(slot: number, ctx: any): Promise<void> {
	const existing = liveSubagentOverlays.get(slot);
	if (existing) {
		existing.handle.hide();
		liveSubagentOverlays.delete(slot);
		return;
	}
	const state = getLiveSubagentForSlot(slot);
	if (!state) {
		ctx.ui.notify(`No subagent mapped to Ctrl+Alt+${slot}.`, "info");
		return;
	}
	let panel: SubagentOverlayPanel | undefined;
	void ctx.ui.custom(
		(tui: any, theme: any, _keybindings: any, _done: () => void) => {
			panel = new SubagentOverlayPanel(tui, theme, slot, () => getLiveSubagentForSlot(slot));
			return panel;
		},
		{
			overlay: true,
			overlayOptions: {
				anchor: "top-right",
				width: "48%",
				maxHeight: "45%",
				margin: { top: 2 + (slot - 1) * 2, right: 2 },
			},
			onHandle: (handle: any) => {
				if (panel) liveSubagentOverlays.set(slot, { handle, panel, stateKey: state.key });
			},
		},
	).finally(() => {
		liveSubagentOverlays.delete(slot);
	});
}

async function writeReport(filePath: string, content: string): Promise<void> {
	await fs.mkdir(path.dirname(filePath), { recursive: true });
	await fs.writeFile(filePath, content, "utf8");
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
	const stateKey = isPartial
		? liveSubagentKey({ runId: details.runId, role: details.role as WorkerRole, packageId: details.packageId, label: details.label })
		: undefined;
	const liveSlot = stateKey ? liveSubagents.get(stateKey)?.slot : undefined;
	const metaBits = [
		theme.fg(statusColor, statusIcon(status)),
		details.model ? theme.fg("dim", details.model) : undefined,
		details.runId ? theme.fg("dim", details.runId) : undefined,
		isPartial && liveSlot ? theme.fg("dim", `Ctrl+Alt+${liveSlot} to expand`) : undefined,
	].filter(Boolean).join("  ");
	const preview = details.finalOutput ? summarizeText(details.finalOutput, 4) : "(running...)";
	if (!expanded) return new Text(`${metaBits}\n${theme.fg("toolOutput", preview)}`, 0, 0);

	const container = new Container();
	container.addChild(new Text(metaBits, 0, 0));
	if (details.reportPath) container.addChild(new Text(theme.fg("dim", `report ${details.reportPath}`), 0, 0));
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
		resetLiveSubagents();
		setActiveRun(undefined);
		await refreshRunVisualization(ctx);
	});

	pi.on("session_switch", async (_event, ctx) => {
		await ensureRuntimeLayout(ctx.cwd);
		restoreOrchestrationMode(ctx, modeState);
		syncTopLevelTools(pi);
		if (modeState.enabled && !runtimeRole) await applyConfiguredOrchestratorModel(pi, ctx, modeState);
		resetLiveSubagents();
		setActiveRun(undefined);
		await refreshRunVisualization(ctx);
	});

	pi.on("input", async (event, ctx) => {
		if (!isTopLevelOrchestrationModeEnabled(modeState.enabled)) return { action: "continue" as const };
		const text = event.text.trim();
		if (!text) return { action: "continue" as const };
		const allowedWithoutConfig = ["/orch", "/reload", "/smalldoen-status"];
		if (!hasSmalldoenConfig(ctx.cwd)) {
			if (!allowedWithoutConfig.some((command) => text === command || text.startsWith(`${command} `))) {
				const guidance = buildMissingConfigGuidance(ctx.cwd);
				ctx.ui.notify(guidance.message, "error");
				return { action: "handled" as const };
			}
			return { action: "continue" as const };
		}
		if (text.startsWith("/orch")) return { action: "continue" as const };
		if (!activeRunId) return { action: "continue" as const };
		const manifest = await loadRunManifest(ctx.cwd, activeRunId);
		if (manifest && manifest.status === "active") {
			const stale = await markRunStale(ctx.cwd, manifest, `Superseded by new user input: ${event.text.trim().slice(0, 200)}`);
			await appendRunEvent(ctx.cwd, stale, "run_stale", "Run marked stale because a new user instruction interrupted the workflow.");
			resetLiveSubagents();
			setActiveRun(undefined);
			applyRunVisualization(ctx, stale, true);
		}
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
				await refreshRunVisualization(ctx);
				return;
			}
			if ((command === "" || command === "toggle" || command === "off") && !ctx.isIdle()) ctx.abort();
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
			if (next && !hasSmalldoenConfig(ctx.cwd)) {
				const guidance = buildMissingConfigGuidance(ctx.cwd);
				ctx.ui.notify(guidance.message, "warning");
			}
			if (!current && next) {
				resetLiveSubagents();
				setActiveRun(undefined);
			}
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
			applyRunVisualization(ctx, manifest, modeState.enabled);
			ctx.ui.notify(`Loaded status for ${manifest.runId}`, "info");
		},
	});

	if (!runtimeRole) {
		for (let slot = 1; slot <= 9; slot++) {
			pi.registerShortcut(`ctrl+alt+${slot}` as any, {
				description: `Toggle smalldoen subagent overlay ${slot}`,
				handler: async (ctx) => {
					if (!isTopLevelOrchestrationModeEnabled(modeState.enabled)) return;
					await toggleSubagentOverlay(slot, ctx);
				},
			});
		}
	}

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
				return new Text(`${theme.fg("toolTitle", theme.bold("Looking up "))}${theme.fg("accent", "[DOCS_LOOKUP]")} ${theme.fg("toolOutput", args.url ?? args.query ?? "")}`, 0, 0);
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
				if (!isTopLevelOrchestrationModeEnabled(modeState.enabled)) throw new Error("manage_run is available only when /orch mode is enabled.");
				ensureConfigPresent(ctx.cwd);

				if (params.action === "start") {
					if (!params.feature?.trim() || !params.objective?.trim()) throw new Error("manage_run start requires feature and objective.");
					if (activeRunId) {
						const current = await loadRunManifest(ctx.cwd, activeRunId);
						if (current && current.status === "active") {
							await markRunStale(ctx.cwd, current, "Superseded by a new orchestration run.");
						}
					}
					resetLiveSubagents();
					let manifest = await createRunManifest(ctx.cwd, {
						feature: params.feature,
						featureSlug: slugifyFeatureName(params.feature),
						objective: params.objective,
						scoutUsed: false,
					});
					manifest = await appendRunEvent(ctx.cwd, manifest, "run_start", `Started orchestration run for ${params.feature}`);
					setActiveRun(manifest);
					applyRunVisualization(ctx, manifest, true);
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
					applyRunVisualization(ctx, manifest, true);
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
					applyRunVisualization(ctx, nextManifest, true);
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
					applyRunVisualization(ctx, nextManifest, true);
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
					applyRunVisualization(ctx, nextManifest, true);
					return { content: [{ type: "text", text: formatManifestSummary(nextManifest) }], details: buildManageRunDetails("review", nextManifest) };
				}

				if (params.action === "finish") {
					const finalStatus = params.finalStatus ?? "completed";
					let nextManifest = manifest;
					if (finalStatus === "stale") nextManifest = await markRunStale(ctx.cwd, manifest, params.note?.trim() || "Marked stale.");
					else nextManifest = await markRunFinished(ctx.cwd, manifest, finalStatus);
					nextManifest = await appendRunEvent(ctx.cwd, nextManifest, "run_end", params.note?.trim() || `Run finished with status ${finalStatus}.`);
					if (finalStatus !== "stale") resetLiveSubagents();
					setActiveRun(nextManifest.status === "active" ? nextManifest : undefined);
					applyRunVisualization(ctx, nextManifest, true);
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
				if (!isTopLevelOrchestrationModeEnabled(modeState.enabled)) throw new Error("inspect_plan is available only when /orch mode is enabled.");
				ensureConfigPresent(ctx.cwd);
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
				if (!isTopLevelOrchestrationModeEnabled(modeState.enabled)) throw new Error("delegate is available only when /orch mode is enabled.");
				ensureConfigPresent(ctx.cwd);

				const configuredRoleModel = getConfiguredModelSpec(ctx.cwd, params.role as WorkerRole);
				upsertLiveSubagent({
					runId: params.runId,
					role: params.role as WorkerRole,
					label: params.label,
					packageId: params.packageId,
					status: "running",
					model: configuredRoleModel,
					output: "",
				});
				refreshLiveSubagentOverlays();
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
					applyRunVisualization(ctx, manifest, true);
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
						onUpdate: (details) => {
							upsertLiveSubagent({
								runId: details.runId,
								role: details.role as WorkerRole,
								label: details.label,
								packageId: details.packageId,
								status: details.status,
								model: details.model,
								output: details.finalOutput,
							});
							refreshLiveSubagentOverlays();
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
					upsertLiveSubagent({
						runId: details.runId,
						role: details.role as WorkerRole,
						label: details.label,
						packageId: details.packageId,
						status: details.status,
						model: details.model,
						output: details.finalOutput,
					});
					refreshLiveSubagentOverlays();
					if (details.role === "scout" && params.runId) details.reportPath = getScoutReportPath(ctx.cwd, params.runId);
					if (details.role === "reviewer" && params.runId) details.reportPath = getReviewReportPath(ctx.cwd, params.runId);
					if (details.reportPath) await writeReport(details.reportPath, details.finalOutput || "");

					if (manifest) {
						upsertSubagentState(manifest, {
							role: details.role,
							label: details.label || details.role,
							status: "completed",
							packageId: details.packageId,
							summary: summarizeText(details.finalOutput || "", 2),
						});
						manifest = await updateRunManifest(ctx.cwd, manifest, { subagents: manifest.subagents, scoutUsed: manifest.scoutUsed || details.role === "scout" });
						manifest = await appendRunEvent(ctx.cwd, manifest, "delegate_complete", `${details.label || details.role} completed.`, {
							role: details.role,
							label: details.label,
							packageId: details.packageId,
							reportPath: details.reportPath,
						});
						setActiveRun(manifest);
						applyRunVisualization(ctx, manifest, true);
					}

					return {
						content: [{ type: "text", text: [
							`Role: ${details.role}`,
							details.label ? `Label: ${details.label}` : undefined,
							details.runId ? `Run: ${details.runId}` : undefined,
							details.packageId ? `Package: ${details.packageId}` : undefined,
							details.planPath ? `Plan: ${details.planPath}` : undefined,
							details.reportPath ? `Report: ${details.reportPath}` : undefined,
							details.changedFiles && details.changedFiles.length > 0 ? `Changed Files: ${details.changedFiles.join(", ")}` : undefined,
							details.review ? `Review Verdict: ${details.review.verdict} / ${details.review.routingHint}` : undefined,
							details.finalOutput || "(no output)",
						].filter(Boolean).join("\n\n") }],
						details,
					};
				} catch (error) {
					upsertLiveSubagent({
						runId: params.runId,
						role: params.role as WorkerRole,
						label: params.label,
						packageId: params.packageId,
						status: "error",
						model: configuredRoleModel,
						output: error instanceof Error ? error.message : String(error),
					});
					refreshLiveSubagentOverlays();
					if (manifest) {
						upsertSubagentState(manifest, {
							role: params.role as WorkerRole,
							label: params.label?.trim() || params.packageId?.trim() || params.role,
							status: "failed",
							packageId: params.packageId?.trim() || undefined,
							summary: error instanceof Error ? error.message : String(error),
						});
						manifest = await updateRunManifest(ctx.cwd, manifest, { subagents: manifest.subagents, scoutUsed: manifest.scoutUsed || params.role === "scout" });
						manifest = await appendRunEvent(ctx.cwd, manifest, "delegate_error", `${params.label?.trim() || params.role} failed.`, {
							role: params.role,
							label: params.label,
							packageId: params.packageId,
							error: error instanceof Error ? error.message : String(error),
						});
						setActiveRun(manifest);
						applyRunVisualization(ctx, manifest, true);
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
		if (!isTopLevelOrchestrationModeEnabled(modeState.enabled)) return;
		const orchestratorMemory = await buildRoleMemoryContext("orchestrator", ctx.cwd);
		const orchestratorPrompt = await buildOrchestratorPrompt(ctx.cwd);
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
