import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { type ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * Qwen3.8-Flash-Next on a DGX Spark, served by vLLM through its OpenAI-compatible API.
 *
 * Registers the `spark` provider and sets Qwen's thinking per request. pi sends its thinking level as
 * OpenAI-style `reasoning_effort`, which Qwen's chat template ignores, so without this Qwen thinks on
 * every request. Instead `chat_template_kwargs.enable_thinking` follows pi's thinking level:
 *   off                   -> never think
 *   minimal, low, medium  -> hybrid: think on the first request of each prompt, on the request after a
 *                            failed tool call and on every 8th request; otherwise answer directly
 *   high, xhigh, max      -> always think
 *
 * Settings, from the environment or ~/.pi/agent/spark.json (environment wins), all optional:
 *   SPARK_URL / url                 OpenAI-compatible base URL (default http://localhost:18300/v1)
 *   SPARK_API_KEY / apiKey          only if your server checks keys
 *   SPARK_MODEL / model             served model name (default qwen3.8-flash-next)
 *   SPARK_CONTEXT / contextWindow   context window in tokens (default 500000)
 *   QWEN_THINKING / thinking        off, on or hybrid: force a mode regardless of pi's level
 *   QWEN_THINK_EVERY / thinkEvery   re-plan interval in hybrid mode (default 8, 0 = never)
 *   QWEN_CALL_LIMIT / callLimit     tool calls per prompt before the model is told to finish, and stopped 10 calls
 *                                   later if it keeps going (default 80, 0 = no limit)
 *   QWEN_REWRITE_LIMIT / rewriteLimit  refuse a write that would replace an existing file longer than this many
 *                                   lines, so the model edits instead of rewriting (default 50, 0 = off)
 *   QWEN_TEST_HINT / testHint       on: tell the model to check its work through the project's tests rather than
 *                                   throwaway scripts, and to edit rather than rewrite files (default on)
 */

type Settings = Partial<Record<"url" | "apiKey" | "model" | "contextWindow" | "thinking" | "thinkEvery" | "callLimit" | "rewriteLimit" | "testHint", string | number>>;

function loadSettings(): Settings {
	const file = path.join(process.env.PI_CODING_AGENT_DIR ?? path.join(os.homedir(), ".pi", "agent"), "spark.json");
	try {
		return JSON.parse(fs.readFileSync(file, "utf8")) as Settings;
	} catch {
		return {};
	}
}

export default function (pi: ExtensionAPI) {
	const file = loadSettings();
	const setting = (env: string, key: keyof Settings, fallback: string) => process.env[env] ?? (file[key] !== undefined ? String(file[key]) : fallback);

	const modelId = setting("SPARK_MODEL", "model", "qwen3.8-flash-next");
	const every = Number(setting("QWEN_THINK_EVERY", "thinkEvery", "8"));
	const callLimit = Number(setting("QWEN_CALL_LIMIT", "callLimit", "80"));
	const forced = setting("QWEN_THINKING", "thinking", "");
	const rewriteLimit = Number(setting("QWEN_REWRITE_LIMIT", "rewriteLimit", "50"));
	const testHint = setting("QWEN_TEST_HINT", "testHint", "on") === "on";

	pi.registerProvider("spark", {
		name: "DGX Spark",
		baseUrl: setting("SPARK_URL", "url", "http://localhost:18300/v1"),
		// vLLM ignores the key unless started with --api-key; pi needs a value either way.
		apiKey: process.env.SPARK_API_KEY ? "$SPARK_API_KEY" : String(file.apiKey ?? "none"),
		api: "openai-completions",
		models: [
			{
				id: modelId,
				name: "Qwen3.8 Flash Next (Spark)",
				reasoning: true,
				input: ["text", "image"],
				inputLimits: { images: { resize: { maxWidth: 1568, maxHeight: 1568, maxBytes: 524288, jpegQuality: 80 } } },
				contextWindow: Number(setting("SPARK_CONTEXT", "contextWindow", "500000")),
				maxTokens: 32768,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			},
		],
	});

	let requests = 0;
	let calls = 0;
	let failedSinceLastRequest = false;
	let active = false;

	const mode = (): "off" | "on" | "hybrid" => {
		if (forced === "off" || forced === "on" || forced === "hybrid") return forced;
		const level = pi.getThinkingLevel();
		if (level === "off") return "off";
		if (level === "high" || level === "xhigh" || level === "max") return "on";
		return "hybrid";
	};

	pi.on("agent_start", () => {
		requests = 0;
		calls = 0;
		failedSinceLastRequest = false;
	});

	pi.on("tool_execution_end", (event) => {
		if (event.isError) failedSinceLastRequest = true;
	});

	// Counted here rather than in tool_call: pi rejects calls with invalid arguments or unknown tool names
	// before tool_call fires, so a model stuck repeating a broken call would never reach the limit.
	pi.on("tool_execution_start", (_event, ctx) => {
		if (!active) return;
		calls++;
		// Those rejected calls can't be blocked either, so stop the prompt if the model keeps going well past the limit.
		if (callLimit > 0 && calls > callLimit + 10) ctx.abort();
	});

	pi.on("tool_call", async (event, ctx) => {
		if (!active) return undefined;
		if (callLimit > 0 && calls > callLimit) {
			return { block: true, reason: `[budget] ${callLimit} tool calls used for this prompt. Stop calling tools: finish now with what you have, and say what you could not check.` };
		}
		// Rewriting a whole file costs every one of its tokens again, which on the Spark is most of the time a task takes.
		if (rewriteLimit > 0 && event.toolName === "write") {
			const target = path.resolve(ctx.cwd, (event.input as { path: string }).path);
			let lines = 0;
			try {
				const text = fs.readFileSync(target, "utf8");
				lines = text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
			} catch {
				return undefined;
			}
			if (lines > rewriteLimit) {
				return {
					block: true,
					reason: `[edit, don't rewrite] ${(event.input as { path: string }).path} already has ${lines} lines. Use edit to change only the parts that are wrong: one edit call can hold several replacements, and a replacement can cover a whole function.`,
				};
			}
		}
		return undefined;
	});

	pi.on("before_agent_start", (event, ctx) => {
		if (!testHint || ctx.model?.provider !== "spark") return undefined;
		event.systemPromptOptions.appendSystemPrompt = `${event.systemPromptOptions.appendSystemPrompt ?? ""}

## Working on files
- Change existing files with edit, touching only the parts that need to change. One edit call can hold several replacements.
- Check your work through the project's tests: add the checks you need to the test file and rerun the test command after each fix. Do not write throwaway scripts (heredocs, files in /tmp) to try out your code.
`;
		return undefined;
	});

	pi.on("before_provider_request", (event, ctx) => {
		active = ctx.model?.provider === "spark";
		if (!active) return undefined;
		requests++;
		const m = mode();
		const think = m === "on" || (m === "hybrid" && (requests === 1 || failedSinceLastRequest || (every > 0 && requests % every === 0)));
		failedSinceLastRequest = false;
		const payload = { ...(event.payload as Record<string, unknown>) };
		payload.chat_template_kwargs = { ...((payload.chat_template_kwargs as object) ?? {}), enable_thinking: think };
		return payload;
	});
}
