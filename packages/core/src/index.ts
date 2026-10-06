/**
 * Editor-independent language API. Inputs/outputs use UTF-16 source coordinates;
 * parsed documents are mutable analysis inputs, while projected documents omit prose.
 * See types.ts for ownership and representation contracts before retaining these objects.
 */
export * from "./types.js";
export * from "./parser.js";
export * from "./expression.js";
export * from "./analysis.js";
export * from "./features.js";
export * from "./projection.js";
