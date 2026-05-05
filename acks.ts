/**
 * Friday Extension - Acknowledgment System Module
 * Acknowledgment phrases, classification, scheduling, and delivery
 *
 * Supports custom per-voice acks via the persona extension.
 * Reads ~/.pi/agent/persona/settings.json for a voiceAckPath field
 * pointing to a directory of {voice}.json ack files.
 * Falls back to built-in defaults when no custom acks are found.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { ChildProcess } from "node:child_process";
import type { FridaySettings } from "./settings.js";

const DEFAULT_PANEL_PHRASES = [
	`Full details in the panel.`,
	`More in the panel if you need it.`,
	`Rest is on screen.`,
	`Details on your screen.`,
];

export type AckCategory = "investigate" | "build" | "research" | "fix" | "general" | "question";

const DEFAULT_ACK_PHRASES: Record<AckCategory, string[]> = {
	investigate: [
		"Looking into it.", "Let me check.", "Starting the investigation.",
		"Pulling up the details now.", "Let me trace through that.",
		"On it. Give me a moment.", "Checking that now.",
	],
	build: [
		"On it.", "Starting now.", "I'll get that set up.",
		"Building it out.", "Consider it started.",
		"Spinning that up now.", "Alright, putting it together.",
	],
	research: [
		"Let me look that up.", "Searching now.", "I'll find out.",
		"Running a search.", "Let me dig into that.", "Pulling up what I can find.",
	],
	fix: [
		"I see the issue. Working on it.", "Let me patch that up.",
		"On it. Should have a fix shortly.", "Addressing that now.",
		"I'll sort that out.", "Fixing it.",
	],
	general: [
		"Copy that.", "Understood.", "Right away.", "Working on it.",
		"One moment.", "Got it.", "Acknowledged.", "Processing.",
	],
	question: [
		"One sec.", "Let me check.", "I'll look into that.",
		"Let me see.", "Hmm, let me think.", "Good question. Let me check.",
		"Let me find out.", "Checking.",
	],
};

/** Active ack phrases — may be overridden by persona voice acks */
export let ACK_PHRASES: Record<AckCategory, string[]> = { ...DEFAULT_ACK_PHRASES };
export let PANEL_PHRASES: string[] = [...DEFAULT_PANEL_PHRASES];

const PERSONA_SETTINGS_PATH = join(homedir(), ".pi", "agent", "persona", "settings.json");

/**
 * Load custom ack phrases from the persona extension's voice-acks directory.
 * Reads persona/settings.json → voiceAckPath → {voice}.json.
 * Falls back to defaults if anything is missing.
 */
export function loadVoiceAcks(): void {
	try {
		if (!existsSync(PERSONA_SETTINGS_PATH)) return;
		const settings = JSON.parse(readFileSync(PERSONA_SETTINGS_PATH, "utf-8"));
		const ackPath = settings.voiceAckPath;
		const voice = settings.voice;
		if (!ackPath || !voice) return;

		const ackFile = join(ackPath, `${voice}.json`);
		if (!existsSync(ackFile)) return;

		const custom = JSON.parse(readFileSync(ackFile, "utf-8"));

		// Merge: override only categories present in the custom file
		const merged = { ...DEFAULT_ACK_PHRASES };
		for (const cat of Object.keys(DEFAULT_ACK_PHRASES) as AckCategory[]) {
			if (Array.isArray(custom[cat]) && custom[cat].length > 0) {
				merged[cat] = custom[cat];
			}
		}
		ACK_PHRASES = merged;

		// Panel phrases
		if (Array.isArray(custom.panel) && custom.panel.length > 0) {
			PANEL_PHRASES = custom.panel;
		} else {
			PANEL_PHRASES = [...DEFAULT_PANEL_PHRASES];
		}
	} catch {
		// Any failure — silently fall back to defaults
		ACK_PHRASES = { ...DEFAULT_ACK_PHRASES };
		PANEL_PHRASES = [...DEFAULT_PANEL_PHRASES];
	}
}

