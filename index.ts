/**
 * F.R.I.D.A.Y. — Voice-enabled Communications Panel
 * Main entry point - wires together all modules
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { Text } from "@earendil-works/pi-tui";
import { mkdirSync, writeFileSync, appendFileSync, existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir, homedir } from "node:os";
import { spawn, type ChildProcess } from "node:child_process";

// Module imports
import { getSettingsPath, loadSettings, saveSettings, type FridaySettings } from "./settings.js";
import { 
	killCurrentVoice, killOrphanTTS, speakText, enqueueVoiceWithMessage, 
	processVoiceQueueSynced, deriveVoiceText, setLogFunctions,
	voiceQueue, voicePlaying 
} from "./voice.js";
import { 
	openPanel, killPane, isPaneAlive, ensurePanelOpen, cleanupFiles,
	syncTodoPane, writeMessage, writeMessagePassthrough
} from "./panel.js";
import { 
	killOrphanDaemons, startWakeDaemon, stopWakeDaemon, startWakeWatcher, 
	stopWakeWatcher, handleWakeCommand, isDaemonAlive 
} from "./daemon.js";
import { scheduleAck, cancelAck, showAndSpeak, loadVoiceAcks } from "./acks.js";
import { buildSystemPrompt } from "./prompt.js";
import { registerFridayTodo } from "./todo.js";

export function shouldStartFridayForPiInvocation(args = process.argv.slice(2), stdinIsTTY = process.stdin.isTTY): boolean {
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

function getFridayRuntimeFile(): string {
	return join(homedir(), ".pi", "agent", "friday", "runtime.json");
}

function sanitizeFridayNotification(text: string): string {
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

function registerSpawnedAgentFridayNotify(pi: ExtensionAPI, agentName: string) {
	pi.registerTool({
		name: "friday_notify",
		label: "Friday Notify",
		description: "Send a rare, important signed notification to the user's active Friday panel. Use only for blockers or important progress the user should see immediately; otherwise stay silent.",
		promptSnippet: "Send rare important notifications to the user's Friday panel",
		promptGuidelines: [
			"Use friday_notify only for genuinely important spawned-agent updates, blockers, or decisions needing user attention.",
			"Do not use it for routine progress, detailed reports, or final summaries unless the user explicitly needs immediate notification.",
			"Keep messages short. Normal team reports should go through team messaging, not Friday.",
		],
		parameters: Type.Object({
			message: Type.String({ description: "Short important notification for the user" }),
		}),
		async execute(_toolCallId, params: any) {
			const runtimeFile = getFridayRuntimeFile();
			try {
				if (!existsSync(runtimeFile)) {
					return { content: [{ type: "text" as const, text: "Friday is not active." }], details: { delivered: false, reason: "missing_runtime" } };
				}
				const runtime = JSON.parse(readFileSync(runtimeFile, "utf-8"));
				if (!runtime?.active || !runtime?.paneId || !runtime?.messagesFile) {
					return { content: [{ type: "text" as const, text: "Friday is not active." }], details: { delivered: false, reason: "inactive" } };
				}

				const alive = await pi.exec("tmux", ["display-message", "-t", runtime.paneId, "-p", "#{pane_id}"]);
				if (alive.code !== 0 || alive.stdout.trim() !== runtime.paneId) {
					return { content: [{ type: "text" as const, text: "Friday panel is not available." }], details: { delivered: false, reason: "pane_unavailable" } };
				}

				const message = sanitizeFridayNotification(String(params.message ?? ""));
				if (!message) throw new Error("message is required");

				const time = new Date().toLocaleTimeString("en-US", { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });
				const width = Math.max(20, Number(runtime.paneWidth) || 60);
				const prefix = `\x1b[36m[${sanitizeFridayNotification(agentName)}]\x1b[0m - \x1b[2m${time}\x1b[0m: `;
				const wrapped = wrapPlainText(message, Math.max(20, width - 4));
				let out = "\n";
				wrapped.forEach((line, index) => {
					out += index === 0 ? `  ${prefix}${line}\n` : `  ${" ".repeat(agentName.length + 14)}${line}\n`;
				});
				out += "\n";
				appendFileSync(runtime.messagesFile, out);

				return { content: [{ type: "text" as const, text: "Notification sent to Friday." }], details: { delivered: true } };
			} catch (e) {
				return { content: [{ type: "text" as const, text: "Could not notify Friday." }], details: { delivered: false, error: e instanceof Error ? e.message : String(e) } };
			}
		},
		renderCall(_args, theme) {
			return new Text(theme.fg("toolTitle", theme.bold("friday_notify ")) + theme.fg("accent", "important update"), 0, 0);
		},
		renderResult(result, _options, theme) {
			const delivered = (result as any).details?.delivered;
			return new Text(theme.fg(delivered ? "success" : "warning", delivered ? "✓ notified" : "not sent"), 0, 0);
		},
	});
}

export default function (pi: ExtensionAPI) {

	// Spawned agents stay silent by default. They only get a restricted Friday notification tool.
	const spawnedAgentName = process.env.PI_AGENT_NAME || process.env.PI_TEAM_ROLE;
	if (spawnedAgentName) {
		registerSpawnedAgentFridayNotify(pi, spawnedAgentName);
		return;
	}

	// Friday is an interactive tmux extension. Do not start it for print, JSON, RPC, help,
	// model listing, export, piped stdin, or any other CLI path that skips Pi's TUI.
	if (!shouldStartFridayForPiInvocation()) return;

	// Friday requires tmux — the panel, voice, and daemon all depend on it
	if (!process.env.TMUX) return;

	// Dependency detection — check what's available on this system
	const { execSync, execFileSync } = require("node:child_process");
	function hasCommand(cmd: string): boolean {
		try { execSync(`which ${cmd}`, { stdio: "ignore" }); return true; } catch { return false; }
	}
	const hasPiper = hasCommand("piper");
	const hasSox = hasCommand("play");
	const hasVoiceDeps = hasPiper && hasSox;
	const hasPython = hasCommand("python3");
	// Check if wake word deps are actually available (not just python3)
	let hasWakeDeps = false;
	if (hasPython) {
		try { execSync('python3 -c "import openwakeword; import pyaudio"', { stdio: "ignore", timeout: 5000 }); hasWakeDeps = true; } catch {}
	}

	// State variables
	let settings = loadSettings();
	let enabled = true;
	let voiceEnabled = hasVoiceDeps && settings.voice.enabled;
	let paneId: string | null = null;
	let emotePaneId: string | null = null;
	let todoPaneId: string | null = null;
	let paneHidden = false;
	let paneWidth = 40;
	let communicateCalledThisTurn = false;
	let wakeDaemon: ChildProcess | null = null;
	let wakeWatcher: any = null;
	let lastCommandTimestamp = { value: 0 };
	let lastMessageTime = { value: 0 };
	let lastAgentEndTime = 0;
	let interactionCount = { value: 0 };
	let lastAckCategory = { value: null as any };
	let lastAckIndex = { value: -1 };
	let lastMessageWasQuestion = { value: false };
	let lastFullMessageText = "";
	let lastSpokenText = "";
	let hiddenStreamCopyActive = false;
	let hiddenStreamCopiedText = "";
	let ackTimer = { value: null as ReturnType<typeof setTimeout> | null };
	let lastUi: any = null;  // Cached UI reference for reactive status updates
	type FridayMode = "offline" | "hidden" | "visible";
	const FRIDAY_MODEL_TOOLS = ["communicate", "todo"];
	let remoteControlSuspended = false;
	let voiceEnabledBeforeRemoteControl = voiceEnabled;
	let wakeWasActiveBeforeRemoteControl = false;
	let fridayToolsActiveBeforeHidden: Set<string> | null = null;

	// Capture our own tmux pane so all tmux commands target the correct window
	const ownerPaneId: string | null = process.env.TMUX_PANE ?? null;
	const commsDir = join(tmpdir(), `pi-friday-${process.pid}`);
	const messagesFile = join(commsDir, "messages.dat");
	const todosFile = join(commsDir, "todos.dat");
	const emoteFile = join(commsDir, "emote.dat");
	const commandFile = join(commsDir, "wake_command.json");

	// Create commsDir early so log file works from the start
	mkdirSync(commsDir, { recursive: true });

	// Logging functions
	const logFile = join(commsDir, "friday.log");
	function log(msg: string) {
		try { appendFileSync(logFile, `${new Date().toISOString()} ${msg}\n`); } catch {}
	}
	log(`Friday starting: ownerPaneId=${ownerPaneId ?? "null"} pid=${process.pid}`);

	function logError(context: string, err: unknown): void {
		try {
			const msg = err instanceof Error ? err.message : String(err);
			log(`ERROR [${context}]: ${msg}`);
		} catch { /* absolute last resort — swallow silently */ }
	}

	function cleanupOldFridayPanesInCurrentWindow(): void {
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
				const isFridayPane = command.includes("/pi-friday-") && (command.includes("/display.pl") || command.includes("/emote.pl") || command.includes("/todos.pl"));
				if (!isFridayPane) continue;

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
						log(`Cleaned ${reason} Friday pane ${paneIdToCheck}`);
					} catch (err) {
						logError("cleanupOldFridayPanes.kill", err);
					}
				}
			}
		} catch (err) {
			logError("cleanupOldFridayPanes", err);
		}
	}

	cleanupOldFridayPanesInCurrentWindow();

	// Set up logging for voice module
	setLogFunctions(log, logError);

	// Helper functions
	function sleep(ms: number): Promise<void> {
		return new Promise((resolve) => {
			const t = setTimeout(resolve, ms);
			t.unref();
		});
	}

	function publishFridayRuntimeState() {
		try {
			const runtimeFile = getFridayRuntimeFile();
			mkdirSync(dirname(runtimeFile), { recursive: true });
			writeFileSync(runtimeFile, JSON.stringify({
				pid: process.pid,
				active: isFridayActive(),
				mode: getFridayMode(),
				paneId,
				messagesFile,
				paneWidth,
				updatedAt: new Date().toISOString(),
			}, null, 2) + "\n");
		} catch (e) { logError("publishFridayRuntimeState", e); }
	}

	function publishFridayPanelState() {
		publishFridayRuntimeState();
	}

	async function publishFridayTmuxOptions() {
		try {
			if (!ownerPaneId || !process.env.TMUX) return;
			const targets = [ownerPaneId, paneId].filter((id): id is string => Boolean(id));
			const options = ["@friday_emote_file", "@friday_comms_pane", "@friday_emote_pane"];
			for (const target of targets) {
				for (const option of options) {
					try { await pi.exec("tmux", ["set-option", "-p", "-u", "-t", target, option]); } catch {}
				}
			}
		} catch (e) { logError("publishFridayTmuxOptions", e); }
	}

	async function announceFridayPanelState() {
		await publishFridayTmuxOptions();
		publishFridayPanelState();
	}

	async function ensurePanelOpenWrapper(): Promise<boolean> {
		const result = await ensurePanelOpen(
			pi, settings, commsDir, messagesFile, todosFile, emoteFile, ownerPaneId,
			paneId, emotePaneId, todoPaneId, sleep, logError, log
		);
		if (result.success) {
			paneId = result.paneId;
			emotePaneId = result.emotePaneId;
			todoPaneId = result.todoPaneId;
			paneWidth = result.paneWidth;
			await announceFridayPanelState();
		}
		return result.success;
	}

	function writeMessageWrapper(text: string, standalone = false) {
		writeMessage(text, messagesFile, paneWidth, settings, lastMessageTime, logError, standalone ? "standalone" : "normal");
	}

	function writeMessagePassthroughWrapper(text: string) {
		writeMessagePassthrough(text, messagesFile, paneWidth, logError);
	}

	function syncTodoPaneWrapper(hasTodos: boolean) {
		void (async () => {
			try {
				if (!isFridayActive()) return;
				if (hasTodos && (!paneId || !(await isPaneAlive(pi, paneId, log)))) {
					const result = await openPanel(pi, settings, commsDir, messagesFile, todosFile, emoteFile, ownerPaneId, logError, log);
					if (result.success) {
						paneId = result.paneId;
						emotePaneId = result.emotePaneId;
						todoPaneId = result.todoPaneId;
						paneWidth = result.paneWidth;
						await announceFridayPanelState();
						await keepFridayPanelHidden();
					}
					return;
				}
				todoPaneId = await syncTodoPane(pi, commsDir, todosFile, paneId, todoPaneId, logError);
				if (emotePaneId && (await isPaneAlive(pi, emotePaneId, log))) await killPane(pi, emotePaneId);
				emotePaneId = null;
				await announceFridayPanelState();
				await keepFridayPanelHidden();
			} catch (e) { logError("syncTodoPaneWrapper", e); }
		})();
	}

	registerFridayTodo(pi, {
		todosFile,
		logError,
		onTodoVisibilityChange: syncTodoPaneWrapper,
		isEnabled: () => isFridayVisible(),
	});

	function enqueueVoiceWithMessageWrapper(text: string, speed?: number, standalone?: boolean) {
		enqueueVoiceWithMessage(text, log, logError, speed, standalone);
		if (!voicePlaying) {
			processVoiceQueueSynced(
				ensurePanelOpenWrapper,
				writeMessageWrapper,
				settings,
				commsDir,
				wakeDaemon,
				lastFullMessageText,
				lastSpokenText,
				lastMessageWasQuestion.value,
				log,
				logError
			);
		}
	}

	function showAndSpeakWrapper(text: string) {
		if (!isFridayVisible()) return;
		showAndSpeak(
			text, voiceEnabled, ensurePanelOpenWrapper, writeMessageWrapper,
			enqueueVoiceWithMessageWrapper, settings, logError
		);
	}

	function handleWakeCommandWrapper(text: string) {
		handleWakeCommand(text, pi, log, logError);
	}

	// Status helpers
	function updateStatus(ui?: any) {
		try {
			const ctx = ui ?? lastUi;
			if (!ctx) return;
			if (ui) lastUi = ui;  // Cache for reactive updates
			ctx.setStatus("friday", undefined);
		} catch (e) { logError("updateStatus", e); }
	}

	function isFridayActive(): boolean {
		return enabled && !remoteControlSuspended;
	}

	function getFridayMode(): FridayMode {
		if (!isFridayActive()) return "offline";
		return paneHidden ? "hidden" : "visible";
	}

	function isFridayVisible(): boolean {
		return getFridayMode() === "visible";
	}

	function getFridayControlState() {
		return {
			enabled,
			active: isFridayActive(),
			suspended: remoteControlSuspended,
			voiceEnabled,
			wakeWordListening: Boolean(wakeDaemon),
			paneOpen: Boolean(paneId),
			paneHidden,
			todoPaneOpen: Boolean(todoPaneId),
		};
	}

	function formatFridayControlState(prefix: string): string {
		const state = getFridayControlState();
		const activeText = state.active ? "active" : state.suspended ? "suspended" : "offline";
		return `${prefix}: Friday is ${activeText}. Voice ${state.voiceEnabled ? "on" : "off"}. Wake word ${state.wakeWordListening ? "on" : "off"}.`;
	}

	function getRegisteredFridayModelTools(): string[] {
		try {
			const api = pi as any;
			if (typeof api.getAllTools !== "function") return [...FRIDAY_MODEL_TOOLS];
			const registered = new Set(api.getAllTools().map((tool: any) => tool?.name).filter((name: unknown): name is string => typeof name === "string"));
			return FRIDAY_MODEL_TOOLS.filter((name) => registered.has(name));
		} catch (e) {
			logError("friday.getRegisteredTools", e);
			return [...FRIDAY_MODEL_TOOLS];
		}
	}

	// Hide communicate/todo from the LLM whenever Friday should not steer the
	// next turn (hidden, disabled, or suspended). Closing or zooming the panel is
	// not enough: active tools are captured before before_agent_start runs.
	function deactivateFridayTools(context: string, restoreRegisteredFridayTools = false) {
		try {
			const api = pi as any;
			if (typeof api.getActiveTools !== "function" || typeof api.setActiveTools !== "function") return;
			const activeTools = api.getActiveTools();
			if (!Array.isArray(activeTools)) return;
			if (!fridayToolsActiveBeforeHidden) {
				const restoreTools = restoreRegisteredFridayTools
					? getRegisteredFridayModelTools()
					: FRIDAY_MODEL_TOOLS.filter((name) => activeTools.includes(name));
				fridayToolsActiveBeforeHidden = new Set(restoreTools);
			}
			api.setActiveTools(activeTools.filter((name: string) => !FRIDAY_MODEL_TOOLS.includes(name)));
		} catch (e) { logError(`${context}.disableTools`, e); }
	}

	function reactivateFridayTools(context: string) {
		try {
			const api = pi as any;
			if (!fridayToolsActiveBeforeHidden || typeof api.getActiveTools !== "function" || typeof api.setActiveTools !== "function") return;
			const activeTools = api.getActiveTools();
			if (!Array.isArray(activeTools)) return;
			const registeredFridayTools = new Set(getRegisteredFridayModelTools());
			const nextTools = [...activeTools];
			for (const name of fridayToolsActiveBeforeHidden) {
				if (registeredFridayTools.has(name) && !nextTools.includes(name)) nextTools.push(name);
			}
			api.setActiveTools(nextTools);
			fridayToolsActiveBeforeHidden = null;
		} catch (e) { logError(`${context}.restoreTools`, e); }
	}

	async function closeFridayPanes() {
		try {
			try { mkdirSync(commsDir, { recursive: true }); writeFileSync(todosFile, "", "utf-8"); } catch {}
			if (todoPaneId && (await isPaneAlive(pi, todoPaneId, log))) await killPane(pi, todoPaneId);
			todoPaneId = null;
			if (emotePaneId && (await isPaneAlive(pi, emotePaneId, log))) await killPane(pi, emotePaneId);
			emotePaneId = null;
			if (paneId && (await isPaneAlive(pi, paneId, log))) await killPane(pi, paneId);
			paneId = null;
			paneHidden = false;
			publishFridayPanelState();
		} catch (e) { logError("friday.closePanes", e); }
	}

	async function isOwnerWindowZoomed(): Promise<boolean> {
		try {
			if (!ownerPaneId || !process.env.TMUX) return false;
			const result = await pi.exec("tmux", ["display-message", "-t", ownerPaneId, "-p", "#{window_zoomed_flag}"]);
			return result.code === 0 && result.stdout.trim() === "1";
		} catch (e) {
			logError("friday.isOwnerWindowZoomed", e);
			return false;
		}
	}

	async function keepFridayPanelHidden(): Promise<void> {
		try {
			if (!paneHidden || !ownerPaneId || !process.env.TMUX) return;
			if (!(await isOwnerWindowZoomed())) await pi.exec("tmux", ["resize-pane", "-Z", "-t", ownerPaneId]);
		} catch (e) { logError("friday.keepPanelHidden", e); }
	}

	async function writeHiddenPanelCopy(message: string, newTopic?: boolean): Promise<void> {
		try {
			if (!isFridayActive()) return;
			if (newTopic) lastMessageTime.value = 0;
			if (!paneId || !(await isPaneAlive(pi, paneId, log))) {
				const opened = await ensurePanelOpenWrapper();
				if (!opened) return;
			}
			writeMessagePassthroughWrapper(message);
			await keepFridayPanelHidden();
		} catch (e) { logError("friday.writeHiddenPanelCopy", e); }
	}

	async function beginHiddenStreamCopy(): Promise<void> {
		try {
			if (!paneHidden || !isFridayActive()) return;
			if (!paneId || !(await isPaneAlive(pi, paneId, log))) {
				const opened = await ensurePanelOpenWrapper();
				if (!opened) return;
			}
			hiddenStreamCopyActive = true;
			hiddenStreamCopiedText = "";
			appendFileSync(messagesFile, "\n\x1b[38;5;249m  ");
			await keepFridayPanelHidden();
		} catch (e) { logError("friday.beginHiddenStreamCopy", e); }
	}

	function appendHiddenStreamDelta(delta: string): void {
		try {
			if (!hiddenStreamCopyActive || !delta) return;
			hiddenStreamCopiedText += delta;
			appendFileSync(messagesFile, delta.replace(/\n/g, "\n  "));
		} catch (e) { logError("friday.appendHiddenStreamDelta", e); }
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
			await keepFridayPanelHidden();
		} catch (e) { logError("friday.endHiddenStreamCopy", e); }
	}

	async function toggleFridayPanelVisibility(ui?: any): Promise<void> {
		try {
			if (!isFridayActive()) {
				ui?.notify(`${settings.name} is not active`, "info");
				return;
			}
			if (!ownerPaneId || !process.env.TMUX) {
				ui?.notify("Friday panel toggle requires tmux", "error");
				return;
			}

			if (await isOwnerWindowZoomed()) {
				await pi.exec("tmux", ["resize-pane", "-Z", "-t", ownerPaneId]);
				paneHidden = false;
				reactivateFridayTools("panelVisible");
				if (!paneId || !(await isPaneAlive(pi, paneId))) await ensurePanelOpenWrapper();
				publishFridayPanelState();
				updateStatus(ui);
				ui?.notify("Friday panel shown", "info");
				return;
			}

			if (!paneId || !(await isPaneAlive(pi, paneId))) {
				const opened = await ensurePanelOpenWrapper();
				paneHidden = false;
				reactivateFridayTools("panelVisible");
				publishFridayPanelState();
				updateStatus(ui);
				ui?.notify(opened ? "Friday panel shown" : "Could not open Friday panel", opened ? "info" : "error");
				return;
			}

			paneHidden = true;
			cancelAck(ackTimer);
			deactivateFridayTools("panelHidden");
			await keepFridayPanelHidden();
			publishFridayPanelState();
			updateStatus(ui);
			ui?.notify("Friday panel hidden", "info");
		} catch (e) {
			logError("friday.togglePanelVisibility", e);
			ui?.notify("Could not toggle Friday panel", "error");
		}
	}

	async function suspendFridayForRemoteControl() {
		try {
			if (remoteControlSuspended) return;
			remoteControlSuspended = true;
			voiceEnabledBeforeRemoteControl = voiceEnabled;
			wakeWasActiveBeforeRemoteControl = Boolean(wakeDaemon);
			cancelAck(ackTimer);
			deactivateFridayTools("remoteControl");
			voiceEnabled = false;
			try { killCurrentVoice(); } catch (e) { logError("remoteControl.killVoice", e); }
			stopWakeDaemonWrapper();
			await closeFridayPanes();
			updateStatus();
			log("Friday suspended for remote control");
		} catch (e) { logError("remoteControl.suspend", e); }
	}

	function resumeFridayAfterRemoteControl() {
		try {
			if (!remoteControlSuspended) return;
			remoteControlSuspended = false;
			// Only bring the tools back if Friday itself is enabled — it may
			// have been disabled (e.g. learn-french study mode) while suspended.
			if (enabled) reactivateFridayTools("remoteControl");
			voiceEnabled = enabled && hasVoiceDeps && voiceEnabledBeforeRemoteControl;
			if (enabled && hasWakeDeps && wakeWasActiveBeforeRemoteControl) startWakeDaemonWrapper();
			wakeWasActiveBeforeRemoteControl = false;
			updateStatus();
			log("Friday resumed after remote control");
		} catch (e) { logError("remoteControl.resume", e); }
	}

	async function setFridayEnabled(nextEnabled: boolean, source: string, ui?: any): Promise<void> {
		try {
			if (enabled === nextEnabled) {
				if (!nextEnabled) {
					voiceEnabled = false;
					cancelAck(ackTimer);
					try { killCurrentVoice(); } catch (e) { logError(`${source}.killVoice`, e); }
					stopWakeDaemonWrapper();
					deactivateFridayTools(source);
					await closeFridayPanes();
				} else if (isFridayActive()) {
					reactivateFridayTools(source);
					await ensurePanelOpenWrapper();
				} else {
					await announceFridayPanelState();
				}
				updateStatus(ui);
				return;
			}

			enabled = nextEnabled;
			if (!enabled) {
				voiceEnabled = false;
				cancelAck(ackTimer);
				try { killCurrentVoice(); } catch (e) { logError(`${source}.killVoice`, e); }
				stopWakeDaemonWrapper();
				deactivateFridayTools(source);
				await closeFridayPanes();
				updateStatus(ui);
				log(`Friday disabled by ${source}`);
				return;
			}

			settings = loadSettings();
			voiceEnabled = isFridayActive() && hasVoiceDeps && settings.voice.enabled;
			if (isFridayActive() && hasWakeDeps && settings.wakeWord.enabled) startWakeDaemonWrapper();
			if (isFridayActive()) reactivateFridayTools(source);
			updateStatus(ui);
			if (isFridayActive()) await ensurePanelOpenWrapper();
			else await announceFridayPanelState();
			log(`Friday enabled by ${source}`);
		} catch (e) { logError(`${source}.setFridayEnabled`, e); }
	}

	function fridayEventSource(data: unknown): string {
		if (data && typeof data === "object" && typeof (data as any).source === "string") return `event:${(data as any).source}`;
		return "event";
	}

	function fridayEventEnabledValue(data: unknown): boolean | undefined {
		if (typeof data === "boolean") return data;
		if (data && typeof data === "object" && typeof (data as any).enabled === "boolean") return (data as any).enabled;
		return undefined;
	}

	pi.events.on("remote-control:enabled", () => { void suspendFridayForRemoteControl(); });
	pi.events.on("remote-control:disabled", () => { resumeFridayAfterRemoteControl(); });
	pi.events.on("remote-control:disconnected", () => { resumeFridayAfterRemoteControl(); });
	pi.events.on("friday:disable", (data) => { void setFridayEnabled(false, fridayEventSource(data)); });
	pi.events.on("friday:enable", (data) => { void setFridayEnabled(true, fridayEventSource(data)); });
	pi.events.on("friday:set-enabled", (data) => {
		const nextEnabled = fridayEventEnabledValue(data);
		if (nextEnabled === undefined) {
			log("friday:set-enabled ignored: missing boolean enabled value");
			return;
		}
		void setFridayEnabled(nextEnabled, fridayEventSource(data));
	});

	// Daemon management
	function startWakeDaemonWrapper() {
		try {
			if (wakeDaemon) return;
			wakeDaemon = startWakeDaemon(settings, commsDir, commandFile, log, logError);
			if (wakeDaemon) {
				wakeDaemon.on("exit", (code) => {
					try {
						log(`Wake daemon exited (code: ${code})`);
						wakeDaemon = null;
						stopWakeWatcherWrapper();
						updateStatus();  // Refresh status bar so DAEMON ON clears
					} catch (e) { logError("wakeDaemon.exit", e); }
				});
				startWakeWatcherWrapper();
			}
		} catch (e) { logError("startWakeDaemon", e); }
	}

	function stopWakeDaemonWrapper() {
		try {
			stopWakeWatcherWrapper();
			if (wakeDaemon) {
				stopWakeDaemon(wakeDaemon, logError);
				wakeDaemon = null;
			}
		} catch (e) { logError("stopWakeDaemon", e); }
	}

	function startWakeWatcherWrapper() {
		try {
			stopWakeWatcherWrapper();
			wakeWatcher = startWakeWatcher(
				commandFile, lastCommandTimestamp, killCurrentVoice, 
				handleWakeCommandWrapper, logError
			);
		} catch (e) { logError("startWakeWatcher", e); }
	}

	function stopWakeWatcherWrapper() {
		try {
			if (wakeWatcher) {
				stopWakeWatcher(wakeWatcher, logError);
				wakeWatcher = null;
			}
		} catch (e) { logError("stopWakeWatcher", e); }
	}

	// Custom Tool: friday_control
	pi.registerTool({
		name: "friday_control",
		label: "Friday",
		description: "Enable, disable, or inspect Friday. Other extensions can also emit friday:disable, friday:enable, or friday:set-enabled events.",
		promptSnippet: "Enable, disable, or inspect the Friday communications panel",
		promptGuidelines: [
			"Use friday_control when the user asks to enable, disable, turn off, turn on, or inspect Friday.",
			"Use friday_control with action=status before changing Friday if the user only asks whether Friday is active.",
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
				await setFridayEnabled(true, source);
			} else if (action === "disable") {
				await setFridayEnabled(false, source);
			} else if (action !== "status") {
				throw new Error(`unknown friday_control action: ${params.action}`);
			}

			return {
				content: [{ type: "text" as const, text: formatFridayControlState(action) }],
				details: { action, requestedAction, state: getFridayControlState() },
			};
		},
		renderCall(args, theme) {
			const action = String((args as any)?.action ?? "status");
			return new Text(theme.fg("toolTitle", theme.bold("friday_control ")) + theme.fg("accent", action), 0, 0);
		},
		renderResult(result, _options, theme) {
			const state = (result as any).details?.state;
			const active = state?.active ? "active" : state?.suspended ? "suspended" : "offline";
			return new Text(theme.fg(state?.active ? "success" : "warning", `Friday ${active}`), 0, 0);
		},
	});

	// Custom Tool: communicate
	pi.registerTool({
		name: "communicate",
		label: "Comm",
		description: "Send a direct message to the user via the communications side panel.",
		promptSnippet: "Send direct messages to the user via the side communications panel",
		promptGuidelines: [
			"Use communicate for conversation: acknowledgments, status updates, explanations, summaries, final summaries, confirmations, findings, and questions.",
			"Call communicate before finishing any turn whose answer is conversational prose; do not leave the conversational answer only in the final main-window response.",
			"If communicate already delivered the conversational answer and there is no structured artifact to show, keep the final main-window response empty or to the shortest possible completion marker.",
			"Useful content the user asks to see belongs in the main window, not the communications panel; treat phrases like 'show me', 'display', 'print', 'me mostre', 'mostra', or 'mostre' as main-window requests.",
			"Keep code, tables, SQL, command output, file contents, diffs, chords, tabs, diagrams, recipes, checklists, instructions, reference material, and other visually useful artifacts in the main window.",
			"Messages sent through communicate must be plain text only -- no markdown, no emojis. Write as natural spoken prose.",
			"You can call communicate multiple times in one turn for separate conversational points.",
			"Be concise in your responses",
		],
		parameters: Type.Object({
			message: Type.String({ description: "The message to display to the user" }),
			new_topic: Type.Optional(Type.Boolean({ 
				description: "Set true when the subject has changed from the previous message." 
			})),
			...(hasVoiceDeps ? {
				voice_summary: Type.Optional(Type.String({ 
					description: "Optional: a short 1-2 sentence spoken summary for voice output." 
				})),
			} : {}),
		}),

		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			try {
				communicateCalledThisTurn = true;

				if (!isFridayActive()) {
					log("communicate: disabled or suspended, delivering inline");
					return {
						content: [{ type: "text" as const, text: params.message }],
						details: { delivered: false },
					};
				}

				if (paneHidden) {
					log("communicate: panel hidden fallback hit; copying to hidden panel and forcing normal assistant continuation");
					await writeHiddenPanelCopy(params.message, params.new_topic);
					return {
						content: [{ type: "text" as const, text: `Friday is hidden. A copy was saved to the hidden panel, but the user cannot see it now. You must now write the same message as a normal assistant response in the main window. Do not call communicate again. Message to show: ${params.message}` }],
						details: { delivered: false, copiedToHiddenPanel: true, suppressedWhileHidden: true },
					};
				}

				if (!paneId || !(await isPaneAlive(pi, paneId, log))) {
					log(`communicate: panel dead or missing (paneId=${paneId ?? "null"}), opening...`);
					let result = await openPanel(pi, settings, commsDir, messagesFile, todosFile, emoteFile, ownerPaneId, logError, log);
					if (!result.success) {
						// Retry once after a short delay
						log("communicate: first openPanel attempt failed, retrying in 500ms...");
						await sleep(500);
						result = await openPanel(pi, settings, commsDir, messagesFile, todosFile, emoteFile, ownerPaneId, logError, log);
					}
					if (!result.success) {
						log("communicate: both openPanel attempts failed, delivering inline");
						return {
							content: [{ type: "text" as const, text: params.message }],
							details: { delivered: false },
						};
					}
					paneId = result.paneId;
					emotePaneId = result.emotePaneId;
					todoPaneId = result.todoPaneId;
					paneWidth = result.paneWidth;
					await announceFridayPanelState();
					await sleep(500);
				}

				if (params.new_topic) {
					lastMessageTime.value = 0;
				}

				cancelAck(ackTimer);

				if (voiceEnabled) {
					if (voicePlaying || voiceQueue.length > 0) {
						killCurrentVoice();
					}
					const spoken = deriveVoiceText(params.message, params.voice_summary);
					lastFullMessageText = params.message;
					lastSpokenText = spoken;
					
					// Wait briefly for playback to start. Cap at 2s to avoid blocking shutdown.
					let wrote = false;
					const writeOnce = () => {
						if (wrote) return;
						wrote = true;
						try { writeMessageWrapper(params.message); } catch (e) { logError("communicate.writeMessage", e); }
					};
					await new Promise<void>((resolve) => {
						const timer = setTimeout(() => { writeOnce(); resolve(); }, 2000);
						timer.unref();
						const onStart = () => { clearTimeout(timer); writeOnce(); resolve(); };
						speakText(
							spoken, settings, commsDir, wakeDaemon, lastFullMessageText, 
							lastSpokenText, lastMessageWasQuestion.value, log, logError, onStart
						).finally(() => { clearTimeout(timer); writeOnce(); resolve(); });
					});
				} else {
					writeMessageWrapper(params.message);
				}

				return {
					content: [{ type: "text" as const, text: "Message delivered to comms panel." }],
					details: { delivered: true },
				};
			} catch (e) {
				logError("communicate.execute", e);
				return {
					content: [{ type: "text" as const, text: params.message }],
					details: { delivered: false },
				};
			}
		},

		renderCall(_args, theme, _context) {
			if (paneHidden) return new Text("", 0, 0);
			return new Text(
				theme.fg("toolTitle", theme.bold("communicate ")) + theme.fg("accent", "sending message"),
				0,
				0,
			);
		},

		renderResult(result, _options, theme, _context) {
			try {
				const delivered = (result as any).details?.delivered;
				const suppressedWhileHidden = (result as any).details?.suppressedWhileHidden;
				if (suppressedWhileHidden) return new Text("", 0, 0);
				if (delivered) return new Text(theme.fg("success", "✓ delivered"), 0, 0);
				return new Text(theme.fg("dim", "inline"), 0, 0);
			} catch {
				return new Text(theme.fg("success", "✓"), 0, 0);
			}
		},
	});

	// Event handlers and commands
	pi.on("before_agent_start", async (event) => {
		try {
			if (!isFridayActive()) return;
			loadVoiceAcks();
			if (!isFridayVisible()) {
				cancelAck(ackTimer);
				if (paneHidden) deactivateFridayTools("beforeAgentStartHidden", true);
				return;
			}
			const result = { systemPrompt: event.systemPrompt + buildSystemPrompt(hasVoiceDeps) };
			
			// Schedule acknowledgment
			const prompt = event.prompt ?? "";
			if (prompt && !prompt.startsWith("/")) {
				scheduleAck(
					prompt, ackTimer, lastMessageWasQuestion, lastAgentEndTime, 
					interactionCount, lastAckCategory, lastAckIndex, 
					showAndSpeakWrapper, logError
				);
			}
			return result;
		} catch (e) { logError("before_agent_start", e); }
	});

	pi.on("agent_end", async () => {
		try { lastAgentEndTime = Date.now(); } catch {}
	});

	pi.on("turn_start", async () => {
		try { communicateCalledThisTurn = false; } catch {}
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

	pi.on("message_start", async (event) => {
		try {
			if (!paneHidden || !isFridayActive()) return;
			const msg = event.message;
			if (!msg || msg.role !== "assistant") return;
			await beginHiddenStreamCopy();
		} catch (e) { logError("message_start.hiddenCopy", e); }
	});

	pi.on("message_update", async (event) => {
		try {
			if (!paneHidden || !isFridayActive()) return;
			const assistantEvent = (event as any).assistantMessageEvent;
			if (assistantEvent?.type === "text_delta" && typeof assistantEvent.delta === "string") {
				appendHiddenStreamDelta(assistantEvent.delta);
			}
		} catch (e) { logError("message_update.hiddenCopy", e); }
	});

	// Forward assistant text blocks to the panel. Visible mode still mirrors
	// finalized assistant text as before; hidden mode copies streaming deltas via
	// message_update so we do not append a fully rendered block at message_end.
	pi.on("message_end", async (event) => {
		try {
			if (!isFridayActive()) return;

			const msg = event.message;
			if (!msg || msg.role !== "assistant") return;

			const text = extractAssistantText(msg);

			if (paneHidden) {
				await endHiddenStreamCopy(text);
				return;
			}
			if (!text) return;
			const ok = await ensurePanelOpenWrapper();
			if (ok) writeMessagePassthroughWrapper(text);
		} catch (e) { logError("message_end.passthrough", e); }
	});

	// Commands and shortcuts
	pi.registerCommand("friday", {
		description: "Usage: /friday [voice|listen|settings|log]",
		handler: async (args, ctx) => {
			try {
				const arg = (args ?? "").trim().toLowerCase();

				if (remoteControlSuspended) {
					ctx.ui.notify(`${settings.name} is suspended while remote control is active`, "info");
					return;
				}

				if (arg === "voice") {
					if (!hasVoiceDeps) {
						ctx.ui.notify("Voice unavailable — piper and sox (play) required", "error");
						return;
					}
					voiceEnabled = !voiceEnabled;
					settings.voice.enabled = voiceEnabled;
					saveSettings(settings);
					updateStatus(ctx.ui);
					ctx.ui.notify(voiceEnabled ? "Voice on" : "Voice off", "info");
					return;
				}

				if (arg === "listen") {
					if (!hasWakeDeps) {
						ctx.ui.notify("Wake word listener unavailable — requires python3 + openwakeword + pyaudio", "error");
						return;
					}
					if (wakeDaemon) {
						stopWakeDaemonWrapper();
						settings.wakeWord.enabled = false;
						saveSettings(settings);
						updateStatus(ctx.ui);
						ctx.ui.notify("Wake word listener off", "info");
					} else {
						startWakeDaemonWrapper();
						settings.wakeWord.enabled = true;
						saveSettings(settings);
						updateStatus(ctx.ui);
						ctx.ui.notify(`Listening for "${settings.wakeWord.model}"`, "info");
					}
					return;
				}

				if (arg === "settings") {
					settings = loadSettings();
					const wakeStatus = wakeDaemon ? "on" : "off";
					const info = [
						`Name: ${settings.name}`,
						`Voice: ${voiceEnabled ? "on" : "off"} (model: ${settings.voice.model})`,
						`Wake word: ${wakeStatus} (model: ${settings.wakeWord.model})`,
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
						ctx.ui.notify(`Friday log (last 30 lines):\n${tail}`, "info");
					} else {
						ctx.ui.notify(`No log file at ${logFile}`, "info");
					}
					return;
				}

				const nextEnabled = !enabled;
				await setFridayEnabled(nextEnabled, "command", ctx.ui);
				ctx.ui.notify(nextEnabled ? `${settings.name} online` : `${settings.name} offline`, "info");
			} catch (e) { logError("command.friday", e); }
		},
	});

	if (hasVoiceDeps) {
		pi.registerShortcut("alt+m", {
			description: "Toggle Friday voice",
			handler: async (ctx) => {
				try {
					killCurrentVoice();
					voiceEnabled = !voiceEnabled;
					settings.voice.enabled = voiceEnabled;
					saveSettings(settings);
					updateStatus(ctx.ui);
					ctx.ui.notify(voiceEnabled ? "Voice on" : "Voice off", "info");
				} catch (e) { logError("shortcut.alt+m", e); }
			},
		});
	}

	if (hasWakeDeps) {
		pi.registerShortcut("alt+l", {
			description: "Toggle Friday wake word listener",
			handler: async (ctx) => {
				try {
					if (wakeDaemon) {
						stopWakeDaemonWrapper();
						settings.wakeWord.enabled = false;
						saveSettings(settings);
						updateStatus(ctx.ui);
						ctx.ui.notify("Wake word listener off", "info");
					} else {
						startWakeDaemonWrapper();
						settings.wakeWord.enabled = true;
						saveSettings(settings);
						updateStatus(ctx.ui);
						ctx.ui.notify(`Listening for "${settings.wakeWord.model}"`, "info");
					}
				} catch (e) { logError("shortcut.alt+l", e); }
			},
		});
	}

	pi.registerShortcut("alt+tab", {
		description: "Show/hide Friday panel",
		handler: async (ctx) => {
			try {
				await toggleFridayPanelVisibility(ctx.ui);
			} catch (e) { logError("shortcut.alt+tab", e); }
		},
	});

	// Cleanup
	pi.on("session_shutdown", async (event) => {
		try { killCurrentVoice(); } catch (e) { logError("shutdown.killVoice", e); }
		try { stopWakeDaemonWrapper(); } catch (e) { logError("shutdown.stopDaemon", e); }
		try {
			if (paneHidden && (event as any)?.reason === "reload") {
				paneId = null;
				emotePaneId = null;
				todoPaneId = null;
				log("Friday hidden during reload; leaving tmux panes zoom-hidden for next runtime");
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
			loadVoiceAcks();
			voiceEnabled = hasVoiceDeps && settings.voice.enabled;
			if (hasVoiceDeps) await killOrphanTTS();
			if (hasWakeDeps && settings.wakeWord.enabled) {
				await killOrphanDaemons(log);
				await sleep(500);
				startWakeDaemonWrapper();
			}

			paneHidden = isFridayActive() && (await isOwnerWindowZoomed());
			if (paneHidden) {
				cancelAck(ackTimer);
				deactivateFridayTools("sessionStartHidden", true);
				await announceFridayPanelState();
			} else if (isFridayActive()) {
				reactivateFridayTools("sessionStartVisible");
				await ensurePanelOpenWrapper();
			} else {
				await announceFridayPanelState();
			}
			updateStatus(ctx.ui);
		} catch (e) { logError("session_start", e); }
	});
}