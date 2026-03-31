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

function getMessageText(message: Message | undefined): string {
	if (!message) return "";
	if (typeof message.content === "string") return message.content;
	if (!Array.isArray(message.content)) return "";
	return message.content
		.filter((part): part is { type: "text"; text: string } => part?.type === "text" && typeof (part as any).text === "string")
		.map((part) => part.text)
		.join("");
}

function getFinalOutput(messages: Message[]): string {
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (message.role !== "assistant") continue;
		const text = getMessageText(message);
		if (text) return text;
	}
	return "";
}

function truncate(text: string, max: number): string {
	if (text.length <= max) return text;
	return `${text.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

function stringifyToolArgs(args: unknown): string {
	if (!args || typeof args !== "object") return "";
	const value = args as Record<string, unknown>;
	if (typeof value.command === "string") return truncate(value.command.replace(/\s+/g, " ").trim(), 120);
	if (typeof value.path === "string") return value.path;
	if (Array.isArray(value.paths)) return truncate(value.paths.join(", "), 120);
	if (Array.isArray(value.edits)) {
		const pathLabel = typeof value.path === "string" ? `${value.path} ` : "";
		return `${pathLabel}(${value.edits.length} edit${value.edits.length === 1 ? "" : "s"})`;
	}
	try {
		return truncate(JSON.stringify(args), 120);
	} catch {
		return "";
	}
}

function getToolResultText(result: any): string {
	if (!result || typeof result !== "object") return "";
	const content = Array.isArray(result.content) ? result.content : [];
	return content
		.filter((part: any) => part?.type === "text" && typeof part.text === "string")
		.map((part: any) => part.text)
		.join("\n")
		.trim();
}

function summarizeToolResultText(text: string): string {
	const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
	if (lines.length === 0) return "";
	return truncate(lines[lines.length - 1]!, 120);
}

interface LiveToolTrace {
	toolName: string;
	args: unknown;
	output: string;
}

interface ChildLiveTrace {
	recentEvents: string[];
	activeTools: Map<string, LiveToolTrace>;
	activeToolOrder: string[];
	assistantStreaming: string;
	lastAssistant: string;
}

function pushRecentEvent(trace: ChildLiveTrace, text: string): void {
	if (!text.trim()) return;
	trace.recentEvents.push(text.trim());
	if (trace.recentEvents.length > 12) trace.recentEvents.splice(0, trace.recentEvents.length - 12);
}

function renderLiveTrace(trace: ChildLiveTrace): string {
	const sections: string[] = [];
	if (trace.recentEvents.length > 0) {
		sections.push(["Events:", ...trace.recentEvents.slice(-6).map((line) => `- ${line}`)].join("\n"));
	}

	const activeIds = trace.activeToolOrder.filter((id) => trace.activeTools.has(id));
	if (activeIds.length > 0) {
		const toolBlocks = activeIds.map((id) => {
			const tool = trace.activeTools.get(id)!;
			const header = `- ${tool.toolName}${stringifyToolArgs(tool.args) ? `: ${stringifyToolArgs(tool.args)}` : ""}`;
			const outputLines = (tool.output || "(waiting for tool output...)")
				.split(/\r?\n/)
				.filter((line) => line.trim().length > 0)
				.slice(-8)
				.map((line) => `  ${truncate(line, 140)}`);
			return [header, ...outputLines].join("\n");
		});
		sections.push(["Active tools:", ...toolBlocks].join("\n"));
	}

	const assistantText = (trace.assistantStreaming || trace.lastAssistant).trim();
	if (assistantText) {
		sections.push([
			"Assistant:",
			...assistantText
				.split(/\r?\n/)
				.filter((line) => line.trim().length > 0)
				.slice(-8)
				.map((line) => truncate(line, 140)),
		].join("\n"));
	}

	return sections.join("\n\n").trim();
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
			const trace: ChildLiveTrace = {
				recentEvents: [],
				activeTools: new Map(),
				activeToolOrder: [],
				assistantStreaming: "",
				lastAssistant: "",
			};
			let lastRenderedTrace = "";
			const emitTrace = () => {
				const nextTrace = renderLiveTrace(trace);
				if (!nextTrace || nextTrace === lastRenderedTrace) return;
				lastRenderedTrace = nextTrace;
				onUpdate?.(nextTrace);
			};

			const processLine = (line: string) => {
				if (!line.trim()) return;
				let event: any;
				try {
					event = JSON.parse(line);
				} catch {
					return;
				}

				if (event.type === "turn_start") {
					pushRecentEvent(trace, "turn started");
					emitTrace();
					return;
				}

				if (event.type === "message_start" && event.message?.role === "assistant") {
					trace.assistantStreaming = "";
					emitTrace();
					return;
				}

				if (event.type === "message_update" && event.message?.role === "assistant") {
					if (event.assistantMessageEvent?.type === "text_delta" && typeof event.assistantMessageEvent.delta === "string") {
						trace.assistantStreaming += event.assistantMessageEvent.delta;
					} else {
						trace.assistantStreaming = getMessageText(event.message as Message) || trace.assistantStreaming;
					}
					emitTrace();
					return;
				}

				if (event.type === "tool_execution_start") {
					trace.activeTools.set(event.toolCallId, {
						toolName: event.toolName,
						args: event.args,
						output: "",
					});
					if (!trace.activeToolOrder.includes(event.toolCallId)) trace.activeToolOrder.push(event.toolCallId);
					pushRecentEvent(trace, `${event.toolName} started${stringifyToolArgs(event.args) ? `: ${stringifyToolArgs(event.args)}` : ""}`);
					emitTrace();
					return;
				}

				if (event.type === "tool_execution_update") {
					const tool = trace.activeTools.get(event.toolCallId);
					if (tool) tool.output = getToolResultText(event.partialResult);
					emitTrace();
					return;
				}

				if (event.type === "tool_execution_end") {
					const tool = trace.activeTools.get(event.toolCallId);
					const resultText = getToolResultText(event.result);
					pushRecentEvent(
						trace,
						`${event.toolName} ${event.isError ? "failed" : "finished"}${stringifyToolArgs(event.args) ? `: ${stringifyToolArgs(event.args)}` : ""}`,
					);
					if (tool) {
						tool.output = resultText || tool.output;
						trace.activeTools.delete(event.toolCallId);
						trace.activeToolOrder = trace.activeToolOrder.filter((id) => id !== event.toolCallId);
					}
					const resultSummary = summarizeToolResultText(resultText || tool?.output || "");
					if (resultSummary) pushRecentEvent(trace, `${event.toolName} output: ${resultSummary}`);
					emitTrace();
					return;
				}

				if (event.type === "message_end" && event.message) {
					const message = event.message as Message & { stopReason?: string; errorMessage?: string; model?: string };
					messages.push(message);
					if (message.role === "assistant") {
						stopReason = message.stopReason;
						errorMessage = message.errorMessage;
						model = message.model;
						trace.lastAssistant = getMessageText(message) || trace.lastAssistant;
						trace.assistantStreaming = "";
						pushRecentEvent(trace, "assistant finished");
						emitTrace();
					}
					return;
				}

				if (event.type === "turn_end") {
					pushRecentEvent(trace, "turn finished");
					emitTrace();
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
