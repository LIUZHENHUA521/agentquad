import {
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
	readdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { createServer } from "../src/server.js";

describe("F2: loadConfig does not write on read", () => {
	let tmp;
	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "qt-cfg-noread-"));
	});
	afterEach(() => {
		try {
			rmSync(tmp, { recursive: true, force: true });
		} catch {}
	});

	it("mtime unchanged across 100 reads", async () => {
		const { loadConfig, saveConfig } = await import("../src/config.js");
		// Seed with a saved config so the first read isn't a "first run" write.
		saveConfig({ port: 1234 }, { rootDir: tmp });
		const file = join(tmp, "config.json");
		const m0 = statSync(file).mtimeMs;
		// Small delay so mtime resolution can't mask a write.
		await new Promise((r) => setTimeout(r, 20));
		for (let i = 0; i < 100; i++) loadConfig({ rootDir: tmp });
		const m1 = statSync(file).mtimeMs;
		expect(m1).toBe(m0);
	});

	it("still creates config.json on first run", async () => {
		const { loadConfig } = await import("../src/config.js");
		expect(existsSync(join(tmp, "config.json"))).toBe(false);
		loadConfig({ rootDir: tmp });
		expect(existsSync(join(tmp, "config.json"))).toBe(true);
	});

	it("still recovers from corrupt JSON and rewrites defaults", async () => {
		const { loadConfig } = await import("../src/config.js");
		writeFileSync(join(tmp, "config.json"), "{not json");
		const cfg = loadConfig({ rootDir: tmp });
		expect(cfg.port).toBe(5677);
		expect(existsSync(join(tmp, "config.json.corrupt"))).toBe(true);
		// new file is valid JSON
		const reparsed = JSON.parse(readFileSync(join(tmp, "config.json"), "utf8"));
		expect(reparsed.port).toBe(5677);
	});
});

describe("F3: atomic config writes", () => {
	let tmp;
	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "qt-cfg-atomic-"));
	});
	afterEach(() => {
		try {
			rmSync(tmp, { recursive: true, force: true });
		} catch {}
	});

	it("saveConfig leaves no .tmp files behind on success", async () => {
		const { saveConfig } = await import("../src/config.js");
		saveConfig({ port: 1234 }, { rootDir: tmp });
		const leftover = readdirSync(tmp).filter((f) => f.endsWith(".tmp"));
		expect(leftover).toEqual([]);
	});

	it("config.json is never corrupt after burst saves", async () => {
		const { saveConfig } = await import("../src/config.js");
		for (let i = 0; i < 20; i++) saveConfig({ port: 5000 + i }, { rootDir: tmp });
		// Final state must be valid JSON.
		const final = JSON.parse(readFileSync(join(tmp, "config.json"), "utf8"));
		expect(final.port).toBe(5019);
	});
});

describe("F4: in-process write serialization", () => {
	let tmp;
	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "qt-cfg-lock-"));
	});
	afterEach(() => {
		try {
			rmSync(tmp, { recursive: true, force: true });
		} catch {}
	});

	it("withConfigLock serializes async operations", async () => {
		const { withConfigLock } = await import("../src/config.js");
		const order = [];
		const work = async (id, delayMs) => {
			order.push(`start-${id}`);
			await new Promise((r) => setTimeout(r, delayMs));
			order.push(`end-${id}`);
			return id;
		};
		const results = await Promise.all([
			withConfigLock(() => work("a", 30)),
			withConfigLock(() => work("b", 5)),
			withConfigLock(() => work("c", 5)),
		]);
		expect(results).toEqual(["a", "b", "c"]);
		// strict alternation: a starts and ends before b starts, etc.
		expect(order).toEqual([
			"start-a",
			"end-a",
			"start-b",
			"end-b",
			"start-c",
			"end-c",
		]);
	});

	it("queue continues after a thrown error", async () => {
		const { withConfigLock } = await import("../src/config.js");
		const calls = [];
		const a = withConfigLock(async () => {
			calls.push("a");
			throw new Error("boom");
		}).catch((e) => e.message);
		const b = withConfigLock(async () => {
			calls.push("b");
			return "ok";
		});
		expect(await a).toBe("boom");
		expect(await b).toBe("ok");
		expect(calls).toEqual(["a", "b"]);
	});
});

