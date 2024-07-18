// CurryLog is a way to add tagged logging that is stripped in production

import { Notice } from "obsidian";

declare const BUILD_TYPE: string;

let debugging = false;

export function setDebugging(debug: boolean) {
	debugging = debug;
}

function toastDebug(error: Error): Error {
	new Notice(error.name + "\n" + error.message);
	return error;
}
function toastProd(error: Error): Error {
	new Notice(
		error.name + ":\nAn error has occurred, please reload Obsidian."
	);
	return error;
}

export function curryLog(
	initialText: string,
	fn: (...args: unknown[]) => void
) {
	if (debugging) {
		return (...args: unknown[]) => fn(initialText, ": ", ...args);
	}
	return (...args: unknown[]) => {};
}

const debug = BUILD_TYPE === "debug";
export const toast = debug ? toastDebug : toastProd;
