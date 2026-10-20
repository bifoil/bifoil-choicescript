package core

import "testing"

func TestNativeQuoteValuesPreserveCompleteTransferAcrossJoins(t *testing.T) {
	var pool valuePool
	for _, a := range []string{"", "Hello", "\"", "“", "”", "He said \"Hello.\""} {
		for _, b := range []string{"", "World", "\"", "“", "”"} {
			left, right := pool.text(a), pool.text(b)
			if composeQuoteEffects(pool.quote(left), pool.quote(right)) != literalQuoteEffect(a+b) {
				t.Fatal("concatenated quote effect changed")
			}
			joined := pool.join(left, right)
			for q := uint8(1); q <= 7; q++ {
				want := applyQuoteEffect(pool.quote(left), q) | applyQuoteEffect(pool.quote(right), q)
				if got := applyQuoteEffect(pool.quote(joined), q); got != want {
					t.Fatalf("lost quote transfer for input %d", q)
				}
			}
		}
	}
	joined := pool.join(pool.text("William"), pool.text("Belle"))
	if _, known := pool.constant(joined); known {
		t.Fatal("two different names became one known primitive")
	}
	if pool.quote(joined) != identityQuoteEffect {
		t.Fatal("quote-free alternatives became uncertain dialogue")
	}
}
func TestNativeQuoteValuesKeepDialogueThroughUnknownNumericText(t *testing.T) {
	text := "*create implicit_control_flow true\n*temp name \"William\"\n*if true\n  *set name \"Belle\"\nShe said \"Hello ${name}.\"\n*temp score 1\n*set score +1\n*print (\"Score: \" & score)\nDone."
	p := analyzeExample(t, text)
	for _, d := range p.Documents {
		if hasDiagnostic(d, "quote-unclosed") || hasDiagnostic(d, "quote-branch") {
			t.Fatal(d.Diagnostics)
		}
	}
	for _, token := range p.Tokens[0] {
		if token.Line == 8 && token.Type != Narrative {
			t.Fatal("numeric output introduced dialogue uncertainty")
		}
	}
}
