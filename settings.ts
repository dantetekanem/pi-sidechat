/**
 * Sidechat Extension - Settings Management
 * Pure settings interface, defaults, and load/save functions
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface SidechatSettings {
	name: string;
	typewriter: {
		enabled: boolean;
	};
	acks: {
		enabled: boolean;
		delayMs: number;
	};
	panelWidth: number;
}

export const DEFAULT_SETTINGS: SidechatSettings = {
	name: "Sidechat",
	typewriter: {
		enabled: true,
	},
	acks: {
		enabled: false,
		delayMs: 2000,
	},
	panelWidth: 25,
};

export function getSettingsPath(): string {
	return join(
		import.meta.dirname,
		"settings.json",
	);
}

export function loadSettings(): SidechatSettings {
	const path = getSettingsPath();
	try {
		if (existsSync(path)) {
			const raw = JSON.parse(readFileSync(path, "utf8"));
			return {
				...DEFAULT_SETTINGS,
				name: typeof raw.name === "string" ? raw.name : DEFAULT_SETTINGS.name,
				panelWidth: typeof raw.panelWidth === "number" ? raw.panelWidth : DEFAULT_SETTINGS.panelWidth,
				typewriter: { ...DEFAULT_SETTINGS.typewriter, ...(raw.typewriter ?? {}) },
				acks: {
					...DEFAULT_SETTINGS.acks,
					...(raw.acks ?? {}),
					enabled: typeof raw.acks?.enabled === "boolean" ? raw.acks.enabled : DEFAULT_SETTINGS.acks.enabled,
					delayMs: typeof raw.acks?.delayMs === "number" ? raw.acks.delayMs : DEFAULT_SETTINGS.acks.delayMs,
				},
			};
		}
	} catch { /* use defaults */ }
	return { ...DEFAULT_SETTINGS };
}

export function saveSettings(s: SidechatSettings): void {
	try { 
		writeFileSync(getSettingsPath(), JSON.stringify(s, null, 2) + "\n"); 
	} catch {}
}