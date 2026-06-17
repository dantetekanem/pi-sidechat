/**
 * Sidechat Extension - Acknowledgment Messages
 * Short optional panel acknowledgments shown while the agent starts work.
 */

import type { SidechatSettings } from "./settings.js";

export type AckCategory = "investigate" | "build" | "research" | "fix" | "general" | "question";

const ACK_PHRASES: Record<AckCategory, string[]> = {
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
		"Let me see.", "Good question. Let me check.",
		"Let me find out.", "Checking.",
	],
};

const ACK_PATTERNS: { pattern: RegExp; category: AckCategory }[] = [
	{ pattern: /\b(investigat|diagnos|debug|check|look into|what.s wrong|why is|trace)\b/i, category: "investigate" },
	{ pattern: /\b(fix|repair|patch|resolve|broken|bug|error|fail|crash)\b/i, category: "fix" },
	{ pattern: /\b(search|find|research|look up|compare|what are|which|best|recommend)\b/i, category: "research" },
	{ pattern: /\b(build|create|add|implement|make|set up|write|generate|scaffold|deploy)\b/i, category: "build" },
];

export function hasUnquotedQuestionMark(text: string): boolean {
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

function pickAck(
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

export function cancelAck(ackTimer: { value: ReturnType<typeof setTimeout> | null }): void {
	try {
		if (!ackTimer.value) return;
		clearTimeout(ackTimer.value);
		ackTimer.value = null;
	} catch {}
}

export function scheduleAck(
	prompt: string,
	settings: SidechatSettings,
	ackTimer: { value: ReturnType<typeof setTimeout> | null },
	lastAgentEndTime: { value: number },
	interactionCount: { value: number },
	lastAckCategory: { value: AckCategory | null },
	lastAckIndex: { value: number },
	deliver: (text: string) => void,
	logError: (context: string, err: unknown) => void,
): void {
	try {
		cancelAck(ackTimer);
		if (!settings.acks.enabled) return;
		const trimmedPrompt = prompt.trim();
		if (!trimmedPrompt || trimmedPrompt.startsWith("/")) return;

		const now = Date.now();
		const momentumWindowMs = 30_000;
		const inMomentum = now - lastAgentEndTime.value < momentumWindowMs;
		if (inMomentum) interactionCount.value++;
		else interactionCount.value = 0;

		if (interactionCount.value >= 3) return;
		if (interactionCount.value > 0 && Math.random() > 1 / (interactionCount.value + 1)) return;

		const category = classifyPrompt(trimmedPrompt);
		const ack = pickAck(category, lastAckCategory, lastAckIndex);
		const delayMs = Math.max(250, Math.min(10_000, Math.floor(settings.acks.delayMs)));

		const timer = setTimeout(() => {
			try {
				ackTimer.value = null;
				deliver(ack);
			} catch (e) { logError("ackTimer.callback", e); }
		}, delayMs);
		if (typeof (timer as any).unref === "function") (timer as any).unref();
		ackTimer.value = timer;
	} catch (e) { logError("scheduleAck", e); }
}
