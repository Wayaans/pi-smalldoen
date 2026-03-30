import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { parseFrontmatter } from "@mariozechner/pi-coding-agent";
import { getAgentRuntimeConfig, resolveConfigPath } from "./config";
import type { AgentRole } from "./types";
import { getSmalldoenPaths } from "./paths";

export interface AgentConfig {
	name: AgentRole;
	description: string;
	tools?: string[];
	systemPrompt: string;
	filePath: string;
	model?: string;
	provider?: string;
	displayName?: string;
}

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

function isAgentRole(value: string): value is AgentRole {
	return ["orchestrator", "scout", "planner", "engineer", "designer", "reviewer"].includes(value);
}

function getPackagedDefaultPrompt(role: AgentRole): string {
	return path.join(packageRoot, "defaults", "agents", `${role}.md`);
}

export function discoverProjectAgents(cwd: string): AgentConfig[] {
	const agentsDir = getSmalldoenPaths(cwd).agentsDir;
	const roles: AgentRole[] = ["orchestrator", "scout", "planner", "engineer", "designer", "reviewer"];
	const agents: AgentConfig[] = [];

	for (const role of roles) {
		const roleConfig = getAgentRuntimeConfig(cwd, role);
		const configuredPrompt = roleConfig.prompt ? resolveConfigPath(cwd, roleConfig.prompt) : undefined;
		const projectPrompt = path.join(agentsDir, `${role}.md`);
		const packagedPrompt = getPackagedDefaultPrompt(role);
		const filePath = configuredPrompt ?? (fs.existsSync(projectPrompt) ? projectPrompt : packagedPrompt);
		if (!fs.existsSync(filePath)) continue;

		let content = "";
		try {
			content = fs.readFileSync(filePath, "utf8");
		} catch {
			continue;
		}

		const { frontmatter, body } = parseFrontmatter<Record<string, string>>(content);
		const frontmatterRole = frontmatter.name && isAgentRole(frontmatter.name) ? frontmatter.name : role;
		const description = roleConfig.description || frontmatter.description || role;
		const tools = frontmatter.tools
			?.split(",")
			.map((value) => value.trim())
			.filter(Boolean);

		agents.push({
			name: frontmatterRole,
			description,
			tools,
			systemPrompt: body,
			filePath,
			model: roleConfig.model,
			provider: roleConfig.provider,
			displayName: roleConfig.name || frontmatter.name || role,
		});
	}

	return agents;
}

export function getAgentConfig(cwd: string, role: AgentRole): AgentConfig | undefined {
	return discoverProjectAgents(cwd).find((agent) => agent.name === role);
}
