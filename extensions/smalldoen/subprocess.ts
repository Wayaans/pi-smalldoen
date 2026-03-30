import { spawn } from "node:child_process";
import * as syncFs from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Message } from "@mariozechner/pi-ai";
import type { AgentRole } from "./types";
import type { AgentConfig } from "./agents";

export interface ChildInvocationOptions {
	cwd: string;
	role: AgentRole;
	task: string;
	agent: AgentConfig;
	appendPrompt?: string;
	onUpdate?: (text: string) => void;
	signal?: AbortSignal;
}

export interface ChildAgentResult {
	role: AgentRole;
	exitCode: number;
	stderr: string;
	messages: Message[];
	finalOutput: string;
	stopReason?: string;
	errorMessage?: string;
	model?: string;
}

function getPiInvocation(args: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	if (currentScript && syncFs.existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}
	return { command: "pi", args };
}

function getFinalOutput(messages: Message[]): string {
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (message.role !== "assistant") continue;
		for (const part of message.content) {
			if (part.type === "text") return part.text;
		}
	}
	return "";
}

async function writeTempPrompt(role: AgentRole, content: string): Promise<{ dir: string; filePath: string }> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), `smalldoen-${role}-`));
	const filePath = path.join(dir, `${role}.md`);
	await fs.writeFile(filePath, content, { encoding: "utf8", mode: 0o600 });
	return { dir, filePath };
}

export async function runChildAgent(options: ChildInvocationOptions): Promise<ChildAgentResult> {
	const { cwd, role, task, agent, appendPrompt, onUpdate, signal } = options;
	const messages: Message[] = [];
	const args = ["--mode", "json", "-p", "--no-session"];
	if (agent.provider && agent.model) args.push("--model", `${agent.provider}/${agent.model}`);
	else if (agent.model) args.push("--model", agent.model);
	if (agent.tools?.length) args.push("--tools", agent.tools.join(","));

	let tempPromptDir: string | undefined;
	let tempPromptPath: string | undefined;

	try {
		const promptParts = [agent.systemPrompt.trim(), appendPrompt?.trim()].filter(Boolean);
		if (promptParts.length > 0) {
			const temp = await writeTempPrompt(role, promptParts.join("\n\n"));
			tempPromptDir = temp.dir;
			tempPromptPath = temp.filePath;
			args.push("--append-system-prompt", tempPromptPath);
		}

		args.push(task);

		const invocation = getPiInvocation(args);
		let stderr = "";
		let stopReason: string | undefined;
		let errorMessage: string | undefined;
		let model: string | undefined;
		let wasAborted = false;

		const exitCode = await new Promise<number>((resolve) => {
			const child = spawn(invocation.command, invocation.args, {
				cwd,
				env: { ...process.env, SMALLDOEN_ROLE: role },
				stdio: ["ignore", "pipe", "pipe"],
				shell: false,
			});

			let buffer = "";

			const processLine = (line: string) => {
				if (!line.trim()) return;
				let event: any;
				try {
					event = JSON.parse(line);
				} catch {
					return;
				}

				if (event.type === "message_end" && event.message) {
					const message = event.message as Message & { stopReason?: string; errorMessage?: string; model?: string };
					messages.push(message);
					if (message.role === "assistant") {
						stopReason = message.stopReason;
						errorMessage = message.errorMessage;
						model = message.model;
						onUpdate?.(getFinalOutput(messages));
					}
				}
			};

			child.stdout.on("data", (chunk) => {
				buffer += chunk.toString();
				const lines = buffer.split("\n");
				buffer = lines.pop() || "";
				for (const line of lines) processLine(line);
			});

			child.stderr.on("data", (chunk) => {
				stderr += chunk.toString();
			});

			child.on("close", (code) => {
				if (buffer.trim()) processLine(buffer);
				resolve(code ?? 0);
			});

			child.on("error", () => resolve(1));

			if (signal) {
				const abortChild = () => {
					wasAborted = true;
					child.kill("SIGTERM");
					setTimeout(() => child.kill("SIGKILL"), 3000);
				};
				if (signal.aborted) abortChild();
				else signal.addEventListener("abort", abortChild, { once: true });
			}
		});

		if (wasAborted) throw new Error("Child agent aborted");

		return {
			role,
			exitCode,
			stderr,
			messages,
			finalOutput: getFinalOutput(messages),
			stopReason,
			errorMessage,
			model,
		};
	} finally {
		if (tempPromptPath) await fs.unlink(tempPromptPath).catch(() => undefined);
		if (tempPromptDir) await fs.rm(tempPromptDir, { recursive: true, force: true }).catch(() => undefined);
	}
}
