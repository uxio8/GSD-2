/**
 * Terminal capability helpers for shortcut descriptions.
 *
 * Some terminals swallow Ctrl+Alt combos unless they implement the Kitty
 * keyboard protocol or modifyOtherKeys. Surface the slash-command fallback
 * when we can detect those environments.
 */

const UNSUPPORTED_TERM_PROGRAMS = ["apple_terminal"];

export function supportsCtrlAltShortcuts(): boolean {
	const termProgram = (process.env.TERM_PROGRAM || "").toLowerCase();
	const terminalEmulator = (process.env.TERMINAL_EMULATOR || "").toLowerCase();
	const isJetBrains = terminalEmulator.includes("jetbrains");
	return !UNSUPPORTED_TERM_PROGRAMS.some((term) => termProgram.includes(term)) && !isJetBrains;
}

export function shortcutDesc(base: string, fallbackCmd: string): string {
	if (supportsCtrlAltShortcuts()) return base;
	return `${base} — shortcut may not work in this terminal, use ${fallbackCmd}`;
}
