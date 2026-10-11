import type { LibraryLicense } from "../src/shared/model.ts";

export function collectLicenses(files: string[]): LibraryLicense[];
export function addLicenses(file: string, entries: LibraryLicense[]): void;
export function metafileInputs(metafile: { inputs: Record<string, unknown> }, cwd: string): string[];
