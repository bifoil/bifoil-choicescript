package core

import (
	"context"
	"errors"
	"strings"
	"testing"
)

func parseExample(text string) (*Document, *registry, *valuePool) {
	var names registry
	var values valuePool
	doc := parseSource(Source{URI: "file:///original/scenes/startup.txt", Text: text}, 1, &names, &values)
	return doc, &names, &values
}
func hasDiagnostic(doc *Document, code string) bool {
	for _, diagnostic := range doc.Diagnostics {
		if diagnostic.Code == code {
			return true
		}
	}
	return false
}

func TestNativeParserRecoveryAndIndependentCommandStrings(t *testing.T) {
	text := "*create gender \"male\"\n*create implicit_control_flow true\nShe said \"This is the end,\n*if gender = \"male\"\n    William.\"\n*else\n    Belle.\"\nShe walked away."
	doc, _, _ := parseExample(text)
	if len(doc.Diagnostics) != 0 {
		t.Fatal(doc.Diagnostics)
	}
	if doc.rowAt(3).Kind != prose || doc.rowAt(4).Kind != command || doc.rowAt(5).Parent != 4 || doc.rowAt(7).Parent != 6 {
		t.Fatal("conditional indentation changed")
	}
	broken, _, _ := parseExample("She said \"Hello,\n*set gender \"unfinished\n*else\n    Belle.\"\n*print 42")
	if !hasDiagnostic(broken, "expression-string") || broken.rowAt(3).Kind != command || broken.rowAt(5).Kind != command {
		t.Fatal("a command string consumed later source")
	}
}

func TestNativeParserUTF16BOMAndEscapedInterpolation(t *testing.T) {
	doc, names, _ := parseExample("\uFEFF*create score 1\r\n*print \"😀 ${score}\"\r\n*print \"escaped \\\" ${score} \\\"\"")
	if len(doc.Diagnostics) != 0 {
		t.Fatal(doc.Diagnostics)
	}
	if doc.Syntax[1].Start != 1 {
		t.Fatal("BOM changed physical command columns")
	}
	found := false
	for id, span := range doc.Syntax {
		if span.Line == 1 && span.Type == Variable && names.Names[doc.TokenName[uint32(id)]] == "score" {
			found = true
			if span.Start != 13 || span.Length != 5 {
				t.Fatalf("wrong UTF16 interpolation range: %+v", span)
			}
		}
	}
	if !found {
		t.Fatal("nested string interpolation was not tokenized")
	}
}

func TestNativeParserCommentBodiesBlankMetadataAndCase(t *testing.T) {
	doc, names, _ := parseExample("*if true\n  *comment empty body\n*else\n  *comment another body\n*scene_list\n  Act\n\n  act\n*goto_scene Act HeLLo")
	if len(doc.Diagnostics) != 0 {
		t.Fatal(doc.Diagnostics)
	}
	if doc.rowAt(7).Kind != blank {
		t.Fatal("a blank row became scene metadata")
	}
	if names.Names[doc.rowAt(9).Target] != "Act" {
		t.Fatal("scene name lost filename case")
	}
	invalid, _, _ := parseExample("*fake_choice\n  *comment no options")
	if !hasDiagnostic(invalid, "missing-block") {
		t.Fatal("comments supplied a nonexistent choice option")
	}
}

func TestNativeParserArraysIndirectValuesAndGroupedExpressions(t *testing.T) {
	for _, text := range []string{
		"*create_array values 2 1 \"second\"\n*set values[1] true\n*print values[2]",
		"*temp target \"score\"\n*set {target} +1\n*setref target +2",
		"*temp score (2 + 3)\n*print ((score + 1) * 2)",
		"*temp score 5\nYour result: @{(score > 1) A|B}",
	} {
		doc, _, _ := parseExample(text)
		if len(doc.Diagnostics) != 0 {
			t.Fatalf("valid expression rejected: %v", doc.Diagnostics)
		}
	}
	invalid, _, _ := parseExample("*set score = 1\n*set score +\n*print 1 + 2 + 3")
	if !hasDiagnostic(invalid, "expression-syntax") || !hasDiagnostic(invalid, "missing-value") {
		t.Fatal("malformed expressions lost local errors")
	}
}

