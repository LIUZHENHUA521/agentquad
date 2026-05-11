import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	getActiveProviderConfig,
	loadConfig,
	watchConfigFile,
} from "./config-loader.js";
import { getProvider } from "./providers/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = join(__dirname, "config.json");

function validateConfig(nextConfig) {
	const providerConfig = getActiveProviderConfig(nextConfig);
	getProvider(nextConfig.provider, providerConfig);
	return nextConfig;
}

let config;
try {
	config = validateConfig(loadConfig(CONFIG_PATH));
} catch (e) {
	console.error("[config] Failed to load config.json:", e.message);
	process.exit(1);
}

watchConfigFile(CONFIG_PATH, (nextConfig) => {
	config = validateConfig(nextConfig);
});

function getRuntimeContext() {
	const providerConfig = getActiveProviderConfig(config);
	return {
		providerConfig,
		provider: getProvider(config.provider, providerConfig),
	};
}

function resolveModel(requested) {
	const { provider, providerConfig } = getRuntimeContext();
	const fallback = providerConfig.default_model || "gpt-5.4";
	if (!requested) return fallback;
	if (providerConfig.model_map?.[requested])
		return providerConfig.model_map[requested];
	const supported = new Set(
		(
			provider.listModels?.() || [
				fallback,
				...Object.values(providerConfig.model_map || {}),
			]
		).filter(Boolean),
	);
	if (supported.has(requested)) return requested;
	return fallback;
}

function flattenMessages(messages, system) {
	let systemText = "";
	if (typeof system === "string") systemText = system;
	else if (Array.isArray(system))
		systemText = system.map((b) => b.text || "").join("\n");

	const parts = [];
	if (systemText) parts.push(systemText);
	for (const msg of messages || []) {
		const role = msg.role === "assistant" ? "Assistant" : "Human";
		let text = "";
		if (typeof msg.content === "string") text = msg.content;
		else if (Array.isArray(msg.content))
			text = msg.content
				.filter((b) => b.type === "text")
				.map((b) => b.text)
				.join("\n");
		if (text) parts.push(`${role}: ${text}`);
	}
	return parts.join("\n\n");
}

function extractText(parsed) {
	if (typeof parsed === "string") return parsed;
	for (const accessor of [
		(p) => p.content,
		(p) => p.text,
		(p) => p.delta?.content,
		(p) => p.delta?.text,
		(p) => p.choices?.[0]?.delta?.content,
		(p) => p.choices?.[0]?.message?.content,
		(p) => p.message?.content,
		(p) => p.data?.content,
		(p) => p.data?.text,
		(p) => p.answer,
		(p) => p.result,
		(p) => p.response,
	]) {
		const v = accessor(parsed);
		if (typeof v === "string" && v) return v;
	}
	return "";
}

