/**
 * Sidechat Extension - Panel Management Module
 * Tmux panel operations, message writing, and display scripts
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { writeFileSync, mkdirSync, appendFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { SidechatSettings } from "./settings.js";

export type MessageStackMode = "normal" | "standalone";

export type PanelOpenResult = { success: boolean; paneId: string | null; emotePaneId: string | null; todoPaneId: string | null; paneWidth: number };

type ManagedPane = { id: string; role: string; owner: string; parent: string };

const SIDECHAT_EMOTE_PANE_HEIGHT = 12;
const SIDECHAT_EMPTY_EMOTE_PANE_HEIGHT = 1;

const openPanelLocks = new Map<string, Promise<PanelOpenResult>>();

function hasTodoContent(todosFile: string): boolean {
	try {
		return existsSync(todosFile) && readFileSync(todosFile, "utf-8").trim().length > 0;
	} catch {
		return false;
	}
}

function getTodoPaneHeight(todosFile: string): number {
	try {
		if (!existsSync(todosFile)) return 1;
		const content = readFileSync(todosFile, "utf-8").trim();
		if (!content) return 1;
		const lineCount = content.split("\n").filter((line) => line.length > 0).length;
		return Math.max(1, Math.min(14, lineCount + 2));
	} catch {
		return 1;
	}
}

function getEmotePaneHeight(emoteFile: string): number {
	try {
		if (!existsSync(emoteFile)) return SIDECHAT_EMPTY_EMOTE_PANE_HEIGHT;
		const content = readFileSync(emoteFile, "utf-8");
		if (!content.trim()) return SIDECHAT_EMPTY_EMOTE_PANE_HEIGHT;
		return SIDECHAT_EMOTE_PANE_HEIGHT;
	} catch {
		return SIDECHAT_EMPTY_EMOTE_PANE_HEIGHT;
	}
}

async function listManagedPanes(
	pi: ExtensionAPI,
	targetPaneId: string | null,
	logError: (context: string, err: unknown) => void,
): Promise<ManagedPane[]> {
	if (!targetPaneId || !process.env.TMUX) return [];
	try {
		const result = await pi.exec("tmux", [
			"list-panes", "-t", targetPaneId, "-F",
			"#{pane_id}\t#{@sidechat_role}\t#{@sidechat_owner}\t#{@sidechat_parent}",
		]);
		if (result.code !== 0) return [];
		return result.stdout
			.trim()
			.split("\n")
			.filter((line) => line.trim().length > 0)
			.map((line) => {
				const [id = "", role = "", owner = "", parent = ""] = line.split("\t");
				return { id, role, owner, parent };
			})
			.filter((pane) => pane.id.length > 0);
	} catch (e) {
		logError("listManagedPanes", e);
		return [];
	}
}

async function killManagedPanes(
	pi: ExtensionAPI,
	panes: ManagedPane[],
	keepPaneIds: Set<string>,
	logError: (context: string, err: unknown) => void,
	log?: (message: string) => void,
) {
	for (const pane of panes) {
		if (!pane.id || keepPaneIds.has(pane.id)) continue;
		try {
			await killPane(pi, pane.id);
			log?.(`Killed duplicate Sidechat ${pane.role || "panel"} pane ${pane.id}`);
		} catch (e) {
			logError("killManagedPanes", e);
		}
	}
}

async function cleanupManagedPanelStack(
	pi: ExtensionAPI,
	ownerPaneId: string | null,
	keepPaneIds: Set<string>,
	logError: (context: string, err: unknown) => void,
	log?: (message: string) => void,
) {
	if (!ownerPaneId) return;
	const panes = await listManagedPanes(pi, ownerPaneId, logError);
	const ownedComms = panes.filter((pane) => pane.role === "comms" && pane.owner === ownerPaneId);
	const ownedCommsIds = new Set(ownedComms.map((pane) => pane.id));
	const ownedChildren = panes.filter((pane) => (pane.role === "todo" || pane.role === "emote") && ownedCommsIds.has(pane.parent));
	await killManagedPanes(pi, [...ownedChildren, ...ownedComms], keepPaneIds, logError, log);
}

async function cleanupChildPanesForParent(
	pi: ExtensionAPI,
	parentPaneId: string,
	role: "todo" | "emote",
	keepPaneId: string | null,
	logError: (context: string, err: unknown) => void,
	log?: (message: string) => void,
) {
	const panes = await listManagedPanes(pi, parentPaneId, logError);
	const keepPaneIds = new Set<string>();
	if (keepPaneId) keepPaneIds.add(keepPaneId);
	const matches = panes.filter((pane) => pane.role === role && pane.parent === parentPaneId);
	await killManagedPanes(pi, matches, keepPaneIds, logError, log);
}

async function cleanupTodoPanesForParent(
	pi: ExtensionAPI,
	parentPaneId: string,
	keepTodoPaneId: string | null,
	logError: (context: string, err: unknown) => void,
	log?: (message: string) => void,
) {
	await cleanupChildPanesForParent(pi, parentPaneId, "todo", keepTodoPaneId, logError, log);
}

async function cleanupEmotePanesForParent(
	pi: ExtensionAPI,
	parentPaneId: string,
	keepEmotePaneId: string | null,
	logError: (context: string, err: unknown) => void,
	log?: (message: string) => void,
) {
	await cleanupChildPanesForParent(pi, parentPaneId, "emote", keepEmotePaneId, logError, log);
}

async function openEmotePane(
	pi: ExtensionAPI,
	commsDir: string,
	emoteFile: string,
	parentPaneId: string,
	logError: (context: string, err: unknown) => void,
	log?: (message: string) => void,
): Promise<string | null> {
	try {
		await cleanupEmotePanesForParent(pi, parentPaneId, null, logError, log);
		const emoteScript = join(commsDir, "emote.pl");
		writeFileSync(emoteScript, buildEmoteDisplayScript(), { mode: 0o755 });

		const result = await pi.exec("tmux", [
			"split-window", "-v", "-b", "-d", "-t", parentPaneId,
			"-l", String(getEmotePaneHeight(emoteFile)),
			"-P", "-F", "#{pane_id}",
			"perl", emoteScript, emoteFile,
		]);
		const emotePaneId = result.stdout.trim();
		if (!emotePaneId || result.code !== 0) return null;

		try {
			await pi.exec("tmux", ["set-option", "-p", "-t", emotePaneId, "allow-passthrough", "on"]);
			await pi.exec("tmux", ["set-option", "-p", "-t", emotePaneId, "@sidechat_role", "emote"]);
			await pi.exec("tmux", ["set-option", "-p", "-t", emotePaneId, "@sidechat_parent", parentPaneId]);
		} catch { /* non-critical */ }

		return emotePaneId;
	} catch (e) {
		logError("openEmotePane", e);
		return null;
	}
}

