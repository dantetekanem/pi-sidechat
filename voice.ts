/**
 * Friday Extension - Voice/TTS Module
 * Everything TTS: speakText, voice queue, voice helpers, and daemon interaction
 */

import { spawn, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { exec as execCb } from "node:child_process";
const execAsync = promisify(execCb);
import { join } from "node:path";
import { writeFileSync, existsSync, rmSync } from "node:fs";
import type { FridaySettings } from "./settings.js";

export function getVoiceModelPath(settings: FridaySettings): string {
	return join(
		process.env.HOME ?? "~",
		".local/share/piper-voices",
		settings.voice.model + ".onnx",
	);
}

export let currentPiper: ChildProcess | null = null;
export let currentPlayer: ChildProcess | null = null;
export let voiceForceKilled = false;
export const voiceQueue: { text: string; speed?: number; standalone?: boolean }[] = [];
export let voicePlaying = false;

// Resolve function for the active speakText promise — lets killCurrentVoice
// instantly resolve it instead of waiting for the 30s safety timer
let activeSpeakResolve: (() => void) | null = null;

/** Kill any currently playing TTS immediately */
export function killCurrentVoice() {
	try {
		voiceQueue.length = 0;
		// Only set voiceForceKilled if there are actual processes to kill
		// Otherwise the stale flag poisons the next speakText cleanup
		if (currentPlayer || currentPiper) {
			voiceForceKilled = true;
			// Destroy stdio streams first so they don't hold the event loop
			try { currentPiper?.stdout?.destroy(); } catch {}
			try { currentPiper?.stdin?.destroy(); } catch {}
			try { currentPlayer?.stdin?.destroy(); } catch {}
			// SIGKILL for instant death — SIGTERM can leave processes lingering
			try { currentPlayer?.kill("SIGKILL"); } catch {}
			try { currentPiper?.kill("SIGKILL"); } catch {}
		}
		currentPlayer = null;
		currentPiper = null;
		voicePlaying = false;
		// Immediately resolve any pending speakText promise so nothing hangs
		if (activeSpeakResolve) {
			const r = activeSpeakResolve;
			activeSpeakResolve = null;
			r();
		}
	} catch (e) { 
		logError("killCurrentVoice", e); 
	}
}

/** Kill any orphaned piper/play processes from crashed sessions */
export async function killOrphanTTS() {
	try {
		const { stdout } = await execAsync(
			"ps aux | grep -E 'piper.*jenny|play.*raw.*22050' | grep -v grep",
			{ encoding: "utf8", timeout: 5000 },
		);
		const result = stdout.trim();
		if (!result) return;
		for (const line of result.split("\n")) {
			const parts = line.trim().split(/\s+/);
			const pid = parseInt(parts[1]!, 10);
			if (!pid || isNaN(pid)) continue;
			try { 
				process.kill(pid, "SIGTERM"); 
				log(`Killed orphan TTS process (PID ${pid})`); 
			} catch {}
		}
	} catch { /* no orphans */ }
}

export function muteDaemon(commsDir: string) {
	const muteFile = join(commsDir, "tts_playing");
	try { writeFileSync(muteFile, String(Date.now())); } catch {}
}

export function tryUnmuteDaemon(commsDir: string) {
	const muteFile = join(commsDir, "tts_playing");
	try { if (existsSync(muteFile)) rmSync(muteFile, { force: true }); } catch {}
}

export function triggerDaemonListen(
	commsDir: string, 
	wakeDaemon: ChildProcess | null, 
	waitForSpeechSec = 5, 
	maxRecordSec = 10
) {
	try {
		if (!wakeDaemon) return;
		const listenNowFile = join(commsDir, "listen_now");
		const payload = JSON.stringify({
			timestamp: Date.now(),
			waitForSpeech: waitForSpeechSec,
			maxRecord: maxRecordSec,
		});
		writeFileSync(listenNowFile, payload);
	} catch (e) { 
		logError("triggerDaemonListen", e); 
	}
}

export function estimateReadingTimeSec(text: string): number {
	try { return text.trim().split(/\s+/).length / 3.5; } catch { return 2; }
}

export function isQuestion(text: string): boolean {
	try {
		const trimmed = text.trim();
		if (trimmed.endsWith("?")) return true;
		const questionPatterns = /\b(what do you think|which do you prefer|want me to|should I|shall I|sound good|ready to|let me know|your call|up to you)\b/i;
		return questionPatterns.test(trimmed);
	} catch { return false; }
}

export function estimateQuestionTiming(question: string): { waitSec: number; maxRecordSec: number } {
	try {
		const q = question.trim().toLowerCase();
		const yesNo = /\b(is it|are you|do you|did you|will you|can you|have you|was it|were you|is that|does it|right\??|correct\??|ready\??|sure\??)\b/i;
		const choiceAB = /\b(or )\b/i;
		const oneWord = /\b(what color|what colour|what is the capital|what year|how many|how old|what number|which one|what day|what month)\b/i;

		if (yesNo.test(q)) return { waitSec: 4, maxRecordSec: 5 };
		if (choiceAB.test(q) || oneWord.test(q)) return { waitSec: 5, maxRecordSec: 6 };

		const shortFactual = /^(what|who|where|when|which)\b/i;
		if (shortFactual.test(q)) return { waitSec: 5, maxRecordSec: 8 };

		const openEnded = /^(how|why|explain|describe|tell me about|what do you think)\b/i;
		if (openEnded.test(q)) return { waitSec: 6, maxRecordSec: 15 };
	} catch {}
	return { waitSec: 5, maxRecordSec: 10 };
}

let voiceMessageCount = 0;

export function deriveVoiceText(message: string, voiceSummary?: string): string {
	voiceMessageCount++;
	if (voiceSummary) return voiceSummary;

	const plain = message.replace(/[\n\r]+/g, " ").trim();
	if (plain.length <= 200) return plain;

	const sentences = plain.match(/[^.!?]+[.!?]+/g) ?? [plain];
	let spoken = "";
	for (const s of sentences) {
		if (spoken.length + s.length > 200 && spoken.length > 0) break;
		spoken += s;
	}

	const PANEL_PHRASES = [
		`Full details in the panel.`,
		`More in the panel if you need it.`,
		`Rest is on screen.`,
		`Details on your screen.`,
	];

	const nudge = voiceMessageCount === 1 ? 
		` ${PANEL_PHRASES[Math.floor(Math.random() * PANEL_PHRASES.length)]!}` : "";
	return `${spoken.trim()}${nudge}`;
}

/** Speaks text via piper TTS. Fully hardened — never throws, always resolves. */
export function speakText(
	text: string,
	settings: FridaySettings,
	commsDir: string,
	wakeDaemon: ChildProcess | null,
	lastFullMessageText: string,
	lastSpokenText: string,
	lastMessageWasQuestion: boolean,
	log: (msg: string) => void,
	logError: (context: string, err: unknown) => void,
	onPlaybackStart?: () => void, 
	speed?: number
): Promise<void> {
	return new Promise((resolve) => {
		try {
			// Kill any active playback first — never two voices at once
			if (currentPlayer || currentPiper) {
				try { currentPlayer?.kill(); } catch {}
				try { currentPiper?.kill(); } catch {}
				currentPlayer = null;
				currentPiper = null;
			}

			// Register resolve so killCurrentVoice can settle this promise instantly
			activeSpeakResolve = resolve;

			const modelPath = getVoiceModelPath(settings);
			const effectiveSpeed = speed ?? 1.0;
			const lengthScale = String(1.0 / effectiveSpeed);

			muteDaemon(commsDir);

			const piper = spawn(
				"piper",
				["--model", modelPath, "--output-raw", "--length-scale", lengthScale],
				{ stdio: ["pipe", "pipe", "ignore"] },
			);

			const player = spawn(
				"play",
				["-q", "-t", "raw", "-r", "22050", "-e", "signed", "-b", "16", "-c", "1", "-"],
				{ stdio: ["pipe", "ignore", "ignore"] },
			);

			// Unref so these processes don't keep the event loop alive on shutdown
			piper.unref();
			player.unref();

			currentPiper = piper;
			currentPlayer = player;

			// CRITICAL: handle 'error' events on stdin streams to prevent
			// unhandled EPIPE crashes when processes die mid-stream
			piper.stdin.on("error", (e) => logError("piper.stdin", e));
			player.stdin.on("error", (e) => logError("player.stdin", e));

			let started = false;
			let resolved = false;
			const safeResolve = () => {
				if (!resolved) {
					resolved = true;
					if (activeSpeakResolve === resolve) activeSpeakResolve = null;
					resolve();
				}
			};

			piper.stdout.on("data", (chunk: Buffer) => {
				try {
					if (!started) {
						started = true;
						try { onPlaybackStart?.(); } catch (e) { logError("onPlaybackStart", e); }
					}
					player.stdin.write(chunk);
				} catch {}
			});
			piper.stdout.on("end", () => {
				try { player.stdin.end(); } catch {}
			});

			try { piper.stdin.write(text); piper.stdin.end(); } catch (e) { logError("piper.stdin.write", e); }

			const cleanup = () => {
				try {
					// Only null refs if they still point to OUR processes
					if (currentPiper === piper) currentPiper = null;
					if (currentPlayer === player) currentPlayer = null;

					// If force-killed, skip all daemon interaction
					if (voiceForceKilled) {
						voiceForceKilled = false;
						safeResolve();
						return;
					}

					// Natural end — unmute daemon and maybe auto-listen
					// CRITICAL FIX: Add .unref() to background timer
					setTimeout(() => {
						try {
							tryUnmuteDaemon(commsDir);
							if (wakeDaemon && isQuestion(text)) {
								lastMessageWasQuestion = true;
								const fullReadTime = estimateReadingTimeSec(lastFullMessageText);
								const spokenTime = estimateReadingTimeSec(lastSpokenText);
								const extraReadMs = Math.max(0, (fullReadTime - spokenTime)) * 1000;
								const baseDelayMs = 500;
								const totalDelay = baseDelayMs + extraReadMs;
								const timing = estimateQuestionTiming(text);
								// CRITICAL FIX: Add .unref() to background timer
								setTimeout(() => {
									try { triggerDaemonListen(commsDir, wakeDaemon, timing.waitSec, timing.maxRecordSec); }
									catch (e) { logError("triggerDaemonListen.timer", e); }
								}, totalDelay).unref();
							} else {
								lastMessageWasQuestion = false;
							}
						} catch (e) { logError("speakText.cleanup.timer", e); }
					}, 500).unref();
				} catch (e) { logError("speakText.cleanup", e); }
				safeResolve();
			};

			player.on("close", cleanup);
			player.on("error", () => { try { cleanup(); } catch {} });
			piper.on("error", () => { try { player.kill(); } catch {} try { cleanup(); } catch {} });

			// Safety net — 5s is plenty, the old 30s was causing /reload to hang
			setTimeout(() => safeResolve(), 5000).unref();
		} catch (e) {
			logError("speakText", e);
			resolve(); // always resolve — never leave a dangling promise
		}
	});
}

export function enqueueVoiceWithMessage(
	text: string, 
	log: (msg: string) => void,
	logError: (context: string, err: unknown) => void,
	speed?: number,
	standalone?: boolean,
) {
	try {
		// Kill anything currently playing — never allow two voices at once
		if (voicePlaying || currentPlayer || currentPiper) {
			killCurrentVoice();
		}
		voiceQueue.push({ text, speed, standalone });
		if (!voicePlaying) {
			// processVoiceQueueSynced will be called by the main module
		}
	} catch (e) { 
		logError("enqueueVoice", e); 
	}
}

export function processVoiceQueueSynced(
	ensurePanelOpen: () => Promise<boolean>,
	writeMessage: (text: string, standalone?: boolean) => void,
	settings: FridaySettings,
	commsDir: string,
	wakeDaemon: ChildProcess | null,
	lastFullMessageText: string,
	lastSpokenText: string,
	lastMessageWasQuestion: boolean,
	log: (msg: string) => void,
	logError: (context: string, err: unknown) => void,
): void {
	try {
		if (voiceQueue.length === 0) {
			voicePlaying = false;
			return;
		}
		voicePlaying = true;
		const item = voiceQueue.shift()!;
		ensurePanelOpen().then((ok) => {
			speakText(
				item.text, 
				settings, 
				commsDir, 
				wakeDaemon, 
				lastFullMessageText, 
				lastSpokenText, 
				lastMessageWasQuestion, 
				log, 
				logError,
				() => {
					try { if (ok) writeMessage(item.text, item.standalone); } catch (e) { logError("voiceQueue.writeMessage", e); }
				}, 
				item.speed
			).finally(() => {
				try { 
					processVoiceQueueSynced(
						ensurePanelOpen, 
						writeMessage, 
						settings, 
						commsDir, 
						wakeDaemon, 
						lastFullMessageText, 
						lastSpokenText, 
						lastMessageWasQuestion, 
						log, 
						logError
					); 
				} catch (e) { 
					logError("voiceQueue.next", e); 
				}
			});
		}).catch((e) => {
			logError("voiceQueue.ensurePanel", e);
			voicePlaying = false;
		});
	} catch (e) {
		logError("processVoiceQueueSynced", e);
		voicePlaying = false;
	}
}

// Helper functions that need to be exported for other modules to use
let log: (msg: string) => void = () => {};
let logError: (context: string, err: unknown) => void = () => {};

export function setLogFunctions(
	logFn: (msg: string) => void, 
	logErrorFn: (context: string, err: unknown) => void
) {
	log = logFn;
	logError = logErrorFn;
}