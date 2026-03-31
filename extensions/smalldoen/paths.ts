import * as fs from "node:fs/promises";
import * as path from "node:path";
import { findProjectRoot, loadSmalldoenConfig } from "./config";
import type { AgentRole } from "./types";

export interface SmalldoenPaths {
	root: string;
	agentsDir: string;
	promptsDir: string;
	extensionDir: string;
	artifactsDir: string;
	plansDir: string;
	reportsDir: string;
	scoutReportsDir: string;
	reviewReportsDir: string;
	runsDir: string;
	logsDir: string;
	memoryDir: string;
	hooksDir: string;
}

export function getSmalldoenPaths(cwd: string): SmalldoenPaths {
	const projectRoot = findProjectRoot(cwd);
	const projectPiDir = path.join(projectRoot, ".pi");
	const artifactsDir = path.join(projectPiDir, "smalldoen");
	const config = loadSmalldoenConfig(cwd);
	const plansDir = config.paths?.plansDir ? path.resolve(projectRoot, config.paths.plansDir) : path.join(artifactsDir, "plans");
	const memoryDir = config.paths?.memoryDir ? path.resolve(projectRoot, config.paths.memoryDir) : path.join(artifactsDir, "memory");
	const runsDir = config.paths?.runsDir ? path.resolve(projectRoot, config.paths.runsDir) : path.join(artifactsDir, "runs");
	const scoutReportsDir = config.paths?.scoutReportsDir
		? path.resolve(projectRoot, config.paths.scoutReportsDir)
		: path.join(artifactsDir, "reports", "scout");
	const reviewReportsDir = config.paths?.reviewReportsDir
		? path.resolve(projectRoot, config.paths.reviewReportsDir)
		: path.join(artifactsDir, "reports", "review");
	return {
		root: projectPiDir,
		agentsDir: path.join(projectPiDir, "agents"),
		promptsDir: path.join(projectPiDir, "prompts"),
		extensionDir: path.join(projectPiDir, "extensions", "smalldoen"),
		artifactsDir,
		plansDir,
		reportsDir: path.dirname(scoutReportsDir),
		scoutReportsDir,
		reviewReportsDir,
		runsDir,
		logsDir: path.join(artifactsDir, "logs"),
		memoryDir,
		hooksDir: path.join(artifactsDir, "hooks"),
	};
}

export function getRoleMemoryDir(cwd: string, role: AgentRole): string {
	const config = loadSmalldoenConfig(cwd);
	const roleMemoryDir = config.agents?.[role]?.memoryDir;
	if (roleMemoryDir) return path.resolve(findProjectRoot(cwd), roleMemoryDir);
	return path.join(getSmalldoenPaths(cwd).memoryDir, role);
}

export function getRunManifestPath(cwd: string, runId: string): string {
	return path.join(getSmalldoenPaths(cwd).runsDir, `${runId}.json`);
}

export function getScoutReportPath(cwd: string, runId: string): string {
	const config = loadSmalldoenConfig(cwd);
	const configured = config.agents?.scout?.reportDir;
	const reportDir = configured ? path.resolve(findProjectRoot(cwd), configured) : getSmalldoenPaths(cwd).scoutReportsDir;
	return path.join(reportDir, `${runId}.md`);
}

export function getSubagentLogsDir(cwd: string, runId?: string): string {
	return path.join(getSmalldoenPaths(cwd).logsDir, runId?.trim() || "adhoc");
}

export function getReviewReportPath(cwd: string, runId: string): string {
	const config = loadSmalldoenConfig(cwd);
	const configured = config.agents?.reviewer?.reportDir;
	const reportDir = configured ? path.resolve(findProjectRoot(cwd), configured) : getSmalldoenPaths(cwd).reviewReportsDir;
	return path.join(reportDir, `${runId}.md`);
}

export async function ensureRuntimeLayout(cwd: string): Promise<void> {
	const paths = getSmalldoenPaths(cwd);
	const directories = [
		paths.agentsDir,
		paths.promptsDir,
		paths.extensionDir,
		paths.plansDir,
		paths.scoutReportsDir,
		paths.reviewReportsDir,
		paths.runsDir,
		paths.logsDir,
		getRoleMemoryDir(cwd, "orchestrator"),
		getRoleMemoryDir(cwd, "scout"),
		getRoleMemoryDir(cwd, "planner"),
		getRoleMemoryDir(cwd, "engineer"),
		getRoleMemoryDir(cwd, "designer"),
		getRoleMemoryDir(cwd, "reviewer"),
	];
	await Promise.all(directories.map((dir) => fs.mkdir(dir, { recursive: true })));
}