async function enforceEmotePaneHeight(
	pi: ExtensionAPI,
	emoteFile: string,
	emotePaneId: string | null,
	logError: (context: string, err: unknown) => void,
) {
	try {
		if (!emotePaneId || !process.env.TMUX) return;
		await pi.exec("tmux", ["resize-pane", "-t", emotePaneId, "-y", String(getEmotePaneHeight(emoteFile))]);
	} catch (e) {
		logError("enforceEmotePaneHeight", e);
	}
}

async function openTodoPane(
	pi: ExtensionAPI,
	commsDir: string,
	todosFile: string,
	parentPaneId: string,
	logError: (context: string, err: unknown) => void,
	log?: (message: string) => void,
): Promise<string | null> {
	try {
		if (!hasTodoContent(todosFile)) return null;
		await cleanupTodoPanesForParent(pi, parentPaneId, null, logError, log);
		const todoScript = join(commsDir, "todos.pl");
		writeFileSync(todoScript, buildTodoDisplayScript(), { mode: 0o755 });

		const result = await pi.exec("tmux", [
			"split-window", "-v", "-d", "-t", parentPaneId,
			"-l", String(getTodoPaneHeight(todosFile)),
			"-P", "-F", "#{pane_id}",
			"perl", todoScript, todosFile,
		]);
		const todoPaneId = result.stdout.trim();
		if (!todoPaneId || result.code !== 0) return null;

		try {
			await pi.exec("tmux", ["set-option", "-p", "-t", todoPaneId, "allow-passthrough", "on"]);
			await pi.exec("tmux", ["set-option", "-p", "-t", todoPaneId, "@sidechat_role", "todo"]);
			await pi.exec("tmux", ["set-option", "-p", "-t", todoPaneId, "@sidechat_parent", parentPaneId]);
		} catch { /* non-critical */ }

		return todoPaneId;
	} catch (e) {
		logError("openTodoPane", e);
		return null;
	}
}