func TestNativeParserCompiledJumpArgumentsKeepLiteralAndComputedReferences(t *testing.T) {
	doc, names, values := parseExample("*gosub_scene Act HeLLo value[1]\n*gotoref (target & \"_suffix\")")
	if len(doc.Diagnostics) != 0 {
		t.Fatal(doc.Diagnostics)
	}
	node := doc.rowAt(1)
	if node.ExprCount != 3 {
		t.Fatal("jump arguments were not retained")
	}
	refs := doc.Args[node.ExprStart : node.ExprStart+node.ExprCount]
	constant, known := values.constant(evaluate(doc, refs[0], names, values, func(uint32) Value { return UnknownType }))
	if !known || constant.Text != "Act" {
		t.Fatal("literal scene reference was evaluated as a variable")
	}
	if doc.Exprs[doc.rowAt(2).Expr].Kind != exBinary {
		t.Fatal("gotoref discarded its expression tail")
	}
}

func TestNativeParserEmptySourceAndLongUnicodeLines(t *testing.T) {
	for _, source := range []string{"", "\n", "\uFEFF\r\n", "\u00a0\n"} {
		doc, _, _ := parseExample(source)
		if len(doc.Diagnostics) != 0 {
			t.Fatal(doc.Diagnostics)
		}
	}
	text := "*temp value 1\n" + strings.Repeat("😀 ${value} [b]word[/b] ", 10000)
	doc, names, _ := parseExample(text)
	if len(doc.Diagnostics) != 0 {
		t.Fatal(doc.Diagnostics)
	}
	count := 0
	for id, span := range doc.Syntax {
		if span.Line == 1 && span.Type == Variable && names.Names[doc.TokenName[uint32(id)]] == "value" {
			if span.Length != 5 {
				t.Fatal("Unicode changed identifier width")
			}
			count++
		}
	}
	if count != 10000 {
		t.Fatalf("lost substitutions: %d", count)
	}
}

func TestParserCancellationNeverReturnsPartialSource(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	parsed, err := ParseSourceContext(ctx, Source{URI: "file:///original/startup.txt", Text: "*create value 1\nOriginal prose."})
	if !errors.Is(err, context.Canceled) || parsed != nil {
		t.Fatal("cancelled parse returned a source", parsed, err)
	}
}

func TestNativeCommandRecoveryDiagnosticsStayOnTheirPhysicalLine(t *testing.T) {
	for _, example := range []struct{ source, code string }{
		{"*invented_command 1", "unknown-command"}, {"*", "command-syntax"}, {"*create", "missing-variable"}, {"*create choice_bad 1", "variable-name"},
		{"*create value (1 + 2)", "create-literal"}, {`*create value "${other}"`, "create-literal"}, {"*setref", "missing-variable"},
		{"*set round(1) 2", "expression-reference"}, {"*if", "missing-expression"}, {"*else unexpected", "unexpected-argument"},
		{"Original ${unfinished", "interpolation-close"}, {"Original @{value}", "multireplace-options"}, {"Original @{value one}", "multireplace-options"},
	} {
		t.Run(example.code+example.source, func(t *testing.T) {
			source := example.source + "\r\n*print 42"
			doc, names, _ := parseExample(source)
			if !hasDiagnostic(doc, example.code) {
				t.Fatalf("missing %s: %v", example.code, doc.Diagnostics)
			}
			if names.Names[doc.rowAt(2).Command] != "print" {
				t.Fatal("malformed first line swallowed the next command")
			}
			for _, diagnostic := range doc.Diagnostics {
				if diagnostic.Code == example.code && diagnostic.Range.Start.Line != 0 {
					t.Fatal("local diagnostic escaped its physical line")
				}
			}
		})
	}
	for _, source := range []string{
		"*hide_reuse # Original ${name}", "*disable_reuse # Original option", "*allow_reuse # Another option",
		"*fake_choice\n  *selectable_if (true) # Original option\n    *ending\n  # Other\n    *ending",
		"*scene_list\n  $chapter PaidChapter\n  startup\n*finish",
		"*goto_random_scene allow_no_selection\n  *if ((flag = true)) helper\n  *allow_reuse helper",
		"*achievement original visible 10 Original title\n  Original pre-earned description\n  Original earned description",
		"*stat_chart\n  opposed_pair score\n    Original low\n    Original high\n*ending",
		"*temp_array items 2 1 true\n*delete_array items\n*ending",
		"*setref (\"sco\" & \"re\") %+10\n*set score % 3\n*ending",
		"*if (name = \"a \\\" # b\") # Original text\n  *ending",
	} {
		doc, _, _ := parseExample(source)
		if len(doc.Syntax) == 0 {
			t.Fatal("command-specific metadata lost highlighting", source)
		}
		for _, token := range doc.Syntax[1:] {
			if token.Length == 0 {
				t.Fatalf("command-specific token has an empty range: %+v in %q", token, source)
			}
		}
	}
}
