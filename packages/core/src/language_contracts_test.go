package core

import (
	"fmt"
	"strings"
	"testing"
)

func TestNativeExpressionResultTypesAndRecovery(t *testing.T) {
	for _, example := range []struct {
		expression string
		kind       uint8
	}{
		{"1 + 2", NumberVariable}, {"7 - 2", NumberVariable}, {"3 * 4", NumberVariable}, {"7 / 2", NumberVariable},
		{"2 ^ 3", NumberVariable}, {"7 modulo 3", NumberVariable}, {`"a" & "b"`, StringVariable}, {`"abc" # 1`, StringVariable},
		{"50 %+ 10", NumberVariable}, {"50 %- 10", NumberVariable}, {"1 / 0", NumberVariable}, {"0 / 0", NumberVariable},
		{"1 = 2", BooleanVariable}, {"true and false", BooleanVariable}, {"true or false", BooleanVariable},
		{"1 != 2", BooleanVariable}, {"1 <= 2", BooleanVariable}, {"2 >= 1", BooleanVariable}, {"1 < 2", BooleanVariable}, {"2 > 1", BooleanVariable},
		{"round(2.5)", NumberVariable}, {`length("abc")`, NumberVariable}, {"not(true)", BooleanVariable},
		{"log(10)", NumberVariable}, {"auto(1)", NumberVariable}, {`timestamp("today")`, NumberVariable},
	} {
		t.Run(example.expression, func(t *testing.T) {
			source := "*temp result " + example.expression + "\n*print result\n*ending"
			project := analyzeExample(t, source)
			if got := nativeClassification(t, project, 0, source, "*print result"); got != example.kind {
				t.Fatalf("result type %s, want %s", TokenTypes[got], TokenTypes[example.kind])
			}
		})
	}
	for _, expression := range []string{`"unterminated`, "“smart”", "(1 +)", "((1 + 2)", "1 + 2 + 3", "-1", "items[", "{", "round(", "!", "round(1, 2)", "1abc", "1.5abc", "?", "😀", `"escaped \😀 ${missing}"`} {
		t.Run("recovery "+expression, func(t *testing.T) {
			source := "*create keeper 1\r\n*print " + expression + "\r\n*print keeper\n*ending"
			project := analyzeExample(t, source)
			if got := nativeClassification(t, project, 0, source, "*print keeper"); got != NumberVariable {
				t.Fatal("malformed expression consumed the following command", TokenTypes[got])
			}
			for _, token := range project.Tokens[0] {
				if token.Line == 2 && token.Type == Dialogue {
					t.Fatal("expression opened narrative dialogue")
				}
			}
		})
	}
}

func TestNativeUnresolvedJumpsKeepAllReachableDestinationsNeutral(t *testing.T) {
	for _, command := range []string{"*gotoref destination", "*goto {destination}", "*gosub {destination}", "*goto_scene {destination}", "*gosub_scene {destination}"} {
		t.Run(command, func(t *testing.T) {
			source := "*create score 1\n*temp destination \"\"\n*input_text destination\n" + command + "\n*label finish\n*print score\nOriginal narrative.\n*ending"
			helper := "*print score\nOther original narrative.\n*finish"
			project := analyzeExample(t, source, helper)
			if nativeClassification(t, project, 0, source, "*print score") != Variable {
				t.Fatal("dynamic jump claimed a definite variable type")
			}
			for _, tokens := range project.Tokens {
				for _, token := range tokens {
					if token.Type == Dialogue {
						t.Fatal("unknown jump claimed definite dialogue")
					}
				}
			}
		})
	}
}

func TestNativeNonstandardIndentationRecoversWithoutLosingUnicode(t *testing.T) {
	for _, indentation := range []string{"\u00a0", "\u2003", " \t ", "\v", "\f"} {
		source := fmt.Sprintf("*create keeper 1\n*if true\n%s*print keeper\n*print keeper\n*ending", indentation)
		project := analyzeExample(t, source)
		if nativeClassification(t, project, 0, source, "*print keeper") != NumberVariable {
			t.Fatal("indentation swallowed continuation")
		}
		for _, diagnostic := range project.Documents[0].Diagnostics {
			if int(diagnostic.Range.Start.Line) >= len(strings.Split(source, "\n")) {
				t.Fatal("diagnostic escaped source")
			}
		}
	}
}

func TestIndirectReadPredicateRecognizesNestedRuntimeReferences(t *testing.T) {
	for _, example := range []struct {
		expression string
		indirect   bool
	}{
		{"score", false}, {"score + 1", false}, {"items[index]", false}, {"round(score)", false},
		{"{address}", true}, {"({address} + 1)", true}, {"(1 + {address})", true}, {"items[{address}]", true}, {"round({address})", true},
	} {
		project := analyzeExample(t, "*temp score 1\n*temp address \"score\"\n*print "+example.expression+"\n*ending")
		document := project.Documents[0]
		if got := project.rowHasIndirectRead(document, document.rowAt(3)); got != example.indirect {
			t.Fatal("nested indirect read classification changed", example, got)
		}
	}
}

func TestIndirectReadPredicateRecognizesCallArguments(t *testing.T) {
	project := analyzeExample(t, "*temp score 1\n*temp address \"score\"\n*gosub helper {address}\n*ending\n*label helper\n*return")
	document := project.Documents[0]
	if !project.rowHasIndirectRead(document, document.rowAt(3)) {
		t.Fatal("indirect call argument was ignored")
	}
}