async function enforceConfiguredPanelWidth(
	pi: ExtensionAPI,
	settings: SidechatSettings,
	ownerPaneId: string | null,
	paneId: string | null,
	logError: (context: string, err: unknown) => void,
) {
	try {
		if (!paneId || !process.env.TMUX) return;
		const targetPane = ownerPaneId ?? paneId;
		const widthResult = await pi.exec("tmux", ["display-message", "-t", targetPane, "-p", "#{window_width}"]);
		const windowWidth = parseInt(widthResult.stdout.trim(), 10);
		if (!Number.isFinite(windowWidth) || windowWidth <= 0) return;
		const targetWidth = Math.max(20, Math.floor(windowWidth * (settings.panelWidth / 100)));
		await pi.exec("tmux", ["resize-pane", "-t", paneId, "-x", String(targetWidth)]);
	} catch (e) {
		logError("enforceConfiguredPanelWidth", e);
	}
}

export async function openPanel(
	pi: ExtensionAPI,
	settings: SidechatSettings,
	commsDir: string,
	messagesFile: string,
	todosFile: string,
	emoteFile: string,
	ownerPaneId: string | null,
	logError: (context: string, err: unknown) => void,
	log?: (message: string) => void,
): Promise<PanelOpenResult> {
	const lockKey = ownerPaneId ?? "global";
	const existing = openPanelLocks.get(lockKey);
	if (existing) return existing;

	const opening = openPanelUnlocked(pi, settings, commsDir, messagesFile, todosFile, emoteFile, ownerPaneId, logError, log)
		.finally(() => openPanelLocks.delete(lockKey));
	openPanelLocks.set(lockKey, opening);
	return opening;
}

async function openPanelUnlocked(
	pi: ExtensionAPI,
	settings: SidechatSettings,
	commsDir: string,
	messagesFile: string,
	todosFile: string,
	emoteFile: string,
	ownerPaneId: string | null,
	logError: (context: string, err: unknown) => void,
	log?: (message: string) => void,
): Promise<PanelOpenResult> {
	try {
		if (!process.env.TMUX) return { success: false, paneId: null, emotePaneId: null, todoPaneId: null, paneWidth: 38 };

		mkdirSync(commsDir, { recursive: true });
		writeFileSync(messagesFile, "");
		if (!existsSync(todosFile)) writeFileSync(todosFile, "");
		await cleanupManagedPanelStack(pi, ownerPaneId, new Set(), logError, log);

		const displayScript = join(commsDir, "display.pl");
		writeFileSync(displayScript, buildDisplayScript(), { mode: 0o755 });

		// Use ownerPaneId so we always query/split in the correct tmux window,
		// even when the user's focus is on a different window/tab.
		const targetArgs = ownerPaneId ? ["-t", ownerPaneId] : [];

		const layoutInfo = await pi.exec("tmux", [
			"display-message", ...targetArgs, "-p", "#{pane_at_right}",
		]);
		const atRightEdge = layoutInfo.stdout.trim() === "1";

		let splitArgs: string[];

		if (!atRightEdge) {
			const panesResult = await pi.exec("tmux", [
				"list-panes", ...targetArgs, "-F", "#{pane_id} #{pane_left}",
			]);
			const panes = panesResult.stdout
				.trim()
				.split("\n")
				.map((line) => {
					const [id, left] = line.split(" ");
					return { id: id!, left: parseInt(left!, 10) };
				});
			const rightmost = panes.reduce((a, b) =>
				b.left > a.left ? b : a,
			);

			splitArgs = [
				"split-window", "-v", "-d", "-t", rightmost.id,
				"-p", String(settings.panelWidth), "-P", "-F", "#{pane_id}",
				"perl", displayScript, messagesFile,
			];
		} else {
			splitArgs = [
				"split-window", "-h", "-d", ...targetArgs,
				"-p", String(settings.panelWidth),
				"-P", "-F", "#{pane_id}",
				"perl", displayScript, messagesFile,
			];
		}

		const result = await pi.exec("tmux", splitArgs);
		const paneId = result.stdout.trim();

		if (!paneId || result.code !== 0) {
			cleanupFiles(commsDir);
			return { success: false, paneId: null, emotePaneId: null, todoPaneId: null, paneWidth: 38 };
		}

		try {
			await pi.exec("tmux", [
				"set-option", "-p", "-t", paneId, "allow-passthrough", "on",
			]);
			await pi.exec("tmux", ["set-option", "-p", "-t", paneId, "@sidechat_role", "comms"]);
			if (ownerPaneId) {
				await pi.exec("tmux", ["set-option", "-p", "-t", paneId, "@sidechat_owner", ownerPaneId]);
			}
		} catch { /* non-critical */ }

		const todoPaneId = await openTodoPane(pi, commsDir, todosFile, paneId, logError, log);
		const emotePaneId = null;
		await enforceConfiguredPanelWidth(pi, settings, ownerPaneId, paneId, logError);

		let paneWidth: number;
		try {
			const w = await pi.exec("tmux", [
				"display-message", "-t", paneId, "-p", "#{pane_width}",
			]);
			paneWidth = (parseInt(w.stdout.trim()) || 44) - 6;
		} catch {
			paneWidth = 38;
		}

		return { success: true, paneId, emotePaneId, todoPaneId, paneWidth };
	} catch (e) {
		logError("openPanel", e);
		return { success: false, paneId: null, emotePaneId: null, todoPaneId: null, paneWidth: 38 };
	}
}

