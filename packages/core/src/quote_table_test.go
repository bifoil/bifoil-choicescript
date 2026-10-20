package core

import (
	"context"
	"reflect"
	"testing"
)

func TestVectorQuoteTablesMatchFullNarrativeTransfers(t *testing.T) {
	for _, text := range []string{
		"Hello ${name}.", "She said \"Hello ${name}.\"", "  “${name} continued.”", "[b]“${name} continued.”[/b]",
		"@{flag ${name} said \"Hello.\"|${name} said “Hi.”}", "@{flag \"${name} stayed.|${name} left.} After.",
		"@{flag @{flag “${name} speaks.”|\"${name} speaks.\"}|[b]“${name} stays.”[/b]}",
		"“@{flag ${name} stays.|${name} goes.}”", "${name} @{flag “Hello.”|\"Hi.\"}",
		"@{flag ${name}|${name}} \"After.\"", "Name ${round(42)} @{flag \"One.|Two.\"}",
	} {
		source := "*create name \"Original\"\n*create flag true\n" + text
		var expected *Project
		for _, slow := range []bool{true, false} {
			p := NewProject()
			p.slowQuoteTable = slow
			p.AddSource(Source{URI: "file:///original/startup.txt", Text: source})
			if err := p.Analyze(context.Background()); err != nil {
				t.Fatal(err)
			}
			if expected == nil {
				expected = p
			} else if !reflect.DeepEqual(expected.Tokens, p.Tokens) || !reflect.DeepEqual(expected.Documents[0].Diagnostics, p.Documents[0].Diagnostics) {
				t.Fatalf("changed table for %q\n%v\n%v\n%v\n%v", text, expected.Tokens, p.Tokens, expected.Documents[0].Diagnostics, p.Documents[0].Diagnostics)
			}
		}
	}
}
func TestVectorQuoteTablesKeepAllFourteenInputs(t *testing.T) {
	for _, raw := range []string{"${x}", "“${x}”", "@{yes “${x}”|\"${x}\"}", "[b]“${x}”[/b]"} {
		table, ok := quoteFreeTable(raw)
		if !ok {
			t.Fatal(raw)
		}
		p := NewProject()
		d := p.AddSource(Source{URI: "file:///original/startup.txt", Text: raw})
		p.fixedSubstitutions = []map[uint64]bool{{}}
		for location := range d.Substitutions {
			p.fixedSubstitutions[0][location] = true
		}
		for slot := range uint8(14) {
			state := flowState{quote: slot/2 + 1, paragraph: slot%2 != 0}
			p.textTransfer(d, 1, &state, false, 0, 0, false)
			got := uint8(table >> (slot * 3) & 7)
			if got != state.quote {
				t.Fatalf("%q slot %d: %d != %d", raw, slot, got, state.quote)
			}
		}
	}
}

func TestComposedNarrativeRunRetainsEveryScalarInputState(t *testing.T) {
	for _, text := range []string{
		"*create name \"friend\"\n*create implicit_control_flow true\nShe said \"Hello,\n${name}.\"\n\nOutside narrative.\n*ending",
		"*create name \"friend\"\nShe said “Hello,\n\n“${name}.”\n\nOutside [b]narrative[/b].\n*ending",
		"*create index 1\n@{index \"First|Second}\n\nContinued \"text\".\n*ending",
	} {
		p := analyzeExample(t, text)
		d := p.Documents[0]
		graph := buildGraph(d, &p.names)
		p.graphs = []flowGraph{graph}
		p.prepareRuns()
		for first, run := range p.runs[0] {
			for slot := range uint8(14) {
				quote, paragraph := slot/2+1, slot%2 != 0
				for line := first; ; {
					node := d.rowAt(int(line))
					if node.Kind == blank {
						paragraph = true
					} else if node.Kind != option {
						quote = p.flowText(d, line, quote, paragraph)
						paragraph = false
					}
					if line == run.Last {
						break
					}
					line = graph.targets(line)[0]
				}
				if run.Exit[slot] != quote || (run.Paragraph&(1<<slot) != 0) != paragraph {
					t.Fatalf("run at %d changed input state %d", first, slot)
				}
			}
		}
	}
}
