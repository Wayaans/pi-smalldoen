import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentRole } from "./types";

export interface AgentRuntimeConfig {
	name?: string;
	description?: string;
	prompt?: string;
	provider?: string;
	model?: string;
	memoryDir?: string;
	reportDir?: string;
}

export interface SmalldoenConfig {
	ui?: {
		modeIndicatorText?: string;
	};
	paths?: {
		plansDir?: string;
		memoryDir?: string;
		runsDir?: string;
		scoutReportsDir?: string;
		reviewReportsDir?: string;
	};
	agents?: Partial<Record<AgentRole, AgentRuntimeConfig>>;
}

function findProjectRoot(cwd: string): string {
	let current = cwd;
	while (true) {
		const candidate = path.join(current, ".pi");
		if (fs.existsSync(candidate)) return current;
		const parent = path.dirname(current);
		if (parent === current) return cwd;
		current = parent;
	}
}

function readJsonIfExists(filePath: string): SmalldoenConfig | undefined {
	try {
		const content = fs.readFileSync(filePath, "utf8");
		const parsed = JSON.parse(content) as SmalldoenConfig;
		return parsed && typeof parsed === "object" ? parsed : undefined;
	} catch {
		return undefined;
	}
}

export function getConfigPath(cwd: string): string {
	return path.join(findProjectRoot(cwd), ".pi", "smalldoen.json");
}

export function hasSmalldoenConfig(cwd: string): boolean {
	return fs.existsSync(getConfigPath(cwd));
}

export function loadSmalldoenConfig(cwd: string): SmalldoenConfig {
	return readJsonIfExists(getConfigPath(cwd)) ?? {};
}

export function resolveConfigPath(cwd: string, input: string): string {
	const projectRoot = findProjectRoot(cwd);
	return path.resolve(projectRoot, input);
}

export function getAgentRuntimeConfig(cwd: string, role: AgentRole): AgentRuntimeConfig {
	return loadSmalldoenConfig(cwd).agents?.[role] ?? {};
}

export function getConfiguredModelSpec(cwd: string, role: AgentRole): string | undefined {
	const roleConfig = getAgentRuntimeConfig(cwd, role);
	const provider = roleConfig.provider?.trim();
	const model = roleConfig.model?.trim();
	if (provider && model) return `${provider}/${model}`;
	if (model) return model;
	return undefined;
}

export function getModeIndicatorText(cwd: string): string {
	return loadSmalldoenConfig(cwd).ui?.modeIndicatorText?.trim() || "Orchestration mode";
}