export async function killPane(pi: ExtensionAPI, paneId: string | null) {
	if (paneId) {
		try { await pi.exec("tmux", ["kill-pane", "-t", paneId]); } catch {}
	}
}

export async function syncEmotePane(
	pi: ExtensionAPI,
	commsDir: string,
	emoteFile: string,
	parentPaneId: string | null,
	emotePaneId: string | null,
	logError: (context: string, err: unknown) => void,
): Promise<string | null> {
	try {
		if (!parentPaneId || !(await isPaneAlive(pi, parentPaneId))) {
			if (emotePaneId && (await isPaneAlive(pi, emotePaneId))) await killPane(pi, emotePaneId);
			return null;
		}

		if (emotePaneId && (await isPaneAlive(pi, emotePaneId))) {
			await cleanupEmotePanesForParent(pi, parentPaneId, emotePaneId, logError);
			await enforceEmotePaneHeight(pi, emoteFile, emotePaneId, logError);
			return emotePaneId;
		}
		return await openEmotePane(pi, commsDir, emoteFile, parentPaneId, logError);
	} catch (e) {
		logError("syncEmotePane", e);
		return null;
	}
}

export async function syncTodoPane(
	pi: ExtensionAPI,
	commsDir: string,
	todosFile: string,
	parentPaneId: string | null,
	todoPaneId: string | null,
	logError: (context: string, err: unknown) => void,
): Promise<string | null> {
	try {
		if (!parentPaneId || !(await isPaneAlive(pi, parentPaneId))) {
			if (todoPaneId && (await isPaneAlive(pi, todoPaneId))) await killPane(pi, todoPaneId);
			return null;
		}

		if (!hasTodoContent(todosFile)) {
			await cleanupTodoPanesForParent(pi, parentPaneId, null, logError);
			return null;
		}

		if (todoPaneId && (await isPaneAlive(pi, todoPaneId))) {
			await cleanupTodoPanesForParent(pi, parentPaneId, todoPaneId, logError);
			return todoPaneId;
		}
		return await openTodoPane(pi, commsDir, todosFile, parentPaneId, logError);
	} catch (e) {
		logError("syncTodoPane", e);
		return null;
	}
}

export async function isPaneAlive(pi: ExtensionAPI, paneId: string | null): Promise<boolean> {
	if (!paneId) return false;
	try {
		const result = await pi.exec("tmux", [
			"display-message", "-t", paneId, "-p", "#{pane_id}",
		]);
		return result.code === 0 && result.stdout.trim() === paneId;
	} catch { return false; }
}

