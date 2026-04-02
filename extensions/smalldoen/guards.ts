import * as path from "node:path";
import { getRoleMemoryDir, getSmalldoenPaths } from "./paths";
import { AGENT_ROLES, type AgentRole, type SmalldoenMode } from "./types";

function normalizeUserPath(input: string): string {
	return input.startsWith("@") ? input.slice(1) : input;
}

function resolvePath(cwd: string, input: string): string {
	return path.resolve(cwd, normalizeUserPath(input));
}

function isWithin(root: string, target: string): boolean {
	const relative = path.relative(root, target);
	return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export function getRuntimeRole(): AgentRole | undefined {
	const value = process.env.SMALLDOEN_ROLE;
	if (!value) return undefined;
	return (AGENT_ROLES as readonly string[]).includes(value) ? (value as AgentRole) : undefined;
}

export function isTopLevelSmalldoenModeEnabled(mode: SmalldoenMode): boolean {
	return !getRuntimeRole() && mode !== "off";
}

export function isTopLevelOrchestrationModeEnabled(mode: SmalldoenMode): boolean {
	return !getRuntimeRole() && mode === "orchestrate";
}

export function isTopLevelAskModeEnabled(mode: SmalldoenMode): boolean {
	return !getRuntimeRole() && mode === "ask";
}

export function assertPlannerPathAllowed(cwd: string, inputPath: string): boolean {
	const plansRoot = getSmalldoenPaths(cwd).plansDir;
	return isWithin(plansRoot, resolvePath(cwd, inputPath));
}

export function assertArtifactPathAllowed(role: AgentRole, cwd: string, inputPath: string): boolean {
	const absolutePath = resolvePath(cwd, inputPath);
	const reportsRoot = getSmalldoenPaths(cwd).reportsDir;
	const memoryRoot = getRoleMemoryDir(cwd, role);
	return isWithin(reportsRoot, absolutePath) || isWithin(memoryRoot, absolutePath);
}

export function isReadOnlyBashCommand(command: string): boolean {
	const normalized = command.replace(/\s+/g, " ").trim().toLowerCase();
	if (normalized.length === 0) return true;

	const forbiddenPatterns = [
		/\b(rm|mv|cp|mkdir|rmdir|touch|chmod|chown)\b/,
		/\btee\b/,
		/\bsed\s+-i\b/,
		/\bperl\s+-i\b/,
		/\bnpm\s+install\b/,
		/\bpnpm\s+(add|install)\b/,
		/\byarn\s+(add|install)\b/,
		/\bbun\s+(add|install)\b/,
		/\bgit\s+(add|commit|push|merge|rebase|restore|checkout|clean|stash)\b/,
		/\bcargo\s+add\b/,
		/\bpip\s+install\b/,
		/\bcomposer\s+require\b/,
		/(^|\s)>{1,2}/,
	];

	return !forbiddenPatterns.some((pattern) => pattern.test(normalized));
}
