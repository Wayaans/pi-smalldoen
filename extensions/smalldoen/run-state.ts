import * as fs from "node:fs/promises";
import { withFileMutationQueue } from "@mariozechner/pi-coding-agent";
import { getRunManifestPath, getSmalldoenPaths } from "./paths";
import type { ExecutePlanDetails } from "./types";
import type { ReviewVerdict } from "./reviewer";

export interface RunEvent {
	timestamp: string;
	type: string;
	message: string;
	data?: Record<string, unknown>;
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
	startedAt: string;
	updatedAt: string;
	reviewLoops: number;
	staleReason?: string;
	execution?: ExecutePlanDetails;
	review?: ReviewVerdict;
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
		stage: "planning",
		scoutUsed: input.scoutUsed,
		startedAt: timestamp,
		updatedAt: timestamp,
		reviewLoops: 0,
		events: [],
	};
	await saveRunManifest(cwd, manifest);
	return manifest;
}

export async function loadRunManifest(cwd: string, runId: string): Promise<RunManifest | undefined> {
	const filePath = getRunManifestPath(cwd, runId);
	try {
		const content = await fs.readFile(filePath, "utf8");
		return JSON.parse(content) as RunManifest;
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
		return JSON.parse(content) as RunManifest;
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
	const next = { ...manifest, ...patch, updatedAt: new Date().toISOString() };
	await saveRunManifest(cwd, next);
	return next;
}

export async function markRunStale(cwd: string, manifest: RunManifest, reason: string): Promise<RunManifest> {
	return updateRunManifest(cwd, manifest, { status: "stale", staleReason: reason });
}

export async function markRunFinished(cwd: string, manifest: RunManifest, status: "failed" | "completed"): Promise<RunManifest> {
	return updateRunManifest(cwd, manifest, { status });
}
