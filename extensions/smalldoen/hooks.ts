import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getSmalldoenPaths } from "./paths";
import type { AgentRole } from "./types";

async function readHookFile(filePath: string): Promise<string> {
	try {
		const content = await fs.readFile(filePath, "utf8");
		return content.trim();
	} catch {
		return "";
	}
}

export function getHooksDir(cwd: string): string {
	return getSmalldoenPaths(cwd).hooksDir;
}

export async function buildAgentHookContent(cwd: string): Promise<string> {
	return readHookFile(path.join(getHooksDir(cwd), "agent.md"));
}

export async function buildSubagentHookContent(cwd: string, role: AgentRole): Promise<string> {
	const hooksDir = getHooksDir(cwd);
	const [shared, specific] = await Promise.all([
		readHookFile(path.join(hooksDir, "subagent.md")),
		readHookFile(path.join(hooksDir, `${role}.md`)),
	]);
	return [shared, specific].filter(Boolean).join("\n\n");
}