describe("R6 / F1: PUT does not wipe pre-existing fields on empty-string", () => {
	let tmp, srv;
	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "qt-cfg-r6-"));
	});
	afterEach(async () => {
		if (srv) {
			try {
				await srv.close();
			} catch {}
			srv = null;
		}
		try {
			rmSync(tmp, { recursive: true, force: true });
		} catch {}
	});

	it("preserves Lark appId / chatId when patch contains empty strings", async () => {
		writeFileSync(
			join(tmp, "config.json"),
			JSON.stringify({
				lark: {
					enabled: true,
					appId: "cli_abc123",
					appSecret: "secret_xyz",
					chatId: "oc_chat_1",
				},
			}),
		);
		srv = createServer({ configRootDir: tmp });
		const r = await request(srv.app)
			.put("/api/config")
			.send({
				lark: {
					enabled: true,
					appId: "", // simulates Drawer form not initialized
					chatId: "",
					appSecret: "lark_***t_xyz", // mask string — already handled
				},
			});
		expect(r.status).toBe(200);
		const disk = JSON.parse(readFileSync(join(tmp, "config.json"), "utf8"));
		expect(disk.lark.appId).toBe("cli_abc123");
		expect(disk.lark.chatId).toBe("oc_chat_1");
		expect(disk.lark.appSecret).toBe("secret_xyz");
	});

	it("preserves Telegram supergroupId when patch contains empty string", async () => {
		writeFileSync(
			join(tmp, "config.json"),
			JSON.stringify({
				telegram: {
					enabled: true,
					botToken: "1234:realtoken_aaaaaaaa",
					supergroupId: "-1001234567890",
				},
			}),
		);
		srv = createServer({ configRootDir: tmp });
		const r = await request(srv.app)
			.put("/api/config")
			.send({
				telegram: {
					enabled: true,
					supergroupId: "",
				},
			});
		expect(r.status).toBe(200);
		const disk = JSON.parse(readFileSync(join(tmp, "config.json"), "utf8"));
		expect(disk.telegram.supergroupId).toBe("-1001234567890");
		expect(disk.telegram.botToken).toBe("1234:realtoken_aaaaaaaa");
	});

	it("explicit null still clears a field (escape hatch)", async () => {
		writeFileSync(
			join(tmp, "config.json"),
			JSON.stringify({
				lark: { enabled: true, appId: "cli_abc123", chatId: "oc_old" },
			}),
		);
		srv = createServer({ configRootDir: tmp });
		const r = await request(srv.app)
			.put("/api/config")
			.send({ lark: { chatId: null } });
		expect(r.status).toBe(200);
		const disk = JSON.parse(readFileSync(join(tmp, "config.json"), "utf8"));
		expect(disk.lark.chatId).toBe(""); // normalizeConfig coerces null → ""
		expect(disk.lark.appId).toBe("cli_abc123"); // untouched
	});

	it("burst of 5 sequential PUTs all land, last write wins", async () => {
		writeFileSync(
			join(tmp, "config.json"),
			JSON.stringify({ port: 5677, lark: { appId: "cli_abc123" } }),
		);
		srv = createServer({ configRootDir: tmp });
		for (let i = 0; i < 5; i++) {
			const r = await request(srv.app)
				.put("/api/config")
				.send({ port: 6000 + i });
			expect(r.status).toBe(200);
		}
		const disk = JSON.parse(readFileSync(join(tmp, "config.json"), "utf8"));
		expect(disk.port).toBe(6004);
		expect(disk.lark.appId).toBe("cli_abc123"); // unrelated section preserved
	});

	it("concurrent PUTs do not produce field-level interleaving", async () => {
		writeFileSync(join(tmp, "config.json"), JSON.stringify({ port: 5677 }));
		srv = createServer({ configRootDir: tmp });
		const payloads = Array.from({ length: 10 }, (_, i) => ({
			port: 7000 + i,
			defaultCwd: `/tmp/agent-${i}`,
		}));
		await Promise.all(
			payloads.map((p) =>
				request(srv.app).put("/api/config").send(p),
			),
		);
		const disk = JSON.parse(readFileSync(join(tmp, "config.json"), "utf8"));
		// final state must match exactly one of the payloads — port and
		// defaultCwd must come from the same payload, not a mix.
		const idx = disk.port - 7000;
		expect(idx).toBeGreaterThanOrEqual(0);
		expect(idx).toBeLessThan(10);
		expect(disk.defaultCwd).toBe(`/tmp/agent-${idx}`);
	});
});