export async function ensurePanelOpen(
	pi: ExtensionAPI,
	settings: SidechatSettings,
	commsDir: string,
	messagesFile: string,
	todosFile: string,
	emoteFile: string,
	ownerPaneId: string | null,
	paneId: string | null,
	emotePaneId: string | null,
	todoPaneId: string | null,
	logError: (context: string, err: unknown) => void,
	_log?: (message: string) => void,
): Promise<PanelOpenResult> {
	try {
		if (paneId && (await isPaneAlive(pi, paneId))) {
			const keepPaneIds = new Set<string>([paneId]);
			if (todoPaneId) keepPaneIds.add(todoPaneId);
			await cleanupManagedPanelStack(pi, ownerPaneId, keepPaneIds, logError, _log);
			const nextTodoPaneId = await syncTodoPane(pi, commsDir, todosFile, paneId, todoPaneId, logError);
			const nextEmotePaneId = null;
			await enforceConfiguredPanelWidth(pi, settings, ownerPaneId, paneId, logError);

			let paneWidth: number;
			try {
				const w = await pi.exec("tmux", [
					"display-message", "-t", paneId, "-p", "#{pane_width}",
				]);
				paneWidth = (parseInt(w.stdout.trim()) || 44) - 6;
			} catch {
				paneWidth = 38;
			}
			return { success: true, paneId, emotePaneId: nextEmotePaneId, todoPaneId: nextTodoPaneId, paneWidth };
		}
		return await openPanel(pi, settings, commsDir, messagesFile, todosFile, emoteFile, ownerPaneId, logError, _log);
	} catch (e) {
		logError("ensurePanelOpen", e);
		return { success: false, paneId: null, emotePaneId: null, todoPaneId: null, paneWidth: 38 };
	}
}

export function cleanupFiles(commsDir: string) {
	try { if (existsSync(commsDir)) rmSync(commsDir, { recursive: true }); } catch {}
}

export function writeMessage(
	text: string,
	messagesFile: string,
	paneWidth: number,
	settings: SidechatSettings,
	lastMessageTime: { value: number },
	logError: (context: string, err: unknown) => void,
	mode: MessageStackMode = "normal",
) {
	try {
		const now = new Date();
		const nowMs = now.getTime();
		const time = now.toLocaleTimeString("en-US", {
			hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit",
		});

		const FOLLOW_UP_WINDOW_MS = 15_000;
		const isStandalone = mode === "standalone";
		const isFollowUp = !isStandalone && nowMs - lastMessageTime.value < FOLLOW_UP_WINDOW_MS;
		lastMessageTime.value = isStandalone ? 0 : nowMs;

		const dim = "\x1b[2m";
		const cyan = "\x1b[36m";
		const reset = "\x1b[0m";
		const white = "\x1b[97m";
		const TW_START = settings.typewriter.enabled ? "\x01" : "";
		const TW_STOP = settings.typewriter.enabled ? "\x02" : "";

		let out = "";
		if (isFollowUp) {
			out += "\n";
		} else {
			out += "\x1b[2J\x1b[H";
			out += `\n${dim}${cyan}  ${time}${reset}\n\n`;
		}

		const wrapped = wordWrapStyled(text, paneWidth);
		const styleStack: string[] = [];
		out += TW_START;
		for (const line of wrapped) out += `${white}  ${renderSidechatStyleTags(line, white, styleStack)}${reset}\n`;
		out += TW_STOP;
		out += "\n";

		appendFileSync(messagesFile, out);
	} catch (e) { logError("writeMessage", e); }
}

/** Write a passthrough message copied while the Sidechat panel is hidden.
 *  Always appends — never clears the panel. Dimmer styling. */
export function writeMessagePassthrough(
	text: string,
	messagesFile: string,
	paneWidth: number,
	logError: (context: string, err: unknown) => void,
) {
	try {
		const reset = "\x1b[0m";
		const lightGray = "\x1b[38;5;249m"; // 256-color light gray, readable but distinct

		const wrapped = wordWrapStyled(text, paneWidth);
		const styleStack: string[] = [];
		let out = "\n";
		for (const line of wrapped) out += `${lightGray}  ${renderSidechatStyleTags(line, lightGray, styleStack)}${reset}\n`;
		out += "\n";

		appendFileSync(messagesFile, out);
	} catch (e) { logError("writeMessagePassthrough", e); }
}

const SIDECHAT_STYLE_TAGS: Record<string, string> = {
	b: "\x1b[1m",
	bold: "\x1b[1m",
	i: "\x1b[3m",
	italic: "\x1b[3m",
	dim: "\x1b[2m",
	red: "\x1b[31m",
	green: "\x1b[32m",
	yellow: "\x1b[33m",
	blue: "\x1b[34m",
	magenta: "\x1b[35m",
	cyan: "\x1b[36m",
	gray: "\x1b[38;5;249m",
	white: "\x1b[97m",
	accent: "\x1b[36m",
};
const SIDECHAT_STYLE_TAG_PATTERN = /<\/?(b|bold|i|italic|dim|red|green|yellow|blue|magenta|cyan|gray|white|accent)>/gi;

