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
	panelWidth: number;
}

export const DEFAULT_SETTINGS: SidechatSettings = {
	name: "Sidechat",
	typewriter: {
		enabled: true,
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