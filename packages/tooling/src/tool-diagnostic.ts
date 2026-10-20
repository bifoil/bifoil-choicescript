/** Parse the official tools' physical-line failure format without retrying a pattern over the source text. */
export function toolDiagnostic(
  text: string,
): { scene: string; line: number; message: string; prefixed: boolean; warning: boolean } | undefined {
  const prefix = /^(?:RANDOMTEST FAILED: (?:Error: )?|WARNING |Error: )/i.exec(text)?.[0] ?? "";
  const start = prefix.length;
  let at = text.indexOf(" line ", start + 1);

  while (at >= 0) {
    const numberStart = at + 6;
    let end = numberStart;
    while (end < text.length && text.charCodeAt(end) >= 48 && text.charCodeAt(end) <= 57) end++;

    if (end > numberStart && text[end] === ":") {
      const line = Number(text.slice(numberStart, end));
      if (!Number.isSafeInteger(line) || line < 1) return undefined;

      const message = text.slice(end + 1).trimStart();
      return {
        scene: text.slice(start, at),
        line: line - 1,
        message,
        prefixed: prefix.length > 0,
        warning: /^WARNING\b/i.test(prefix) || /^WARNING\b/i.test(message),
      };
    }

    at = text.indexOf(" line ", end);
  }

  return undefined;
}
