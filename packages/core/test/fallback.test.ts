import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import textmate from 'vscode-textmate';
import oniguruma from 'vscode-oniguruma';
test('TextMate fallback strings end on the same line and never capture prose or commands', async () => {
  const require = createRequire(import.meta.url);
  const wasm = await readFile(require.resolve('vscode-oniguruma/release/onig.wasm'));
  await oniguruma.loadWASM(wasm);
  const raw = await readFile(
    new URL('../../../editors/vscode/syntaxes/choicescript.tmLanguage.json', import.meta.url),
    'utf8',
  );
  const registry = new textmate.Registry({
    onigLib: Promise.resolve({
      createOnigScanner: (p) => new oniguruma.OnigScanner(p),
      createOnigString: (s) => new oniguruma.OnigString(s),
    }),
    loadGrammar: async () => textmate.parseRawGrammar(raw, 'grammar.json'),
  });
  const grammar = await registry.loadGrammar('source.choicescript');
  assert(grammar);
  let state = textmate.INITIAL;
  for (const [line, text] of [
    'She said "Hello',
    '*set name "broken',
    'World."',
    '*print 42',
  ].entries()) {
    const result = grammar.tokenizeLine(text, state);
    state = result.ruleStack;
    if (line === 0 || line === 2)
      assert(!result.tokens.some((t) => t.scopes.some((s) => s.startsWith('string.'))));
    if (line === 3)
      assert(result.tokens.some((t) => t.scopes.includes('keyword.control.choicescript')));
  }
  registry.dispose();
});