function generateId() {
	return `msg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function sseWrite(res, event, data) {
	res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

async function readProviderSSE(resp, provider, providerConfig, onEvent) {
	const ct = resp.headers.get("content-type") || "";
	if (ct.includes("text/event-stream") || ct.includes("text/plain")) {
		const reader = resp.body.getReader();
		const decoder = new TextDecoder();
		let buf = "";
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			buf += decoder.decode(value, { stream: true });
			const lines = buf.split(/\r?\n/);
			buf = lines.pop() || "";
			for (const line of lines) {
				if (!line.startsWith("data:")) continue;
				const raw = line.slice(5).trim();
				if (!raw || raw === "[DONE]") continue;
				try {
					const parsed = JSON.parse(raw);
					if (providerConfig.log_requests)
						console.log(
							`[${provider.name}] SSE:`,
							JSON.stringify(parsed).slice(0, 200),
						);
					onEvent(provider.parseEvent(parsed));
				} catch {
					if (raw.length > 0) onEvent({ kind: "raw_text", text: raw });
				}
			}
		}
	} else {
		const body = await resp.text();
		if (providerConfig.log_requests)
			console.log(`[${provider.name}] response body:`, body.slice(0, 500));
		try {
			const text = extractText(JSON.parse(body));
			if (text) onEvent({ kind: "final_result", text });
			else onEvent({ kind: "raw_text", text: body });
		} catch {
			onEvent({ kind: "raw_text", text: body });
		}
	}
}

async function callProvider(anthropicBody) {
	const { provider, providerConfig } = getRuntimeContext();
	const model = resolveModel(anthropicBody.model);
	const content = flattenMessages(anthropicBody.messages, anthropicBody.system);
	const resp = await provider.call({ anthropicBody, model, content });
	return { model, provider, providerConfig, resp };
}

async function handleStream(anthropicBody, res) {
	const model = resolveModel(anthropicBody.model);
	const mid = generateId();
	let sawAnthropicEvent = false;
	let startedSynthetic = false;
	let sawMessageStop = false;
	let forwardToolStream = false;
	let pendingMessageStart = null;

	res.writeHead(200, {
		"Content-Type": "text/event-stream",
		"Cache-Control": "no-cache",
		Connection: "keep-alive",
		"Access-Control-Allow-Origin": "*",
	});

	const ensureSyntheticStart = () => {
		if (startedSynthetic || sawAnthropicEvent) return;
		startedSynthetic = true;
		sseWrite(res, "message_start", {
			type: "message_start",
			message: {
				id: mid,
				type: "message",
				role: "assistant",
				content: [],
				model,
				stop_reason: null,
				stop_sequence: null,
				usage: { input_tokens: 0, output_tokens: 0 },
			},
		});
		sseWrite(res, "content_block_start", {
			type: "content_block_start",
			index: 0,
			content_block: { type: "text", text: "" },
		});
	};

	try {
		const { provider, providerConfig, resp } =
			await callProvider(anthropicBody);
		await readProviderSSE(resp, provider, providerConfig, (payload) => {
			if (!payload || payload.kind === "ignore" || payload.kind === "done")
				return;
			if (payload.kind === "anthropic_event") {
				const event = payload.event;
				if (!event?.type) return;
				if (event.type === "message_start") {
					pendingMessageStart = event;
					return;
				}
				if (event.type === "content_block_start") {
					if (event.content_block?.type !== "tool_use") return;
					forwardToolStream = true;
					sawAnthropicEvent = true;
					if (pendingMessageStart) {
						sseWrite(res, pendingMessageStart.type, pendingMessageStart);
					}
					sseWrite(res, event.type, event);
					return;
				}
				if (!forwardToolStream) return;
				if (event.type === "message_stop") sawMessageStop = true;
				sseWrite(res, event.type, event);
				return;
			}
			if (
				(payload.kind === "final_result" || payload.kind === "raw_text") &&
				payload.text
			) {
				ensureSyntheticStart();
				sseWrite(res, "content_block_delta", {
					type: "content_block_delta",
					index: 0,
					delta: { type: "text_delta", text: payload.text },
				});
			}
		});
	} catch (err) {
		console.error("[proxy] stream error:", err.message);
		ensureSyntheticStart();
		sseWrite(res, "content_block_delta", {
			type: "content_block_delta",
			index: 0,
			delta: { type: "text_delta", text: `[Provider Error]: ${err.message}` },
		});
	}

	if (!sawAnthropicEvent && startedSynthetic) {
		sseWrite(res, "content_block_stop", {
			type: "content_block_stop",
			index: 0,
		});
		sseWrite(res, "message_delta", {
			type: "message_delta",
			delta: { stop_reason: "end_turn", stop_sequence: null },
			usage: { output_tokens: 0 },
		});
		sseWrite(res, "message_stop", { type: "message_stop" });
	} else if (sawAnthropicEvent && !sawMessageStop) {
		sseWrite(res, "message_stop", { type: "message_stop" });
	}
	res.end();
}

async function handleNonStream(anthropicBody, res) {
	const model = resolveModel(anthropicBody.model);
	const mid = generateId();
	let fullText = "";

	try {
		const { provider, providerConfig, resp } =
			await callProvider(anthropicBody);
		await readProviderSSE(resp, provider, providerConfig, (payload) => {
			if (!payload || payload.kind === "ignore" || payload.kind === "done")
				return;
			if (payload.kind === "anthropic_event") {
				if (
					payload.event?.type === "content_block_delta" &&
					payload.event?.delta?.type === "text_delta"
				) {
					fullText += payload.event.delta.text || "";
				}
				return;
			}
			if (payload.kind === "final_result" || payload.kind === "raw_text") {
				fullText += payload.text || "";
			}
		});
	} catch (err) {
		fullText = `[Provider Error]: ${err.message}`;
	}

	res.writeHead(200, {
		"Content-Type": "application/json",
		"Access-Control-Allow-Origin": "*",
	});
	res.end(
		JSON.stringify({
			id: mid,
			type: "message",
			role: "assistant",
			content: [{ type: "text", text: fullText }],
			model,
			stop_reason: "end_turn",
			stop_sequence: null,
			usage: { input_tokens: 0, output_tokens: 0 },
		}),
	);
}

function collectBody(req) {
	return new Promise((resolve, reject) => {
		const chunks = [];
		req.on("data", (c) => chunks.push(c));
		req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
		req.on("error", reject);
	});
}

const server = createServer(async (req, res) => {
	if (req.method === "OPTIONS") {
		res.writeHead(204, {
			"Access-Control-Allow-Origin": "*",
			"Access-Control-Allow-Methods": "POST, GET, OPTIONS",
			"Access-Control-Allow-Headers":
				"Content-Type, Authorization, X-API-Key, anthropic-version, x-stainless-os, x-stainless-lang, x-stainless-package-version, x-stainless-arch, x-stainless-runtime, x-stainless-runtime-version, x-stainless-retry-count",
			"Access-Control-Max-Age": "86400",
		});
		res.end();
		return;
	}

	const url = new URL(req.url, `http://127.0.0.1:${config.proxy_port || 8642}`);

	if (req.method === "GET" && url.pathname === "/health") {
		const { provider, providerConfig } = getRuntimeContext();
		const publicInfo = provider.getPublicInfo();
		res.writeHead(200, { "Content-Type": "application/json" });
		res.end(
			JSON.stringify({
				ok: true,
				service: "anthropic-compatible-proxy",
				provider: provider.name,
				has_session: publicInfo.has_session,
				model: providerConfig.default_model,
				upstream: publicInfo.upstream,
			}),
		);
		return;
	}

	if (req.method === "GET" && url.pathname === "/v1/models") {
		const { provider } = getRuntimeContext();
		res.writeHead(200, { "Content-Type": "application/json" });
		res.end(
			JSON.stringify({
				object: "list",
				data: provider.listModels().map((id) => ({
					id,
					object: "model",
					created: Date.now(),
					owned_by: provider.name,
				})),
			}),
		);
		return;
	}

	if (req.method === "POST" && url.pathname === "/v1/messages") {
		try {
			const raw = await collectBody(req);
			const body = JSON.parse(raw);
			const { providerConfig } = getRuntimeContext();
			if (providerConfig.log_requests)
				console.log(
					"[proxy] /v1/messages:",
					JSON.stringify(body).slice(0, 300),
				);
			if (body.stream) await handleStream(body, res);
			else await handleNonStream(body, res);
		} catch (err) {
			console.error("[proxy] error:", err);
			if (!res.headersSent) {
				res.writeHead(400, { "Content-Type": "application/json" });
				res.end(
					JSON.stringify({
						type: "error",
						error: { type: "invalid_request_error", message: err.message },
					}),
				);
			}
		}
		return;
	}

	if (req.method === "POST" && url.pathname === "/v1/chat/completions") {
		try {
			const raw = await collectBody(req);
			const body = JSON.parse(raw);
			const systemMsg = body.messages?.find((m) => m.role === "system");
			const anthropicBody = {
				model: body.model,
				messages: body.messages?.filter((m) => m.role !== "system") || [],
				system: systemMsg?.content,
				stream: body.stream,
				tools: body.tools || [],
			};
			if (body.stream) await handleStream(anthropicBody, res);
			else await handleNonStream(anthropicBody, res);
		} catch (err) {
			console.error("[proxy] error:", err);
			if (!res.headersSent) {
				res.writeHead(400, { "Content-Type": "application/json" });
				res.end(
					JSON.stringify({
						error: { message: err.message, type: "invalid_request_error" },
					}),
				);
			}
		}
		return;
	}

	if (req.method === "POST" && url.pathname === "/probe") {
		try {
			const raw = await collectBody(req);
			const { message: testMsg } = JSON.parse(raw || "{}");
			const { provider, providerConfig } = getRuntimeContext();
			const model = providerConfig.default_model || "gpt-5.4";
			const results = {};

			try {
				const content = testMsg || "hi, just say ok";
				const resp = await provider.call({
					anthropicBody: {
						messages: [{ role: "user", content }],
						system: "",
						tools: [],
					},
					model,
					content: `Human: ${content}`,
				});
				const ct = resp.headers.get("content-type") || "";
				let body = "";
				try {
					body = await resp.text();
				} catch {
					body = "[read error]";
				}
				results.completion = {
					ok: resp.ok,
					status: resp.status,
					contentType: ct,
					body: body.slice(0, 800),
				};
			} catch (e) {
				results.error = e.message;
			}

			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(JSON.stringify(results, null, 2));
		} catch (err) {
			res.writeHead(500, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ error: err.message }));
		}
		return;
	}

	res.writeHead(404, { "Content-Type": "application/json" });
	res.end(
		JSON.stringify({
			error: "Not found",
			endpoints: [
				"GET /health",
				"GET /v1/models",
				"POST /v1/messages",
				"POST /v1/chat/completions",
				"POST /probe",
			],
		}),
	);
});

const PORT = config.proxy_port || 8642;
server.listen(PORT, "127.0.0.1", () => {
	const { provider, providerConfig } = getRuntimeContext();
	const publicInfo = provider.getPublicInfo();
	console.log(`
╔════════════════════════════════════════════════════════╗
║        Provider → Anthropic-Compatible Proxy           ║
╠════════════════════════════════════════════════════════╣
║  http://127.0.0.1:${String(PORT).padEnd(37)}║
║  Provider:${provider.name.padStart(43)}║
║  Session: ${publicInfo.has_session ? "✅".padEnd(44) : "❌ configure provider credentials".padEnd(44)}║
║  Model:   ${(providerConfig.default_model || "gpt-5.4").padEnd(44)}║
║  Upstream:${String(publicInfo.upstream || "n/a").padStart(43)}║
╠════════════════════════════════════════════════════════╣
║  Usage with Claude Code:                               ║
║    ANTHROPIC_BASE_URL=http://127.0.0.1:${String(PORT).padEnd(17)}║
║    ANTHROPIC_API_KEY=dummy                             ║
║    claude                                              ║
╚════════════════════════════════════════════════════════╝
`);
});
