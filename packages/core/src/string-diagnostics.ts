import type { Diagnostic } from "./types.js";

/** Offsets include the original end column; recovery positions beyond decoded text use that boundary. */
export function mapStringDiagnostic(value: Diagnostic, offsets: readonly number[]): void {
  value.range.start.character = offsets[value.range.start.character] ?? offsets.at(-1)!;
  value.range.end.character = offsets[value.range.end.character] ?? offsets.at(-1)!;
}
