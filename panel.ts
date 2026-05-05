/**
 * Friday Extension - Panel Management Module
 * Tmux panel operations, message writing, and display script
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { writeFileSync, mkdirSync, appendFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { FridaySettings } from "./settings.js";

export type MessageStackMode = "normal" | "standalone";

export async function openPanel(
	pi: ExtensionAPI,
	settings: FridaySettings,
	commsDir: string,
	messagesFile: string,
	ownerPaneId: string | null,
	logError: (context: string, err: unknown) => void,
): Promise<{ success: boolean; paneId: string | null; paneWidth: number }> {
	try {
		if (!process.env.TMUX) return { success: false, paneId: null, paneWidth: 38 };

		mkdirSync(commsDir, { recursive: true });
		writeFileSync(messagesFile, "");

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
			return { success: false, paneId: null, paneWidth: 38 };
		}

		try {
			await pi.exec("tmux", [
				"set-option", "-p", "-t", paneId, "allow-passthrough", "on",
			]);
		} catch { /* non-critical */ }

		let paneWidth: number;
		try {
			const w = await pi.exec("tmux", [
				"display-message", "-t", paneId, "-p", "#{pane_width}",
			]);
			paneWidth = (parseInt(w.stdout.trim()) || 44) - 6;
		} catch {
			paneWidth = 38;
		}

		return { success: true, paneId, paneWidth };
	} catch (e) {
		logError("openPanel", e);
		return { success: false, paneId: null, paneWidth: 38 };
	}
}

export async function killPane(pi: ExtensionAPI, paneId: string | null) {
	if (paneId) {
		try { await pi.exec("tmux", ["kill-pane", "-t", paneId]); } catch {}
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
	settings: FridaySettings,
	commsDir: string,
	messagesFile: string,
	ownerPaneId: string | null,
	paneId: string | null,
	sleep: (ms: number) => Promise<void>,
	logError: (context: string, err: unknown) => void,
): Promise<{ success: boolean; paneId: string | null; paneWidth: number }> {
	try {
		if (paneId && (await isPaneAlive(pi, paneId))) {
			// Get current pane width
			let paneWidth: number;
			try {
				const w = await pi.exec("tmux", [
					"display-message", "-t", paneId, "-p", "#{pane_width}",
				]);
				paneWidth = (parseInt(w.stdout.trim()) || 44) - 6;
			} catch {
				paneWidth = 38;
			}
			return { success: true, paneId, paneWidth };
		}
		const result = await openPanel(pi, settings, commsDir, messagesFile, ownerPaneId, logError);
		if (result.success) await sleep(500);
		return result;
	} catch (e) {
		logError("ensurePanelOpen", e);
		return { success: false, paneId: null, paneWidth: 38 };
	}
}

export function cleanupFiles(commsDir: string) {
	try { if (existsSync(commsDir)) rmSync(commsDir, { recursive: true }); } catch {}
}

export function writeMessage(
	text: string,
	messagesFile: string,
	paneWidth: number,
	settings: FridaySettings,
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

		const wrapped = wordWrap(text, paneWidth);
		out += TW_START;
		for (const line of wrapped) out += `${white}  ${line}${reset}\n`;
		out += TW_STOP;
		out += "\n";

		appendFileSync(messagesFile, out);
	} catch (e) { logError("writeMessage", e); }
}

/** Write a passthrough message (agent text not sent via communicate).
 *  Always appends — never clears the panel. No voice. Dimmer styling. */
export function writeMessagePassthrough(
	text: string,
	messagesFile: string,
	paneWidth: number,
	logError: (context: string, err: unknown) => void,
) {
	try {
		const reset = "\x1b[0m";
		const lightGray = "\x1b[38;5;249m"; // 256-color light gray, readable but distinct

		const wrapped = wordWrap(text, paneWidth);
		let out = "\n";
		for (const line of wrapped) out += `${lightGray}  ${line}${reset}\n`;
		out += "\n";

		appendFileSync(messagesFile, out);
	} catch (e) { logError("writeMessagePassthrough", e); }
}

export function wordWrap(text: string, width: number): string[] {
	const lines: string[] = [];
	const paragraphs = text.split("\n");

	for (const para of paragraphs) {
		if (para.trim() === "") { lines.push(""); continue; }

		const words = para.split(/\s+/);
		let currentLine = "";

		for (const word of words) {
			if (currentLine.length + word.length + 1 > width && currentLine.length > 0) {
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