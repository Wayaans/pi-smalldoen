import * as fs from "node:fs/promises";
import { withFileMutationQueue } from "@mariozechner/pi-coding-agent";
import { getRunManifestPath, getSmalldoenPaths } from "./paths";
import type { AgentRole } from "./types";

export interface RunEvent {
	timestamp: string;
	type: string;
	message: string;
	data?: Record<string, unknown>;
}

export interface StoredReviewSummary {
	verdict: "pass" | "pass_with_warnings" | "fail";
	routingHint: "none" | "engineer" | "designer" | "both";
	needRescout: boolean;
	summary: string;
	reportPath?: string;
}

export type RunPackageStatus = "pending" | "running" | "completed" | "failed" | "blocked";

export interface RunPackageState {
	packageId: string;
	owner?: "engineer" | "designer";
	goal?: string;
	status: RunPackageStatus;
	note?: string;
	changedFiles?: string[];
	updatedAt: string;
}

export interface RunSubagentState {
	key: string;
	role: Exclude<AgentRole, "orchestrator">;
	label: string;
	status: "running" | "completed" | "failed";
	packageId?: string;
	summary?: string;
	traceLogPath?: string;
	rawLogPath?: string;
	stderrLogPath?: string;
	model?: string;
	updatedAt: string;
}

export interface RunManifest {
	runId: string;
	feature: string;
	featureSlug: string;
	objective: string;
	status: "active" | "stale" | "failed" | "completed";
	stage: string;
	scoutUsed: boolean;
	planPath?: string;
	summaryPath?: string;
	startedAt: string;
	updatedAt: string;
	reviewLoops: number;
	staleReason?: string;
	packages: RunPackageState[];
	subagents: RunSubagentState[];
	review?: StoredReviewSummary;
	events: RunEvent[];
}

export function createRunId(): string {
	const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
	return `run-${timestamp}`;
}

