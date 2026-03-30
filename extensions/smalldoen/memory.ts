import * as fs from "node:fs/promises";
import * as path from "node:path";
import { withFileMutationQueue } from "@mariozechner/pi-coding-agent";
import { getRoleMemoryDir } from "./paths";
import type { AgentRole } from "./types";

export interface RoleJournalEntry {
	timestamp: string;
	task: string;
	status: "success" | "error";
	output: string;
	metadata?: Record<string, unknown>;
}

export interface RoleMemoryData {
	summary: string;
	facts: Record<string, unknown>;
	recentJournal: RoleJournalEntry[];
}

function truncateText(value: string, maxLength: number): string {
	if (value.length <= maxLength) return value;
	return `${value.slice(0, maxLength)}...`;
}

function getPaths(cwd: string, role: AgentRole) {
	const root = getRoleMemoryDir(cwd, role);
	return {
		root,
		summaryPath: path.join(root, "summary.md"),
		factsPath: path.join(root, "facts.json"),
		journalPath: path.join(root, "journal.jsonl"),
	};
}

async function readTextIfExists(filePath: string): Promise<string> {
	try {
		return await fs.readFile(filePath, "utf8");
	} catch {
		return "";
	}
}

async function readJsonIfExists(filePath: string): Promise<Record<string, unknown>> {
	try {
		const content = await fs.readFile(filePath, "utf8");
		const parsed = JSON.parse(content);
		return parsed && typeof parsed === "object" ? parsed : {};
	} catch {
		return {};
	}
}

export async function loadRoleMemory(role: AgentRole, cwd: string): Promise<RoleMemoryData> {
	const paths = getPaths(cwd, role);
	const [summary, facts, journalContent] = await Promise.all([
		readTextIfExists(paths.summaryPath),
		readJsonIfExists(paths.factsPath),
		readTextIfExists(paths.journalPath),
	]);
	const recentJournal = journalContent
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean)
		.slice(-10)
		.map((line) => {
			try {
				return JSON.parse(line) as RoleJournalEntry;
			} catch {
				return undefined;
			}
		})
		.filter((entry): entry is RoleJournalEntry => Boolean(entry));
	return { summary, facts, recentJournal };
}

export async function saveRoleMemory(role: AgentRole, cwd: string, memory: { summary: string; facts: Record<string, unknown> }): Promise<void> {
	const paths = getPaths(cwd, role);
	await fs.mkdir(paths.root, { recursive: true });
	await withFileMutationQueue(paths.summaryPath, async () => {
		await fs.writeFile(paths.summaryPath, memory.summary, "utf8");
	});
	await withFileMutationQueue(paths.factsPath, async () => {
		await fs.writeFile(paths.factsPath, `${JSON.stringify(memory.facts, null, 2)}\n`, "utf8");
	});
}

export async function appendRoleJournal(role: AgentRole, cwd: string, entry: RoleJournalEntry): Promise<void> {
	const paths = getPaths(cwd, role);
	await fs.mkdir(paths.root, { recursive: true });
	await withFileMutationQueue(paths.journalPath, async () => {
		await fs.appendFile(paths.journalPath, `${JSON.stringify(entry)}\n`, "utf8");
	});
}

export async function mergeRoleMemory(role: AgentRole, cwd: string, delta: { summary?: string; facts?: Record<string, unknown> }): Promise<RoleMemoryData> {
	const current = await loadRoleMemory(role, cwd);
	const next: RoleMemoryData = {
		summary: delta.summary ?? current.summary,
		facts: { ...current.facts, ...(delta.facts ?? {}) },
		recentJournal: current.recentJournal,
	};
	await saveRoleMemory(role, cwd, { summary: next.summary, facts: next.facts });
	return next;
}

export async function recordRoleExecution(
	role: AgentRole,
	cwd: string,
	input: { task: string; status: "success" | "error"; output: string; metadata?: Record<string, unknown> },
): Promise<void> {
	const timestamp = new Date().toISOString();
	await appendRoleJournal(role, cwd, {
		timestamp,
		task: input.task,
		status: input.status,
		output: truncateText(input.output, 6000),
		metadata: input.metadata,
	});

	const summary = [
		`# ${role} memory`,
		"",
		`Last updated: ${timestamp}`,
		"",
		"## Latest task",
		truncateText(input.task, 1000),
		"",
		"## Latest outcome",
		truncateText(input.output, 4000) || "(no output)",
	].join("\n");

	await mergeRoleMemory(role, cwd, {
		summary,
		facts: {
			lastUpdated: timestamp,
			lastStatus: input.status,
			lastTask: truncateText(input.task, 500),
			...(input.metadata ?? {}),
		},
	});
}

export async function buildRoleMemoryContext(role: AgentRole, cwd: string): Promise<string> {
	const memory = await loadRoleMemory(role, cwd);
	const parts: string[] = [];
	if (memory.summary.trim()) {
		parts.push("Role memory summary:");
		parts.push(memory.summary.trim());
	}
	const factEntries = Object.entries(memory.facts);
	if (factEntries.length > 0) {
		parts.push("Role memory facts:");
		for (const [key, value] of factEntries) {
			parts.push(`- ${key}: ${typeof value === "string" ? value : JSON.stringify(value)}`);
		}
	}
	if (memory.recentJournal.length > 0) {
		parts.push("Recent role journal:");
		for (const entry of memory.recentJournal.slice(-5)) {
			parts.push(`- [${entry.timestamp}] ${entry.status} :: ${truncateText(entry.task, 160)}`);
		}
	}
	return parts.length > 0 ? parts.join("\n\n") : "";
}