export function stripSidechatStyleTags(text: string): string {
	return text.replace(SIDECHAT_STYLE_TAG_PATTERN, "");
}

function activeSidechatStyleAnsi(stack: string[]): string {
	return stack.map((activeTag) => SIDECHAT_STYLE_TAGS[activeTag] ?? "").join("");
}

function visibleTextLength(text: string): number {
	return stripSidechatStyleTags(text).length;
}

export function renderSidechatStyleTags(text: string, baseAnsi: string, stack: string[] = []): string {
	let rendered = activeSidechatStyleAnsi(stack);
	rendered += text.replace(SIDECHAT_STYLE_TAG_PATTERN, (match, rawTag: string) => {
		const tag = rawTag.toLowerCase();
		const code = SIDECHAT_STYLE_TAGS[tag];
		if (!code) return match;

		if (!match.startsWith("</")) {
			stack.push(tag);
			return code;
		}

		const lastIndex = stack.lastIndexOf(tag);
		if (lastIndex >= 0) stack.splice(lastIndex, 1);
		return `\x1b[0m${baseAnsi}${activeSidechatStyleAnsi(stack)}`;
	});
	return rendered;
}

export function wordWrap(text: string, width: number): string[] {
	return wordWrapStyled(text, width).map(stripSidechatStyleTags);
}

export function wordWrapStyled(text: string, width: number): string[] {
	const lines: string[] = [];
	const paragraphs = text.split("\n");

	for (const para of paragraphs) {
		if (para.trim() === "") { lines.push(""); continue; }

		const words = para.split(/\s+/);
		let currentLine = "";

		for (const word of words) {
			const separatorLength = currentLine ? 1 : 0;
			const nextLength = visibleTextLength(currentLine) + separatorLength + visibleTextLength(word);
			if (nextLength > width && currentLine.length > 0) {
				lines.push(currentLine);
				currentLine = word;
			} else {
				currentLine = currentLine ? `${currentLine} ${word}` : word;
			}
		}

		if (currentLine) lines.push(currentLine);
	}

	return lines;
}

export function buildTodoDisplayScript(): string {
	return `#!/usr/bin/perl
use strict;
use warnings;

$| = 1;
binmode(STDOUT, ':utf8');

my $file = $ARGV[0] or die "Usage: $0 <todos-file>\\n";
my $last = '';
my $left_pad = '  ';

sub wanted_height {
    my ($content) = @_;
    my @lines = grep { length($_) > 0 } split /\\n/, $content;
    my $height = scalar(@lines) ? scalar(@lines) + 2 : 1;
    $height = 14 if $height > 14;
    $height = 1 if $height < 1;
    return $height;
}

sub resize_self {
    my ($height) = @_;
    return unless $ENV{TMUX_PANE};
    system('tmux', 'resize-pane', '-t', $ENV{TMUX_PANE}, '-y', $height);
}

sub clear_history {
    return unless $ENV{TMUX_PANE};
    system('tmux', 'clear-history', '-t', $ENV{TMUX_PANE});
}

sub redraw {
    my ($content) = @_;
    my $height = wanted_height($content);
    resize_self($height);
    clear_history();
    print "\\x1b[3J\\x1b[2J\\x1b[H";
    return unless length($content);
    my @lines = grep { length($_) > 0 } split /\\n/, $content;
    print "\n";
    print $left_pad . join("\n" . $left_pad, @lines);
    print "\n";
}

while (1) {
    my $content = '';
    if (-f $file && open my $fh, '<', $file) {
        binmode($fh, ':utf8');
        local $/;
        $content = <$fh> // '';
        close $fh;
    }
    if ($content =~ /^\s*$/s) {
        redraw('') if $last ne '';
        exit 0;
    }
    if ($content ne $last) {
        $last = $content;
        redraw($content);
    }
    select(undef, undef, undef, 0.2);
}
`;
}

