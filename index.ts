/**
 * pi-sidechat — Side Panel Messages for Pi
 * Main entry point - wires together all modules
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { Text } from "@earendil-works/pi-tui";
import { mkdirSync, writeFileSync, appendFileSync, existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir, homedir } from "node:os";
import { spawn } from "node:child_process";

// Module imports
import { getSettingsPath, loadSettings } from "./settings.js";
import { 
	openPanel, killPane, isPaneAlive, ensurePanelOpen, cleanupFiles,
	syncTodoPane, writeMessage, writeMessagePassthrough
} from "./panel.js";
import { scheduleAck, cancelAck, type AckCategory } from "./acks.js";
import { registerSidechatTodo } from "./todo.js";

export function shouldStartSidechatForPiInvocation(args = process.argv.slice(2), stdinIsTTY = process.stdin.isTTY): boolean {
	if (stdinIsTTY === false) return false;

	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		const next = args[i + 1];

		if (arg === "--" || arg === undefined) break;
		if (arg === "--print" || arg === "-p") return false;
		if (arg === "--help" || arg === "-h") return false;
		if (arg === "--version" || arg === "-v") return false;
		if (arg === "--list-models" || arg.startsWith("--list-models=")) return false;
		if (arg === "--export" || arg.startsWith("--export=")) return false;
		if (arg === "--mode") {
			if (next === "json" || next === "rpc") return false;
			if (next !== undefined) i++;
			continue;
		}
		if (arg.startsWith("--mode=")) {
			const mode = arg.slice("--mode=".length);
			if (mode === "json" || mode === "rpc") return false;
		}
	}

	return true;
}

function getSidechatRuntimeFile(): string {
	return join(homedir(), ".pi", "agent", "sidechat", "runtime.json");
}

function sanitizeSidechatNotification(text: string): string {
	return text.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "").trim();
}

function wrapPlainText(text: string, width: number): string[] {
	const lines: string[] = [];
	for (const paragraph of text.split("\n")) {
		if (!paragraph.trim()) { lines.push(""); continue; }
		let current = "";
		for (const word of paragraph.split(/\s+/)) {
			if (current && current.length + word.length + 1 > width) {
				lines.push(current);
				current = word;
			} else {
				current = current ? `${current} ${word}` : word;
			}
		}
		if (current) lines.push(current);
	}
	return lines;
}

function registerSpawnedAgentSidechatNotify(pi: ExtensionAPI, agentName: string) {
	pi.registerTool({
		name: "sidechat_notify",
		label: "Sidechat Notify",
		description: "Send a rare, important signed notification to the user's active Sidechat panel. Use only for blockers or important progress the user should see immediately; otherwise stay silent.",
		promptSnippet: "Send rare important notifications to the user's Sidechat panel",
		promptGuidelines: [
			"Use sidechat_notify only for genuinely important spawned-agent updates, blockers, or decisions needing user attention.",
			"Do not use it for routine progress, detailed reports, or final summaries unless the user explicitly needs immediate notification.",
			"Keep messages short. Normal team reports should go through team messaging, not Sidechat.",
		],
		parameters: Type.Object({
			message: Type.String({ description: "Short important notification for the user" }),
		}),
		async execute(_toolCallId, params: any) {
			const runtimeFile = getSidechatRuntimeFile();
			try {
				if (!existsSync(runtimeFile)) {
					return { content: [{ type: "text" as const, text: "Sidechat is not active." }], details: { delivered: false, reason: "missing_runtime" } };
				}
				const runtime = JSON.parse(readFileSync(runtimeFile, "utf-8"));
				if (!runtime?.active || !runtime?.paneId || !runtime?.messagesFile) {
					return { content: [{ type: "text" as const, text: "Sidechat is not active." }], details: { delivered: false, reason: "inactive" } };
				}

				const alive = await pi.exec("tmux", ["display-message", "-t", runtime.paneId, "-p", "#{pane_id}"]);
				if (alive.code !== 0 || alive.stdout.trim() !== runtime.paneId) {
					return { content: [{ type: "text" as const, text: "Sidechat panel is not available." }], details: { delivered: false, reason: "pane_unavailable" } };
				}

				const message = sanitizeSidechatNotification(String(params.message ?? ""));
				if (!message) throw new Error("message is required");

				const time = new Date().toLocaleTimeString("en-US", { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });
				const width = Math.max(20, Number(runtime.paneWidth) || 60);
				const prefix = `\x1b[36m[${sanitizeSidechatNotification(agentName)}]\x1b[0m - \x1b[2m${time}\x1b[0m: `;
				const wrapped = wrapPlainText(message, Math.max(20, width - 4));
				let out = "\n";
				wrapped.forEach((line, index) => {
					out += index === 0 ? `  ${prefix}${line}\n` : `  ${" ".repeat(agentName.length + 14)}${line}\n`;
				});
				out += "\n";
				appendFileSync(runtime.messagesFile, out);

				return { content: [{ type: "text" as const, text: "Notification sent to Sidechat." }], details: { delivered: true } };
			} catch (e) {
				return { content: [{ type: "text" as const, text: "Could not notify Sidechat." }], details: { delivered: false, error: e instanceof Error ? e.message : String(e) } };
			}
		},
		renderCall(_args, theme) {
			return new Text(theme.fg("toolTitle", theme.bold("sidechat_notify ")) + theme.fg("accent", "important update"), 0, 0);
		},
		renderResult(result, _options, theme) {
			const delivered = (result as any).details?.delivered;
			return new Text(theme.fg(delivered ? "success" : "warning", delivered ? "✓ notified" : "not sent"), 0, 0);
		},
	});
}

export default function (pi: ExtensionAPI) {

	// Spawned agents stay silent by default. They only get a restricted Sidechat notification tool.
	const spawnedAgentName = process.env.PI_AGENT_NAME || process.env.PI_TEAM_ROLE;
	if (spawnedAgentName) {
		registerSpawnedAgentSidechatNotify(pi, spawnedAgentName);
		return;
	}

	// Sidechat is an interactive tmux extension. Do not start it for print, JSON, RPC, help,
	// model listing, export, piped stdin, or any other CLI path that skips Pi's TUI.
	if (!shouldStartSidechatForPiInvocation()) return;

	// Sidechat requires tmux for the side panel.
	if (!process.env.TMUX) return;

	const { execFileSync } = require("node:child_process");

	// State variables
	let settings = loadSettings();
	let enabled = true;
	let paneId: string | null = null;
	let emotePaneId: string | null = null;
	let todoPaneId: string | null = null;
	let paneHidden = false;
	let paneWidth = 40;
	let lastMessageTime = { value: 0 };
	let lastAgentEndTime = { value: 0 };
	let interactionCount = { value: 0 };
	let lastAckCategory = { value: null as AckCategory | null };
	let lastAckIndex = { value: -1 };
	let ackTimer = { value: null as ReturnType<typeof setTimeout> | null };
	let hiddenStreamCopyActive = false;
	let hiddenStreamCopiedText = "";
	let visibleRouteTextByIndex = new Map<number, string>();
	let visibleRouteThinkingByIndex = new Map<number, string>();
	let lastUi: any = null;  // Cached UI reference for reactive status updates
	type SidechatMode = "offline" | "hidden" | "visible";
	const SIDECHAT_MODEL_TOOLS = ["todo"];
	const SIDECHAT_SIDEBAR_ASSISTANT_ENTRY = "sidechat-sidebar-assistant";
	let remoteControlSuspended = false;
	let sidechatToolsActiveBeforeHidden: Set<string> | null = null;

	// Capture our own tmux pane so all tmux commands target the correct window
	const ownerPaneId: string | null = process.env.TMUX_PANE ?? null;
	const commsDir = join(tmpdir(), `pi-sidechat-${process.pid}`);
	const messagesFile = join(commsDir, "messages.dat");
	const todosFile = join(commsDir, "todos.dat");
	const emoteFile = join(commsDir, "emote.dat");

	// Create commsDir early so log file works from the start
	mkdirSync(commsDir, { recursive: true });

	// Logging functions
	const logFile = join(commsDir, "sidechat.log");
	function log(msg: string) {
		try { appendFileSync(logFile, `${new Date().toISOString()} ${msg}\n`); } catch {}
	}
	log(`Sidechat starting: ownerPaneId=${ownerPaneId ?? "null"} pid=${process.pid}`);

	function logError(context: string, err: unknown): void {
		try {
			const msg = err instanceof Error ? err.message : String(err);
			log(`ERROR [${context}]: ${msg}`);
		} catch { /* absolute last resort — swallow silently */ }
	}

	function cleanupOldSidechatPanesInCurrentWindow(): void {
		try {
			if (!ownerPaneId || !process.env.TMUX) return;
			const panes = execFileSync("tmux", [
				"list-panes", "-t", ownerPaneId, "-F", "#{pane_id}\t#{pane_pid}\t#{pane_current_command}",
			], { encoding: "utf-8" });
			for (const line of String(panes).trim().split("\n")) {
				if (!line.trim()) continue;
				const [paneIdToCheck, panePid, paneCommand] = line.split("\t");
				if (!paneIdToCheck || !panePid || paneIdToCheck === ownerPaneId || paneCommand !== "perl") continue;
				let command = "";
				try {
					command = execFileSync("ps", ["-p", panePid, "-o", "command="], { encoding: "utf-8" }).trim();
				} catch {
					continue;
				}
				const isSidechatPane = command.includes("/pi-sidechat-") && (command.includes("/display.pl") || command.includes("/emote.pl") || command.includes("/todos.pl"));
				if (!isSidechatPane) continue;

				const isCurrentPane = command.includes(commsDir);
				const isEmptyCurrentTodoPane = isCurrentPane && command.includes("/todos.pl") && (() => {
					try { return !existsSync(todosFile) || readFileSync(todosFile, "utf-8").trim().length === 0; }
					catch { return true; }
				})();
				const isRetiredEmotePane = command.includes("/emote.pl");

				if (!isCurrentPane || isEmptyCurrentTodoPane || isRetiredEmotePane) {
					try {
						execFileSync("tmux", ["kill-pane", "-t", paneIdToCheck], { stdio: "ignore" });
						const reason = isRetiredEmotePane ? "retired emote" : isEmptyCurrentTodoPane ? "empty" : "stale";
						log(`Cleaned ${reason} Sidechat pane ${paneIdToCheck}`);
					} catch (err) {
						logError("cleanupOldSidechatPanes.kill", err);
					}
				}
			}
		} catch (err) {
			logError("cleanupOldSidechatPanes", err);
		}
	}

	cleanupOldSidechatPanesInCurrentWindow();

	// Helper functions
	function publishSidechatRuntimeState() {
		try {
			const runtimeFile = getSidechatRuntimeFile();
			mkdirSync(dirname(runtimeFile), { recursive: true });
			writeFileSync(runtimeFile, JSON.stringify({
				pid: process.pid,
				active: isSidechatActive(),
				mode: getSidechatMode(),
				paneId,
				messagesFile,
				paneWidth,
				updatedAt: new Date().toISOString(),
			}, null, 2) + "\n");
		} catch (e) { logError("publishSidechatRuntimeState", e); }
	}

	function publishSidechatPanelState() {
		publishSidechatRuntimeState();
	}

	async function publishSidechatTmuxOptions() {
		try {
			if (!ownerPaneId || !process.env.TMUX) return;
			const targets = [ownerPaneId, paneId].filter((id): id is string => Boolean(id));
			const options = ["@sidechat_emote_file", "@sidechat_comms_pane", "@sidechat_emote_pane"];
			for (const target of targets) {
				for (const option of options) {
					try { await pi.exec("tmux", ["set-option", "-p", "-u", "-t", target, option]); } catch {}
				}
			}
		} catch (e) { logError("publishSidechatTmuxOptions", e); }
	}

	async function announceSidechatPanelState() {
		await publishSidechatTmuxOptions();
		publishSidechatPanelState();
	}

	async function ensurePanelOpenWrapper(): Promise<boolean> {
		const result = await ensurePanelOpen(
			pi, settings, commsDir, messagesFile, todosFile, emoteFile, ownerPaneId,
			paneId, emotePaneId, todoPaneId, logError, log
		);
		if (result.success) {
			paneId = result.paneId;
			emotePaneId = result.emotePaneId;
			todoPaneId = result.todoPaneId;
			paneWidth = result.paneWidth;
			await announceSidechatPanelState();
		}
		return result.success;
	}

	function writeMessageWrapper(text: string, standalone = false) {
		writeMessage(text, messagesFile, paneWidth, settings, lastMessageTime, logError, standalone ? "standalone" : "normal");
	}

	function writeMessagePassthroughWrapper(text: string) {
		writeMessagePassthrough(text, messagesFile, paneWidth, logError);
	}

	function deliverAck(text: string): void {
		try {
			if (!isSidechatActive() || !isSidechatVisible()) return;
			void ensurePanelOpenWrapper().then((ok) => {
				try { if (ok) writeMessageWrapper(text, true); }
				catch (e) { logError("sidechat.deliverAck.write", e); }
			}).catch((e) => logError("sidechat.deliverAck.ensurePanel", e));
		} catch (e) { logError("sidechat.deliverAck", e); }
	}

	function syncTodoPaneWrapper(hasTodos: boolean) {
		void (async () => {
			try {
				if (!isSidechatActive()) return;
				if (hasTodos && (!paneId || !(await isPaneAlive(pi, paneId, log)))) {
					const result = await openPanel(pi, settings, commsDir, messagesFile, todosFile, emoteFile, ownerPaneId, logError, log);
					if (result.success) {
						paneId = result.paneId;
						emotePaneId = result.emotePaneId;
						todoPaneId = result.todoPaneId;
						paneWidth = result.paneWidth;
						await announceSidechatPanelState();
						await keepSidechatPanelHidden();
					}
					return;
				}
				todoPaneId = await syncTodoPane(pi, commsDir, todosFile, paneId, todoPaneId, logError);
				if (emotePaneId && (await isPaneAlive(pi, emotePaneId, log))) await killPane(pi, emotePaneId);
				emotePaneId = null;
				await announceSidechatPanelState();
				await keepSidechatPanelHidden();
			} catch (e) { logError("syncTodoPaneWrapper", e); }
		})();
	}

	registerSidechatTodo(pi, {
		todosFile,
		logError,
		onTodoVisibilityChange: syncTodoPaneWrapper,
		isEnabled: () => isSidechatVisible(),
	});

	// Status helpers
	function updateStatus(ui?: any) {
		try {
			const ctx = ui ?? lastUi;
			if (!ctx) return;
			if (ui) lastUi = ui;  // Cache for reactive updates
			ctx.setStatus("sidechat", undefined);
		} catch (e) { logError("updateStatus", e); }
	}

	function isSidechatActive(): boolean {
		return enabled && !remoteControlSuspended;
	}

	function getSidechatMode(): SidechatMode {
		if (!isSidechatActive()) return "offline";
		return paneHidden ? "hidden" : "visible";
	}

	function isSidechatVisible(): boolean {
		return getSidechatMode() === "visible";
	}

	function getSidechatControlState() {
		return {
			enabled,
			active: isSidechatActive(),
			suspended: remoteControlSuspended,
			paneOpen: Boolean(paneId),
			paneHidden,
			todoPaneOpen: Boolean(todoPaneId),
		};
	}

	function formatSidechatControlState(prefix: string): string {
		const state = getSidechatControlState();
		const activeText = state.active ? "active" : state.suspended ? "suspended" : "offline";
		return `${prefix}: Sidechat is ${activeText}.`;
	}

	function getRegisteredSidechatModelTools(): string[] {
		try {
			const api = pi as any;
			if (typeof api.getAllTools !== "function") return [...SIDECHAT_MODEL_TOOLS];
			const registered = new Set(api.getAllTools().map((tool: any) => tool?.name).filter((name: unknown): name is string => typeof name === "string"));
			return SIDECHAT_MODEL_TOOLS.filter((name) => registered.has(name));
		} catch (e) {
			logError("sidechat.getRegisteredTools", e);
			return [...SIDECHAT_MODEL_TOOLS];
		}
	}

	// Hide Sidechat model tools whenever Sidechat should not steer the next turn
	// (hidden, disabled, or suspended). Closing or zooming the panel is not enough:
	// active tools are captured before before_agent_start runs.
	function deactivateSidechatTools(context: string, restoreRegisteredSidechatTools = false) {
		try {
			const api = pi as any;
			if (typeof api.getActiveTools !== "function" || typeof api.setActiveTools !== "function") return;
			const activeTools = api.getActiveTools();
			if (!Array.isArray(activeTools)) return;
			if (!sidechatToolsActiveBeforeHidden) {
				const restoreTools = restoreRegisteredSidechatTools
					? getRegisteredSidechatModelTools()
					: SIDECHAT_MODEL_TOOLS.filter((name) => activeTools.includes(name));
				sidechatToolsActiveBeforeHidden = new Set(restoreTools);
			}
			api.setActiveTools(activeTools.filter((name: string) => !SIDECHAT_MODEL_TOOLS.includes(name)));
		} catch (e) { logError(`${context}.disableTools`, e); }
	}

	function reactivateSidechatTools(context: string) {
		try {
			const api = pi as any;
			if (!sidechatToolsActiveBeforeHidden || typeof api.getActiveTools !== "function" || typeof api.setActiveTools !== "function") return;
			const activeTools = api.getActiveTools();
			if (!Array.isArray(activeTools)) return;
			const registeredSidechatTools = new Set(getRegisteredSidechatModelTools());
			const nextTools = [...activeTools];
			for (const name of sidechatToolsActiveBeforeHidden) {
				if (registeredSidechatTools.has(name) && !nextTools.includes(name)) nextTools.push(name);
			}
			api.setActiveTools(nextTools);
			sidechatToolsActiveBeforeHidden = null;
		} catch (e) { logError(`${context}.restoreTools`, e); }
	}

	async function closeSidechatPanes() {
		try {
			try { mkdirSync(commsDir, { recursive: true }); writeFileSync(todosFile, "", "utf-8"); } catch {}
			if (todoPaneId && (await isPaneAlive(pi, todoPaneId, log))) await killPane(pi, todoPaneId);
			todoPaneId = null;
			if (emotePaneId && (await isPaneAlive(pi, emotePaneId, log))) await killPane(pi, emotePaneId);
			emotePaneId = null;
			if (paneId && (await isPaneAlive(pi, paneId, log))) await killPane(pi, paneId);
			paneId = null;
			paneHidden = false;
			publishSidechatPanelState();
		} catch (e) { logError("sidechat.closePanes", e); }
	}

	async function isOwnerWindowZoomed(): Promise<boolean> {
		try {
			if (!ownerPaneId || !process.env.TMUX) return false;
			const result = await pi.exec("tmux", ["display-message", "-t", ownerPaneId, "-p", "#{window_zoomed_flag}"]);
			return result.code === 0 && result.stdout.trim() === "1";
		} catch (e) {
			logError("sidechat.isOwnerWindowZoomed", e);
			return false;
		}
	}

	async function keepSidechatPanelHidden(): Promise<void> {
		try {
			if (!paneHidden || !ownerPaneId || !process.env.TMUX) return;
			if (!(await isOwnerWindowZoomed())) await pi.exec("tmux", ["resize-pane", "-Z", "-t", ownerPaneId]);
		} catch (e) { logError("sidechat.keepPanelHidden", e); }
	}

	async function writeHiddenPanelCopy(message: string, newTopic?: boolean): Promise<void> {
		try {
			if (!isSidechatActive()) return;
			if (newTopic) lastMessageTime.value = 0;
			if (!paneId || !(await isPaneAlive(pi, paneId, log))) {
				const opened = await ensurePanelOpenWrapper();
				if (!opened) return;
			}
			writeMessagePassthroughWrapper(message);
			await keepSidechatPanelHidden();
		} catch (e) { logError("sidechat.writeHiddenPanelCopy", e); }
	}

	async function beginHiddenStreamCopy(): Promise<void> {
		try {
			if (!paneHidden || !isSidechatActive()) return;
			if (!paneId || !(await isPaneAlive(pi, paneId, log))) {
				const opened = await ensurePanelOpenWrapper();
				if (!opened) return;
			}
			hiddenStreamCopyActive = true;
			hiddenStreamCopiedText = "";
			appendFileSync(messagesFile, "\n\x1b[38;5;249m  ");
			await keepSidechatPanelHidden();
		} catch (e) { logError("sidechat.beginHiddenStreamCopy", e); }
	}

	function appendHiddenStreamDelta(delta: string): void {
		try {
			if (!hiddenStreamCopyActive || !delta) return;
			hiddenStreamCopiedText += delta;
			appendFileSync(messagesFile, delta.replace(/\n/g, "\n  "));
		} catch (e) { logError("sidechat.appendHiddenStreamDelta", e); }
	}

	async function endHiddenStreamCopy(finalText: string): Promise<void> {
		try {
			if (!hiddenStreamCopyActive) {
				if (finalText.trim()) await writeHiddenPanelCopy(finalText);
				return;
			}
			hiddenStreamCopyActive = false;
			appendFileSync(messagesFile, "\x1b[0m\n");
			if (!hiddenStreamCopiedText.trim() && finalText.trim()) await writeHiddenPanelCopy(finalText);
			hiddenStreamCopiedText = "";
			await keepSidechatPanelHidden();
		} catch (e) { logError("sidechat.endHiddenStreamCopy", e); }
	}

	async function toggleSidechatPanelVisibility(ui?: any): Promise<void> {
		try {
			if (!isSidechatActive()) {
				ui?.notify(`${settings.name} is not active`, "info");
				return;
			}
			if (!ownerPaneId || !process.env.TMUX) {
				ui?.notify("Sidechat panel toggle requires tmux", "error");
				return;
			}

			if (await isOwnerWindowZoomed()) {
				await pi.exec("tmux", ["resize-pane", "-Z", "-t", ownerPaneId]);
				paneHidden = false;
				reactivateSidechatTools("panelVisible");
				if (!paneId || !(await isPaneAlive(pi, paneId))) await ensurePanelOpenWrapper();
				publishSidechatPanelState();
				updateStatus(ui);
				ui?.notify("Sidechat panel shown", "info");
				return;
			}

			if (!paneId || !(await isPaneAlive(pi, paneId))) {
				const opened = await ensurePanelOpenWrapper();
				paneHidden = false;
				reactivateSidechatTools("panelVisible");
				publishSidechatPanelState();
				updateStatus(ui);
				ui?.notify(opened ? "Sidechat panel shown" : "Could not open Sidechat panel", opened ? "info" : "error");
				return;
			}

			paneHidden = true;
			deactivateSidechatTools("panelHidden");
			await keepSidechatPanelHidden();
			publishSidechatPanelState();
			updateStatus(ui);
			ui?.notify("Sidechat panel hidden", "info");
		} catch (e) {
			logError("sidechat.togglePanelVisibility", e);
			ui?.notify("Could not toggle Sidechat panel", "error");
		}
	}

	async function suspendSidechatForRemoteControl() {
		try {
			if (remoteControlSuspended) return;
			remoteControlSuspended = true;
			deactivateSidechatTools("remoteControl");
			await closeSidechatPanes();
			updateStatus();
			log("Sidechat suspended for remote control");
		} catch (e) { logError("remoteControl.suspend", e); }
	}

	function resumeSidechatAfterRemoteControl() {
		try {
			if (!remoteControlSuspended) return;
			remoteControlSuspended = false;
			// Only bring the tools back if Sidechat itself is enabled — it may
			// have been disabled (e.g. learn-french study mode) while suspended.
			if (enabled) reactivateSidechatTools("remoteControl");
			updateStatus();
			log("Sidechat resumed after remote control");
		} catch (e) { logError("remoteControl.resume", e); }
	}

	async function setSidechatEnabled(nextEnabled: boolean, source: string, ui?: any): Promise<void> {
		try {
			if (enabled === nextEnabled) {
				if (!nextEnabled) {
					deactivateSidechatTools(source);
					await closeSidechatPanes();
				} else if (isSidechatActive()) {
					reactivateSidechatTools(source);
					await ensurePanelOpenWrapper();
				} else {
					await announceSidechatPanelState();
				}
				updateStatus(ui);
				return;
			}

			enabled = nextEnabled;
			if (!enabled) {
				deactivateSidechatTools(source);
				await closeSidechatPanes();
				updateStatus(ui);
				log(`Sidechat disabled by ${source}`);
				return;
			}

			settings = loadSettings();
			if (isSidechatActive()) reactivateSidechatTools(source);
			updateStatus(ui);
			if (isSidechatActive()) await ensurePanelOpenWrapper();
			else await announceSidechatPanelState();
			log(`Sidechat enabled by ${source}`);
		} catch (e) { logError(`${source}.setSidechatEnabled`, e); }
	}

	function sidechatEventSource(data: unknown): string {
		if (data && typeof data === "object" && typeof (data as any).source === "string") return `event:${(data as any).source}`;
		return "event";
	}

	function sidechatEventEnabledValue(data: unknown): boolean | undefined {
		if (typeof data === "boolean") return data;
		if (data && typeof data === "object" && typeof (data as any).enabled === "boolean") return (data as any).enabled;
		return undefined;
	}

	pi.events.on("remote-control:enabled", () => { void suspendSidechatForRemoteControl(); });
	pi.events.on("remote-control:disabled", () => { resumeSidechatAfterRemoteControl(); });
	pi.events.on("remote-control:disconnected", () => { resumeSidechatAfterRemoteControl(); });
	pi.events.on("sidechat:disable", (data) => { void setSidechatEnabled(false, sidechatEventSource(data)); });
	pi.events.on("sidechat:enable", (data) => { void setSidechatEnabled(true, sidechatEventSource(data)); });
	pi.events.on("sidechat:set-enabled", (data) => {
		const nextEnabled = sidechatEventEnabledValue(data);
		if (nextEnabled === undefined) {
			log("sidechat:set-enabled ignored: missing boolean enabled value");
			return;
		}
		void setSidechatEnabled(nextEnabled, sidechatEventSource(data));
	});
	pi.on("agent_end", async () => {
		try { lastAgentEndTime.value = Date.now(); }
		catch (e) { logError("sidechat.agentEnd", e); }
	});

	// Custom Tool: sidechat_control
	pi.registerTool({
		name: "sidechat_control",
		label: "Sidechat",
		description: "Enable, disable, or inspect Sidechat. Other extensions can also emit sidechat:disable, sidechat:enable, or sidechat:set-enabled events.",
		promptSnippet: "Enable, disable, or inspect the Sidechat communications panel",
		promptGuidelines: [
			"Use sidechat_control when the user asks to enable, disable, turn off, turn on, or inspect Sidechat.",
			"Use sidechat_control with action=status before changing Sidechat if the user only asks whether Sidechat is active.",
		],
		parameters: Type.Object({
			action: Type.String({ description: "One of: enable, disable, status" }),
			reason: Type.Optional(Type.String({ description: "Optional source or reason for the state change" })),
		}),
		async execute(_toolCallId, params: any) {
			const requestedAction = String(params.action ?? "").trim().toLowerCase();
			const action = requestedAction === "on" ? "enable" : requestedAction === "off" ? "disable" : requestedAction;
			const source = typeof params.reason === "string" && params.reason.trim()
				? `tool:${params.reason.trim()}`
				: "tool";

			if (action === "enable") {
				await setSidechatEnabled(true, source);
			} else if (action === "disable") {
				await setSidechatEnabled(false, source);
			} else if (action !== "status") {
				throw new Error(`unknown sidechat_control action: ${params.action}`);
			}

			return {
				content: [{ type: "text" as const, text: formatSidechatControlState(action) }],
				details: { action, requestedAction, state: getSidechatControlState() },
			};
		},
		renderCall(args, theme) {
			const action = String((args as any)?.action ?? "status");
			return new Text(theme.fg("toolTitle", theme.bold("sidechat_control ")) + theme.fg("accent", action), 0, 0);
		},
		renderResult(result, _options, theme) {
			const state = (result as any).details?.state;
			const active = state?.active ? "active" : state?.suspended ? "suspended" : "offline";
			return new Text(theme.fg(state?.active ? "success" : "warning", `Sidechat ${active}`), 0, 0);
		},
	});

	// Event handlers and commands
	function buildSidechatProtocolPrompt(): string {
		return `

## Sidechat Protocol

When Sidechat is visible, route only conversational side-channel prose by wrapping it in <msg>...</msg> tags.

Everything outside <msg> tags is rendered in the main Pi transcript. Put code blocks, markdown artifacts, tables, diffs, command output, file contents, images, checklists, instructions, and reference material outside <msg> tags.

Use <msg> for short acknowledgments, summaries, commentary, or framing that belongs in the side panel. If the response is only code or structured content, omit <msg>. Do not explain the tags to the user.`;
	}

	pi.on("before_agent_start", async (event) => {
		try {
			if (!isSidechatActive()) return;
			if (!isSidechatVisible()) {
				if (paneHidden) deactivateSidechatTools("beforeAgentStartHidden", true);
				return;
			}
			const prompt = typeof (event as any).prompt === "string" ? (event as any).prompt : "";
			scheduleAck(
				prompt, settings, ackTimer, lastAgentEndTime,
				interactionCount, lastAckCategory, lastAckIndex,
				deliverAck, logError,
			);
			return { systemPrompt: event.systemPrompt + buildSidechatProtocolPrompt() };
		} catch (e) { logError("before_agent_start", e); }
	});

	function extractAssistantText(message: any): string {
		const textParts: string[] = [];
		for (const block of message?.content ?? []) {
			if (block.type === "text" && block.text?.trim()) {
				textParts.push(block.text.trim());
			}
		}
		return textParts.join("\n\n");
	}

	function hasRenderableMainContent(message: any): boolean {
		for (const block of message?.content ?? []) {
			if (block.type === "text" && block.text?.trim()) return true;
			if (block.type !== "text" && block.type !== "thinking") return true;
		}
		return false;
	}

	function rememberSidebarAssistantMessage(message: any): void {
		try {
			pi.appendEntry(SIDECHAT_SIDEBAR_ASSISTANT_ENTRY, { message });
		} catch (e) { logError("sidechat.rememberSidebarAssistantMessage", e); }
	}

	function stripSidechatTags(text: string, stripTrailingPartialTag = false): string {
		let out = "";
		let inFence = false;
		for (let i = 0; i < text.length;) {
			if (text.startsWith("```", i)) {
				inFence = !inFence;
				out += "```";
				i += 3;
				continue;
			}
			if (!inFence && text.slice(i, i + 5).toLowerCase() === "<msg>") {
				i += 5;
				continue;
			}
			if (!inFence && text.slice(i, i + 6).toLowerCase() === "</msg>") {
				i += 6;
				continue;
			}
			out += text[i];
			i++;
		}
		if (stripTrailingPartialTag) out = out.replace(/<\/?m?s?g?$/i, "");
		return out;
	}

	function stripSidechatTagsFromMessage(message: any, stripTrailingPartialTag = false): any {
		return {
			...message,
			content: (message?.content ?? []).map((block: any) => {
				if (block.type === "text") return { ...block, text: stripSidechatTags(block.text ?? "", stripTrailingPartialTag) };
				return block;
			}),
		};
	}

	function splitTextForSidechat(text: string): { sidebarText: string; mainText: string } {
		let sidebarText = "";
		let mainText = "";
		let inFence = false;
		let inMsg = false;

		for (let i = 0; i < text.length;) {
			if (text.startsWith("```", i)) {
				inFence = !inFence;
				if (inMsg) sidebarText += "```";
				else mainText += "```";
				i += 3;
				continue;
			}
			if (!inFence && text.slice(i, i + 5).toLowerCase() === "<msg>") {
				inMsg = true;
				i += 5;
				continue;
			}
			if (!inFence && text.slice(i, i + 6).toLowerCase() === "</msg>") {
				inMsg = false;
				i += 6;
				continue;
			}
			if (inMsg) sidebarText += text[i];
			else mainText += text[i];
			i++;
		}

		return {
			sidebarText: sidebarText.trim(),
			mainText: mainText.trim(),
		};
	}

	function routeAssistantMessageForSidechat(message: any): { sidebarText: string; mainMessage: any } {
		const sidebarParts: string[] = [];
		const mainContent = (message?.content ?? []).map((block: any) => {
			if (block.type !== "text") {
				if (block.type === "thinking") return { ...block, thinking: "" };
				return block;
			}

			const routed = splitTextForSidechat(block.text ?? "");
			if (routed.sidebarText) sidebarParts.push(routed.sidebarText);
			return { ...block, text: routed.mainText };
		});

		return {
			sidebarText: sidebarParts.join("\n\n").trim(),
			mainMessage: { ...message, content: mainContent },
		};
	}

	function suppressAssistantTextInPlace(message: any): void {
		try {
			message.content = (message?.content ?? []).map((block: any) =>
				block && typeof block === "object" ? { ...block } : block,
			);
			for (const block of message.content) {
				if (block.type === "text") block.text = "";
				else if (block.type === "thinking") block.thinking = "";
			}
		} catch (e) { logError("sidechat.suppressAssistantTextInPlace", e); }
	}

	function replaceAssistantContentInPlace(message: any, replacement: any): void {
		try {
			message.content = replacement.content;
		} catch (e) { logError("sidechat.replaceAssistantContentInPlace", e); }
	}

	function restoreVisibleRoutedAssistantMessage(message: any): any {
		const restoredContent = (message?.content ?? []).map((block: any, index: number) => {
			if (block.type === "text") return { ...block, text: visibleRouteTextByIndex.get(index) ?? block.text ?? "" };
			if (block.type === "thinking") return { ...block, thinking: visibleRouteThinkingByIndex.get(index) ?? block.thinking ?? "" };
			return block;
		});

		for (const [index, text] of [...visibleRouteTextByIndex.entries()].sort(([a], [b]) => a - b)) {
			if (!restoredContent[index]) restoredContent[index] = { type: "text", text };
		}
		for (const [index, thinking] of [...visibleRouteThinkingByIndex.entries()].sort(([a], [b]) => a - b)) {
			if (!restoredContent[index]) restoredContent[index] = { type: "thinking", thinking };
		}

		return { ...message, content: restoredContent };
	}

	function resetVisibleRouteBuffers(): void {
		visibleRouteTextByIndex = new Map<number, string>();
		visibleRouteThinkingByIndex = new Map<number, string>();
	}

	function captureVisibleRouteSnapshot(message: any): void {
		try {
			(message?.content ?? []).forEach((block: any, index: number) => {
				if (block.type === "text" && typeof block.text === "string" && block.text.length > 0) {
					visibleRouteTextByIndex.set(index, block.text);
				} else if (block.type === "thinking" && typeof block.thinking === "string" && block.thinking.length > 0) {
					visibleRouteThinkingByIndex.set(index, block.thinking);
				}
			});
		} catch (e) { logError("sidechat.captureVisibleRouteSnapshot", e); }
	}

	function captureVisibleRouteDelta(assistantEvent: any): boolean {
		try {
			const index = Number(assistantEvent?.contentIndex ?? 0);
			if (!Number.isInteger(index) || index < 0) return false;
			if (assistantEvent.type === "text_delta" && typeof assistantEvent.delta === "string") {
				visibleRouteTextByIndex.set(index, (visibleRouteTextByIndex.get(index) ?? "") + assistantEvent.delta);
				return true;
			} else if (assistantEvent.type === "text_end" && typeof assistantEvent.content === "string") {
				visibleRouteTextByIndex.set(index, assistantEvent.content);
				return true;
			} else if (assistantEvent.type === "thinking_delta" && typeof assistantEvent.delta === "string") {
				visibleRouteThinkingByIndex.set(index, (visibleRouteThinkingByIndex.get(index) ?? "") + assistantEvent.delta);
				return true;
			} else if (assistantEvent.type === "thinking_end" && typeof assistantEvent.content === "string") {
				visibleRouteThinkingByIndex.set(index, assistantEvent.content);
				return true;
			}
		} catch (e) { logError("sidechat.captureVisibleRouteDelta", e); }
		return false;
	}

	function sidebarAssistantRestorations(ctx: any): Map<number, any> {
		const restored = new Map<number, any>();
		try {
			for (const entry of ctx.sessionManager.getEntries()) {
				if (entry?.type !== "custom" || entry?.customType !== SIDECHAT_SIDEBAR_ASSISTANT_ENTRY) continue;
				const message = entry?.data?.message;
				if (message?.role === "assistant" && typeof message.timestamp === "number") {
					restored.set(message.timestamp, message);
				}
			}
		} catch (e) { logError("sidechat.sidebarAssistantRestorations", e); }
		return restored;
	}

	pi.on("context", async (event, ctx) => {
		try {
			const restored = sidebarAssistantRestorations(ctx);
			if (restored.size === 0) return;
			let changed = false;
			const messages = event.messages.map((message: any) => {
				if (message?.role !== "assistant" || typeof message.timestamp !== "number") return message;
				const original = restored.get(message.timestamp);
				if (!original) return message;
				changed = true;
				return original;
			});
			if (changed) return { messages };
		} catch (e) { logError("sidechat.contextRestore", e); }
	});

	pi.on("message_start", async (event) => {
		try {
			const msg = event.message;
			if (!msg || msg.role !== "assistant") return;
			resetVisibleRouteBuffers();
			if (isSidechatActive() && !paneHidden) {
				captureVisibleRouteSnapshot(msg);
				suppressAssistantTextInPlace(msg);
			} else replaceAssistantContentInPlace(msg, stripSidechatTagsFromMessage(msg, true));
		} catch (e) { logError("message_start.route", e); }
	});

	pi.on("message_update", async (event) => {
		try {
			const msg = event.message;
			if (!msg || msg.role !== "assistant") return;
			const assistantEvent = (event as any).assistantMessageEvent;
			const capturedDelta = captureVisibleRouteDelta(assistantEvent);
			if (isSidechatActive() && !paneHidden) {
				if (!capturedDelta) captureVisibleRouteSnapshot(msg);
				suppressAssistantTextInPlace(msg);
				return;
			}
			replaceAssistantContentInPlace(msg, stripSidechatTagsFromMessage(restoreVisibleRoutedAssistantMessage(msg), true));
		} catch (e) { logError("message_update.route", e); }
	});

	// Move <msg> content to Sidechat when the panel is visible. When Sidechat is
	// hidden or disabled, strip the tags and keep their content in the main window.
	pi.on("message_end", async (event) => {
		try {
			const msg = event.message;
			if (!msg || msg.role !== "assistant") return;

			if (!isSidechatActive() || paneHidden) {
				const cleanedMessage = stripSidechatTagsFromMessage(restoreVisibleRoutedAssistantMessage(msg));
				const text = extractAssistantText(cleanedMessage);
				if (text) cancelAck(ackTimer);
				if (isSidechatActive() && paneHidden && text) await writeHiddenPanelCopy(text);
				resetVisibleRouteBuffers();
				return { message: cleanedMessage };
			}

			const restoredMessage = restoreVisibleRoutedAssistantMessage(msg);
			const routed = routeAssistantMessageForSidechat(restoredMessage);
			const mainText = extractAssistantText(routed.mainMessage);
			if (routed.sidebarText || mainText) cancelAck(ackTimer);
			resetVisibleRouteBuffers();
			if (routed.sidebarText) {
				const ok = await ensurePanelOpenWrapper();
				if (ok) writeMessageWrapper(routed.sidebarText);
				else return { message: stripSidechatTagsFromMessage(restoredMessage) };
			}

			rememberSidebarAssistantMessage(restoredMessage);
			if (routed.sidebarText && !hasRenderableMainContent(routed.mainMessage)) {
				return { message: stripSidechatTagsFromMessage(restoredMessage) };
			}
			return { message: routed.mainMessage };
		} catch (e) { logError("message_end.sidebarRoute", e); }
	});

	// Commands and shortcuts
	pi.registerCommand("sidechat", {
		description: "Usage: /sidechat [settings|log]",
		handler: async (args, ctx) => {
			try {
				const arg = (args ?? "").trim().toLowerCase();

				if (remoteControlSuspended) {
					ctx.ui.notify(`${settings.name} is suspended while remote control is active`, "info");
					return;
				}

				if (arg === "settings") {
					settings = loadSettings();
					const info = [
						`Name: ${settings.name}`,
						`Panel width: ${settings.panelWidth}%`,
						`Typewriter: ${settings.typewriter.enabled ? "on" : "off"}`,
						`Ack messages: ${settings.acks.enabled ? `on (${settings.acks.delayMs}ms)` : "off"}`,
						`Settings file: ${getSettingsPath()}`,
					].join("\n");
					ctx.ui.notify(info, "info");
					return;
				}

				if (arg === "log") {
					if (existsSync(logFile)) {
						const { readFileSync } = require("node:fs");
						const content = readFileSync(logFile, "utf-8");
						const lines = content.trim().split("\n");
						const tail = lines.slice(-30).join("\n");
						ctx.ui.notify(`Sidechat log (last 30 lines):\n${tail}`, "info");
					} else {
						ctx.ui.notify(`No log file at ${logFile}`, "info");
					}
					return;
				}

				const nextEnabled = !enabled;
				await setSidechatEnabled(nextEnabled, "command", ctx.ui);
				ctx.ui.notify(nextEnabled ? `${settings.name} online` : `${settings.name} offline`, "info");
			} catch (e) { logError("command.sidechat", e); }
		},
	});

	pi.registerShortcut("alt+tab", {
		description: "Show/hide Sidechat panel",
		handler: async (ctx) => {
			try {
				await toggleSidechatPanelVisibility(ctx.ui);
			} catch (e) { logError("shortcut.alt+tab", e); }
		},
	});

	// Cleanup
	pi.on("session_shutdown", async (event) => {
		try {
			if (paneHidden && (event as any)?.reason === "reload") {
				paneId = null;
				emotePaneId = null;
				todoPaneId = null;
				log("Sidechat hidden during reload; leaving tmux panes zoom-hidden for next runtime");
				return;
			}

			if (todoPaneId) {
				const p = spawn("tmux", ["kill-pane", "-t", todoPaneId], { stdio: "ignore" });
				p.unref();
				todoPaneId = null;
			}
			if (emotePaneId) {
				const p = spawn("tmux", ["kill-pane", "-t", emotePaneId], { stdio: "ignore" });
				p.unref();
				emotePaneId = null;
			}
			if (paneId) {
				const p = spawn("tmux", ["kill-pane", "-t", paneId], { stdio: "ignore" });
				p.unref();
				paneId = null;
			}
		} catch (e) { logError("shutdown.killPane", e); }
	});

	// Set initial status
	pi.on("session_start", async (_event, ctx) => {
		try {
			settings = loadSettings();

			paneHidden = isSidechatActive() && (await isOwnerWindowZoomed());
			if (paneHidden) {
				deactivateSidechatTools("sessionStartHidden", true);
				await announceSidechatPanelState();
			} else if (isSidechatActive()) {
				reactivateSidechatTools("sessionStartVisible");
				await ensurePanelOpenWrapper();
			} else {
				await announceSidechatPanelState();
			}
			updateStatus(ctx.ui);
		} catch (e) { logError("session_start", e); }
	});
}