/**
 * F.R.I.D.A.Y. — Voice-enabled Communications Panel
 * Main entry point - wires together all modules
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { Text } from "@earendil-works/pi-tui";
import { mkdirSync, writeFileSync, appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawn, type ChildProcess } from "node:child_process";

// Module imports
import { loadSettings, saveSettings, type FridaySettings } from "./settings.js";
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

export default function (pi: ExtensionAPI) {

	// Spawned agents must not use Friday — no communicate tool, no panel, no voice, no acks
	if (process.env.PI_AGENT_NAME || process.env.PI_TEAM_ROLE) return;

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
	let todoPaneId: string | null = null;
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
	let ackTimer = { value: null as ReturnType<typeof setTimeout> | null };
	let lastUi: any = null;  // Cached UI reference for reactive status updates

	// Capture our own tmux pane so all tmux commands target the correct window
	const ownerPaneId: string | null = process.env.TMUX_PANE ?? null;
	const commsDir = join(tmpdir(), `pi-friday-${process.pid}`);
	const messagesFile = join(commsDir, "messages.dat");
	const todosFile = join(commsDir, "todos.dat");
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
				const isFridayPane = command.includes("/pi-friday-") && (command.includes("/display.pl") || command.includes("/todos.pl"));
				if (!isFridayPane) continue;

				const isCurrentPane = command.includes(commsDir);
				const isEmptyCurrentTodoPane = isCurrentPane && command.includes("/todos.pl") && (() => {
					try { return !existsSync(todosFile) || readFileSync(todosFile, "utf-8").trim().length === 0; }
					catch { return true; }
				})();

				if (!isCurrentPane || isEmptyCurrentTodoPane) {
					try {
						execFileSync("tmux", ["kill-pane", "-t", paneIdToCheck], { stdio: "ignore" });
						log(`Cleaned ${isEmptyCurrentTodoPane ? "empty" : "stale"} Friday pane ${paneIdToCheck}`);
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

	async function ensurePanelOpenWrapper(): Promise<boolean> {
		const result = await ensurePanelOpen(
			pi, settings, commsDir, messagesFile, todosFile, ownerPaneId,
			paneId, todoPaneId, sleep, logError, log
		);
		if (result.success) {
			paneId = result.paneId;
			todoPaneId = result.todoPaneId;
			paneWidth = result.paneWidth;
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
				if (!enabled) return;
				if (hasTodos && (!paneId || !(await isPaneAlive(pi, paneId, log)))) {
					const result = await openPanel(pi, settings, commsDir, messagesFile, todosFile, ownerPaneId, logError, log);
					if (result.success) {
						paneId = result.paneId;
						todoPaneId = result.todoPaneId;
						paneWidth = result.paneWidth;
					}
					return;
				}
				todoPaneId = await syncTodoPane(pi, commsDir, todosFile, paneId, todoPaneId, logError);
			} catch (e) { logError("syncTodoPaneWrapper", e); }
		})();
	}

	registerFridayTodo(pi, { todosFile, logError, onTodoVisibilityChange: syncTodoPaneWrapper });

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

	// Custom Tool: communicate
	pi.registerTool({
		name: "communicate",
		label: "Comm",
		description: "Send a direct message to the user via the communications side panel.",
		promptSnippet: "Send direct messages to the user via the side communications panel",
		promptGuidelines: [
			"ALL text goes through communicate. Every word directed at the user. No exceptions.",
			"The main window is ONLY for visual data: tables, code blocks, SQL, file contents, command output, diffs.",
			"Messages must be plain text only -- no markdown, no emojis. Write as natural spoken prose.",
			"You can call communicate multiple times in one turn for separate points.",
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

				if (!enabled) {
					log("communicate: disabled, delivering inline");
					return {
						content: [{ type: "text" as const, text: params.message }],
						details: { delivered: false },
					};
				}

				if (!paneId || !(await isPaneAlive(pi, paneId, log))) {
					log(`communicate: panel dead or missing (paneId=${paneId ?? "null"}), opening...`);
					let result = await openPanel(pi, settings, commsDir, messagesFile, todosFile, ownerPaneId, logError, log);
					if (!result.success) {
						// Retry once after a short delay
						log("communicate: first openPanel attempt failed, retrying in 500ms...");
						await sleep(500);
						result = await openPanel(pi, settings, commsDir, messagesFile, todosFile, ownerPaneId, logError, log);
					}
					if (!result.success) {
						log("communicate: both openPanel attempts failed, delivering inline");
						return {
							content: [{ type: "text" as const, text: params.message }],
							details: { delivered: false },
						};
					}
					paneId = result.paneId;
					todoPaneId = result.todoPaneId;
					paneWidth = result.paneWidth;
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
			return new Text(
				theme.fg("toolTitle", theme.bold("communicate ")) + theme.fg("accent", "sending message"),
				0,
				0,
			);
		},

		renderResult(result, _options, theme, _context) {
			try {
				const delivered = (result as any).details?.delivered;
				if (delivered) return new Text(theme.fg("success", "✓ delivered"), 0, 0);
				return new Text(theme.fg("warning", "⚠ delivered inline"), 0, 0);
			} catch {
				return new Text(theme.fg("success", "✓"), 0, 0);
			}
		},
	});

	// Event handlers and commands
	pi.on("before_agent_start", async (event) => {
		try {
			if (!enabled) return;
			loadVoiceAcks();
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

	// Forward assistant text blocks to the panel as they complete streaming.
	// message_end fires BEFORE tool calls execute, so grey text arrives in the
	// panel before communicate writes its message. This gives proper ordering:
	// grey context text first, then the communicate message on top.
	pi.on("message_end", async (event) => {
		try {
			if (!enabled) return;

			const msg = event.message;
			if (!msg || msg.role !== "assistant") return;

			const textParts: string[] = [];
			for (const block of (msg as any).content ?? []) {
				if (block.type === "text" && block.text?.trim()) {
					textParts.push(block.text.trim());
				}
			}
			if (textParts.length === 0) return;

			const text = textParts.join("\n\n");
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
						`Settings file: ${commsDir}/settings.json`,
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

				enabled = !enabled;
				if (!enabled) {
					if (todoPaneId && (await isPaneAlive(pi, todoPaneId))) await killPane(pi, todoPaneId);
					todoPaneId = null;
					if (paneId && (await isPaneAlive(pi, paneId))) await killPane(pi, paneId);
					paneId = null;
					voiceEnabled = false;
					stopWakeDaemonWrapper();
					updateStatus(ctx.ui);
					ctx.ui.notify(`${settings.name} offline`, "info");
				} else {
					updateStatus(ctx.ui);
					ctx.ui.notify(`${settings.name} online`, "info");
				}
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

	// Cleanup
	pi.on("session_shutdown", async () => {
			try { killCurrentVoice(); } catch (e) { logError("shutdown.killVoice", e); }
		try { stopWakeDaemonWrapper(); } catch (e) { logError("shutdown.stopDaemon", e); }
		try {
			if (todoPaneId) {
				const p = spawn("tmux", ["kill-pane", "-t", todoPaneId], { stdio: "ignore" });
				p.unref();
				todoPaneId = null;
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
			updateStatus(ctx.ui);
		} catch (e) { logError("session_start", e); }
	});
}