export function buildEmoteDisplayScript(): string {
	return `#!/usr/bin/perl
use strict;
use warnings;

$| = 1;
binmode(STDOUT, ':utf8');

my $file = $ARGV[0] or die "Usage: $0 <emote-file>\\n";
my $last = '__pi_sidechat_emote_initial__';
my $fixed_height = ${SIDECHAT_EMOTE_PANE_HEIGHT};
my $empty_height = ${SIDECHAT_EMPTY_EMOTE_PANE_HEIGHT};

sub wanted_height {
    my ($content) = @_;
    return $empty_height if $content =~ /^\s*$/s;
    return $fixed_height;
}

sub resize_self {
    my ($height) = @_;
    return unless $ENV{TMUX_PANE};
    system('tmux', 'resize-pane', '-t', $ENV{TMUX_PANE}, '-y', $height);
}

sub clear_history {
    return unless $ENV{TMUX_PANE};
    system('tmux', 'clear-history', '-t', $ENV{TMUX_PANE});
}

sub redraw {
    my ($content) = @_;
    my $height = wanted_height($content);
    resize_self($height);
    clear_history();
    print "\\x1b[3J\\x1b[2J\\x1b[H";
    return if $content =~ /^\s*$/s;
    print $content;
}

while (1) {
    my $content = '';
    if (-f $file && open my $fh, '<', $file) {
        binmode($fh, ':utf8');
        local $/;
        $content = <$fh> // '';
        close $fh;
    }
    if ($content ne $last) {
        $last = $content;
        redraw($content);
    }
    select(undef, undef, undef, 0.08);
}
`;
}

export function buildDisplayScript(): string {
	return `#!/usr/bin/perl
use strict;
use warnings;

$| = 1;
binmode(STDOUT, ':utf8');

my $file = $ARGV[0] or die "Usage: $0 <messages-file>\\n";
my $pos = 0;
my $typewriter = 0;
my $in_esc = 0;
my $esc_buf = '';
my $pending_clear = 0;

# iTerm2: bump font size ~1.2x (3 increments)
print "\\x1bPtmux;\\x1b\\x1b]1337;ChangeFontSize=3\\a\\x1b\\\\";
print "\\x1b]1337;ChangeFontSize=3\\a";

# Clear screen
print "\\x1b[2J\\x1b[H";

# Get terminal height for scroll animation
my $term_rows = \`tput lines 2>/dev/null\` || 24;
chomp $term_rows;
$term_rows = int($term_rows) || 24;

while (! -f $file) {
    select(undef, undef, undef, 0.1);
}

while (1) {
    if (open my $fh, '<', $file) {
        binmode($fh, ':utf8');
        seek $fh, $pos, 0;

        while (read $fh, my $char, 1) {
            if ($char eq "\\x01") { $typewriter = 1; next; }
            if ($char eq "\\x02") { $typewriter = 0; next; }

            # Intercept ANSI escapes to detect clear-screen
            if ($in_esc) {
                $esc_buf .= $char;
                if ($char =~ /[A-Za-z]/) {
                    $in_esc = 0;
                    if ($esc_buf eq '[2J') {
                        # Slide animation: scroll content up rapidly
                        print "\\x1b[999;1H\\n" for (1..int($term_rows * 0.6));
                        for my $i (1..6) {
                            print "\\n" for (1..3);
                            select(undef, undef, undef, 0.018);
                        }
                        $pending_clear = 1;
                        $esc_buf = '';
                        next;
                    }
                    if ($esc_buf eq '[H' && $pending_clear) {
                        # After slide, clear and home
                        print "\\x1b[2J\\x1b[H";
                        $pending_clear = 0;
                        $esc_buf = '';
                        next;
                    }
                    # Normal escape — emit it
                    print "\\x1b" . $esc_buf;
                    $esc_buf = '';
                }
                next;
            }
            if ($char eq "\\x1b") {
                $in_esc = 1;
                $esc_buf = '';
                next;
            }

            print $char;

            next unless $typewriter;

            if ($char =~ /[.!?]/) {
                select(undef, undef, undef, 0.065);
            } elsif ($char =~ /[,;:]/) {
                select(undef, undef, undef, 0.030);
            } elsif ($char eq "\\n") {
                select(undef, undef, undef, 0.020);
            } elsif ($char eq ' ') {
                select(undef, undef, undef, 0.010);
            } elsif (ord($char) > 31) {
                select(undef, undef, undef, 0.006);
            }
        }

        $pos = tell $fh;
        close $fh;
    }

    select(undef, undef, undef, 0.15);
}
`;
}