export const ACK_PATTERNS: { pattern: RegExp; category: AckCategory }[] = [
	{ pattern: /\b(investigat|diagnos|debug|check|look into|what.s wrong|why is|trace)\b/i, category: "investigate" },
	{ pattern: /\b(fix|repair|patch|resolve|broken|bug|error|fail|crash)\b/i, category: "fix" },
	{ pattern: /\b(search|find|research|look up|compare|what are|which|best|recommend)\b/i, category: "research" },
	{ pattern: /\b(build|create|add|implement|make|set up|write|generate|scaffold|deploy)\b/i, category: "build" },
];

export function hasUnquotedQuestionMark(text: string): boolean {
	// Strip quoted/backticked content, then check for ?
	const stripped = text
		.replace(/`[^`]*`/g, "")
		.replace(/"[^"]*"/g, "")
		.replace(/'[^']*'/g, "");
	return stripped.includes("?");
}

export function classifyPrompt(text: string): AckCategory {
	if (hasUnquotedQuestionMark(text)) return "question";
	for (const { pattern, category } of ACK_PATTERNS) {
		if (pattern.test(text)) return category;
	}
	return "general";
}

export function pickAck(
	category: AckCategory,
	lastAckCategory: { value: AckCategory | null },
	lastAckIndex: { value: number },
): string {
	const phrases = ACK_PHRASES[category];
	let idx: number;
	do {
		idx = Math.floor(Math.random() * phrases.length);
	} while (idx === lastAckIndex.value && category === lastAckCategory.value && phrases.length > 1);
	lastAckCategory.value = category;
	lastAckIndex.value = idx;
	return phrases[idx]!;
}

export function pickPanelPhrase(): string {
	return PANEL_PHRASES[Math.floor(Math.random() * PANEL_PHRASES.length)]!;
}

export function cancelAck(ackTimer: { value: ReturnType<typeof setTimeout> | null }) {
	try {
		if (ackTimer.value) { 
			clearTimeout(ackTimer.value); 
			ackTimer.value = null; 
		}
	} catch {}
}

export function scheduleAck(
	prompt: string,
	ackTimer: { value: ReturnType<typeof setTimeout> | null },
	lastMessageWasQuestion: { value: boolean },
	lastAgentEndTime: number,
	interactionCount: { value: number },
	lastAckCategory: { value: AckCategory | null },
	lastAckIndex: { value: number },
	showAndSpeak: (text: string) => void,
	logError: (context: string, err: unknown) => void,
) {
	try {
		cancelAck(ackTimer);
		const ackCancelled = { value: false };

		if (lastMessageWasQuestion.value) {
			lastMessageWasQuestion.value = false;
			return;
		}

		const now = Date.now();
		const MOMENTUM_WINDOW_MS = 30000;
		const inMomentum = (now - lastAgentEndTime) < MOMENTUM_WINDOW_MS;

		if (inMomentum) {
			interactionCount.value++;
		} else {
			interactionCount.value = 0;
		}

		if (interactionCount.value >= 3) return;
		if (interactionCount.value > 0 && Math.random() > 1 / (interactionCount.value + 1)) return;

		const category = classifyPrompt(prompt);
		const ack = pickAck(category, lastAckCategory, lastAckIndex);

		const ACK_DELAY_MS = 2000;
		// CRITICAL FIX: Add .unref() to ack timer
		ackTimer.value = setTimeout(() => {
			try {
				if (ackCancelled.value) return;
				showAndSpeak(ack);
			} catch (e) { logError("ackTimer.callback", e); }
		}, ACK_DELAY_MS).unref();
	} catch (e) { logError("scheduleAck", e); }
}

export function showAndSpeak(
	text: string,
	voiceEnabled: boolean,
	ensurePanelOpen: () => Promise<boolean>,
	writeMessage: (text: string, standalone?: boolean) => void,
	enqueueVoiceWithMessage: (text: string, speed?: number, standalone?: boolean) => void,
	settings: FridaySettings,
	logError: (context: string, err: unknown) => void,
) {
	try {
		if (voiceEnabled) {
			enqueueVoiceWithMessage(text, settings.voice.speed, true);
		} else {
			ensurePanelOpen().then((ok) => {
				try { if (ok) writeMessage(text, true); } catch (e) { logError("showAndSpeak.panel", e); }
			}).catch((e) => logError("showAndSpeak.ensurePanel", e));
		}
	} catch (e) { logError("showAndSpeak", e); }
}