import { Worklist } from "./worklist.js";
import type { Span } from "./types.js";

/**
 * Partition one physical line into ordered, disjoint semantic spans.
 * Earlier overlays win overlaps; every overlay takes precedence over base narrative.
 * Inputs must use the same line's UTF-16 coordinate system. Returned spans are copies;
 * adjacent equal-looking spans are not necessarily coalesced.
 */
export function overlaySegments(base: Span[], overlays: Span[]): Span[] {
  // Narrative segments are already ordered and disjoint; clone them without a sweep.
  if (
    !overlays.length &&
    base.every((span, i) => span.length > 0 && (!i || base[i - 1].start + base[i - 1].length <= span.start))
  )
    return base.map((span) => ({ ...span }));

  const spans = [...overlays, ...base];

  if (spans.length === 1) return spans[0].length > 0 ? [{ ...spans[0] }] : [];

  const boundaries = [...new Set(spans.flatMap((span) => [span.start, span.start + span.length]))].sort(
    (a, b) => a - b,
  );
  const starts = spans.map((span, priority) => ({ span, priority })).sort((a, b) => a.span.start - b.span.start);
  const active = new Worklist<Span>(),
    result: Span[] = [];
  let next = 0;

  for (let i = 0; i < boundaries.length - 1; i++) {
    const start = boundaries[i],
      end = boundaries[i + 1];

    while (next < starts.length && starts[next].span.start <= start) {
      const entry = starts[next++];
      active.push(entry.span, entry.priority);
    }

    while (active.peek() && active.peek()!.start + active.peek()!.length <= start) active.pop();

    const span = active.peek();

    if (span && end > start) result.push({ ...span, start, length: end - start });
  }

  return result;
}
