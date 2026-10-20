/** Remove complete bracketed markup in one pass; leave an unmatched opening bracket as prose. */
export function stripMarkup(text: string): string {
  let start = 0;
  let open = text.indexOf("[");
  const parts: string[] = [];

  while (open >= 0) {
    const close = text.indexOf("]", open + 1);
    if (close < 0) break;

    parts.push(text.slice(start, open));
    start = close + 1;
    open = text.indexOf("[", start);
  }

  parts.push(text.slice(start));
  return parts.join("");
}

/** Count Unicode words without retaining a match array proportional to the size of the prose. */
export function narrativeWords(text: string): number {
  const plain = stripMarkup(text);
  const pattern = /[\p{L}\p{N}]+(?:['’]\p{L}+)*/gu;
  let count = 0;

  while (pattern.exec(plain) !== null) count++;
  return count;
}