async function writeManifest(filePath: string, manifest: RunManifest): Promise<void> {
	await withFileMutationQueue(filePath, async () => {
		await fs.writeFile(filePath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
	});
}

export async function saveRunManifest(cwd: string, manifest: RunManifest): Promise<string> {
	const filePath = getRunManifestPath(cwd, manifest.runId);
	await writeManifest(filePath, manifest);
	return filePath;
}

export async function createRunManifest(cwd: string, input: {
	feature: string;
	featureSlug: string;
	objective: string;
	scoutUsed: boolean;
}): Promise<RunManifest> {
	const timestamp = new Date().toISOString();
	const manifest: RunManifest = {
		runId: createRunId(),
		feature: input.feature,
		featureSlug: input.featureSlug,
		objective: input.objective,
		status: "active",
		stage: "intake",
		scoutUsed: input.scoutUsed,
		startedAt: timestamp,
		updatedAt: timestamp,
		reviewLoops: 0,
		packages: [],
		subagents: [],
		events: [],
	};
	await saveRunManifest(cwd, manifest);
	return manifest;
}

export async function loadRunManifest(cwd: string, runId: string): Promise<RunManifest | undefined> {
	const filePath = getRunManifestPath(cwd, runId);
	try {
		const content = await fs.readFile(filePath, "utf8");
		const parsed = JSON.parse(content) as Partial<RunManifest>;
		return {
			runId: parsed.runId ?? runId,
			feature: parsed.feature ?? "",
			featureSlug: parsed.featureSlug ?? "",
			objective: parsed.objective ?? "",
			status: parsed.status ?? "active",
			stage: parsed.stage ?? "intake",
			scoutUsed: parsed.scoutUsed ?? false,
			planPath: parsed.planPath,
			summaryPath: parsed.summaryPath,
			startedAt: parsed.startedAt ?? new Date().toISOString(),
			updatedAt: parsed.updatedAt ?? new Date().toISOString(),
			reviewLoops: parsed.reviewLoops ?? 0,
			staleReason: parsed.staleReason,
			packages: parsed.packages ?? [],
			subagents: parsed.subagents ?? [],
			review: parsed.review,
			events: parsed.events ?? [],
		};
	} catch {
		return undefined;
	}
}

export async function loadLatestRunManifest(cwd: string): Promise<RunManifest | undefined> {
	const runsDir = getSmalldoenPaths(cwd).runsDir;
	try {
		const entries = await fs.readdir(runsDir, { withFileTypes: true });
		const files = entries
			.filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
			.map((entry) => entry.name)
			.sort();
		const latest = files[files.length - 1];
		if (!latest) return undefined;
		const content = await fs.readFile(`${runsDir}/${latest}`, "utf8");
		const parsed = JSON.parse(content) as RunManifest;
		return {
			...parsed,
			packages: parsed.packages ?? [],
			subagents: parsed.subagents ?? [],
			events: parsed.events ?? [],
		};
	} catch {
		return undefined;
	}
}

export async function appendRunEvent(cwd: string, manifest: RunManifest, type: string, message: string, data?: Record<string, unknown>): Promise<RunManifest> {
	manifest.events.push({ timestamp: new Date().toISOString(), type, message, data });
	manifest.updatedAt = new Date().toISOString();
	await saveRunManifest(cwd, manifest);
	return manifest;
}

export async function updateRunManifest(cwd: string, manifest: RunManifest, patch: Partial<RunManifest>): Promise<RunManifest> {
	const next = {
		...manifest,
		...patch,
		packages: patch.packages ?? manifest.packages,
		subagents: patch.subagents ?? manifest.subagents,
		updatedAt: new Date().toISOString(),
	};
	await saveRunManifest(cwd, next);
	return next;
}

export async function markRunStale(cwd: string, manifest: RunManifest, reason: string): Promise<RunManifest> {
	return updateRunManifest(cwd, manifest, { status: "stale", staleReason: reason });
}

export async function markRunFinished(cwd: string, manifest: RunManifest, status: "failed" | "completed"): Promise<RunManifest> {
	return updateRunManifest(cwd, manifest, { status });
}

export function upsertPackageState(
	manifest: RunManifest,
	input: Omit<RunPackageState, "updatedAt"> & { changedFiles?: string[] },
): RunManifest {
	const updatedAt = new Date().toISOString();
	const existing = manifest.packages.find((pkg) => pkg.packageId === input.packageId);
	const next: RunPackageState = {
		packageId: input.packageId,
		owner: input.owner ?? existing?.owner,
		goal: input.goal ?? existing?.goal,
		status: input.status,
		note: input.note ?? existing?.note,
		changedFiles: input.changedFiles ?? existing?.changedFiles,
		updatedAt,
	};
	manifest.packages = [...manifest.packages.filter((pkg) => pkg.packageId !== input.packageId), next].sort((left, right) => left.packageId.localeCompare(right.packageId));
	manifest.updatedAt = updatedAt;
	return manifest;
}

export function replacePackageStates(manifest: RunManifest, packages: Array<Omit<RunPackageState, "updatedAt">>): RunManifest {
	const updatedAt = new Date().toISOString();
	manifest.packages = packages
		.map((pkg) => ({ ...pkg, updatedAt }))
		.sort((left, right) => left.packageId.localeCompare(right.packageId));
	manifest.updatedAt = updatedAt;
	return manifest;
}

function subagentKey(input: { role: RunSubagentState["role"]; label?: string; packageId?: string }): string {
	return `${input.role}:${input.packageId ?? input.label ?? input.role}`;
}

export function upsertSubagentState(
	manifest: RunManifest,
	input: Omit<RunSubagentState, "key" | "updatedAt">,
): RunManifest {
	const updatedAt = new Date().toISOString();
	const key = subagentKey(input);
	const existing = manifest.subagents.find((subagent) => subagent.key === key);
	const next: RunSubagentState = {
		key,
		role: input.role,
		label: input.label,
		status: input.status,
		packageId: input.packageId ?? existing?.packageId,
		summary: input.summary ?? existing?.summary,
		traceLogPath: input.traceLogPath ?? existing?.traceLogPath,
		rawLogPath: input.rawLogPath ?? existing?.rawLogPath,
		stderrLogPath: input.stderrLogPath ?? existing?.stderrLogPath,
		model: input.model ?? existing?.model,
		updatedAt,
	};
	manifest.subagents = [...manifest.subagents.filter((subagent) => subagent.key !== key), next]
		.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
		.slice(0, 12);
	manifest.updatedAt = updatedAt;
	return manifest;
}
