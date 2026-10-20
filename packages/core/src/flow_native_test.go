package core

import (
	"context"
	"strings"
	"testing"
)

func analyzeExample(t *testing.T, texts ...string) *Project {
	t.Helper()
	p := NewProject()
	for i, text := range texts {
		name := "startup"
		if i > 0 {
			name = "helper"
		}
		p.AddSource(Source{URI: "file:///original/scenes/" + name + ".txt", Text: text})
	}
	if err := p.Analyze(context.Background()); err != nil {
		t.Fatal(err)
	}
	return p
}
func nativeClassification(t *testing.T, p *Project, doc uint32, text, needle string) uint8 {
	t.Helper()
	line := uint32(0)
	found := false
	column := uint32(0)
	for i, raw := range strings.Split(text, "\n") {
		if raw == needle {
			line = uint32(i)
			column = uint32(strings.IndexByte(raw, ' ') + 1)
			found = true
			break
		}
	}
	if !found {
		t.Fatal("missing test source")
	}
	for _, span := range p.Tokens[doc] {
		if span.Line == line && span.Start <= column && span.Start+span.Length > column {
			return span.Type
		}
	}
	t.Fatal("missing semantic classification")
	return 255
}
func TestNativeFlowIndependentDialogueBranches(t *testing.T) {
	text := "*create gender \"male\"\n*create implicit_control_flow true\nShe said \"This is the end,\n*if gender = \"male\"\n    William.\"\n*else\n    Belle.\"\nShe walked away."
	p := analyzeExample(t, text)
	if len(p.Documents[0].Diagnostics) != 0 {
		t.Fatal(p.Documents[0].Diagnostics)
	}
	for _, line := range []uint32{4, 6} {
		found := false
		for _, span := range p.Tokens[0] {
			if span.Line == line && span.Type == Dialogue {
				found = true
			}
		}
		if !found {
			t.Fatal("branch lost inherited dialogue", line)
		}
	}
	for _, span := range p.Tokens[0] {
		if span.Line == 7 && span.Type != Narrative {
			t.Fatal("dialogue continued after unanimous close")
		}
		if span.Line == 3 && span.Type == Dialogue {
			t.Fatal("expression quote became dialogue")
		}
	}
}
func TestNativeFlowMalformedCommandStringKeepsDialogue(t *testing.T) {
	p := analyzeExample(t, "She said \"Hello,\n*set name \"broken\nWorld.\"\nDone.")
	if !hasDiagnostic(p.Documents[0], "expression-string") || hasDiagnostic(p.Documents[0], "quote-unclosed") {
		t.Fatal(p.Documents[0].Diagnostics)
	}
	for _, span := range p.Tokens[0] {
		if span.Line == 2 && span.Type != Dialogue {
			t.Fatal("local expression error reset dialogue")
		}
	}
}
func TestNativeFlowTypeChangesAndCallEffects(t *testing.T) {
	text := "*create outside 1\n*create count 0\n*gosub increment\n*set outside true\n*gosub increment\n*print outside\n*print count\n*ending\n*label increment\n*set count +1\n*return"
	p := analyzeExample(t, text)
	if got := nativeClassification(t, p, 0, text, "*print outside"); got != BooleanVariable {
		t.Fatalf("unrelated caller changed: %s", TokenTypes[got])
	}
	if got := nativeClassification(t, p, 0, text, "*print count"); got != NumberVariable {
		t.Fatalf("callee write lost: %s", TokenTypes[got])
	}
}
func TestNativeFlowLocalsAndArrayParameters(t *testing.T) {
	text := "*create value true\n*temp value 1\n*gosub remove\n*print value\n*temp value 2\n*gosub_scene helper change\n*print value + 0\n*ending\n*label remove\n*delete value\n*return"
	p := analyzeExample(t, text, "*label change\n*temp value \"other scene\"\n*return")
	if nativeClassification(t, p, 0, text, "*print value") != BooleanVariable || nativeClassification(t, p, 0, text, "*print value + 0") != NumberVariable {
		t.Fatal("local deletion or scene frame restoration failed")
	}
	text = "*create_array items 2 1 \"second\"\n*create outside false\n*gosub replace 1\n*print items[1]\n*print items[2]\n*print outside\n*ending\n*label replace\n*params index\n*set items[index] true\n*return"
	p = analyzeExample(t, text)
	for needle, want := range map[string]uint8{"*print items[1]": BooleanVariable, "*print items[2]": StringVariable, "*print outside": BooleanVariable} {
		if got := nativeClassification(t, p, 0, text, needle); got != want {
			t.Fatalf("%s: %s", needle, TokenTypes[got])
		}
	}
}
func TestNativeFlowRecursionConvergesAndDialogueAcrossScenes(t *testing.T) {
	text := "*create implicit_control_flow true\n*create flag false\n*create count 0\n*create outside 1\n*gosub first\n*set outside true\n*gosub first\n*print outside\n*ending\n*label first\n*if flag\n  *gosub second\n*return\n*label second\n*set count +1\n*gosub first\n*return"
	p := analyzeExample(t, text)
	if nativeClassification(t, p, 0, text, "*print outside") != BooleanVariable {
		t.Fatal("recursive effects changed unrelated caller")
	}
	p = analyzeExample(t, "She said \"Hello,\n*gosub_scene helper speak\nFinished.", "*label speak\nWorld.\"\n*return")
	for _, d := range p.Documents {
		if hasDiagnostic(d, "quote-unclosed") {
			t.Fatal(d.Diagnostics)
		}
	}
	for _, span := range p.Tokens[1] {
		if span.Line == 1 && span.Type != Dialogue {
			t.Fatal("scene call reset dialogue")
		}
	}
}
func TestNativeFlowSubstitutionsAndBranchUncertainty(t *testing.T) {
	p := analyzeExample(t, "*temp ending \"\\\"\"\nShe said \"Hello ${ending}\nDone.")
	for _, span := range p.Tokens[0] {
		if span.Line == 2 && span.Type != Narrative {
			t.Fatal("known rendered quote did not close dialogue")
		}
	}
	p = analyzeExample(t, "*create implicit_control_flow true\n*if true\n  She said \"Hello.\nAfter.")
	if !hasDiagnostic(p.Documents[0], "quote-branch") {
		t.Fatal("conflicting reachable paths were hidden")
	}
	for _, span := range p.Tokens[0] {
		if span.Line == 3 && span.Type == Dialogue {
			t.Fatal("uncertain dialogue styled as certain")
		}
	}
}

func TestNativeFlowSceneListPreservesGlobalsAndDialogue(t *testing.T) {
	p := analyzeExample(t, "*create score 1\n*scene_list\n  startup\n  helper\nShe said \"Hello,\n*finish", "World.\"\n*print score\n*ending")
	if len(p.ordered) != 2 {
		t.Fatal("scene list discarded executable story order")
	}
	found := false
	for _, token := range p.Tokens[1] {
		if token.Line == 1 && token.Type == NumberVariable {
			found = true
		}
		if token.Line == 0 && token.Type != Dialogue {
			t.Fatal("scene transition reset dialogue")
		}
	}
	if !found {
		t.Fatal("scene transition discarded global type")
	}
}

func TestNativeFlowCallsiteTypesDoNotContaminateEachOther(t *testing.T) {
	text := "*create output 0\n*gosub echo 1\n*print output\n*gosub echo \"second\"\n*print output & \"\"\n*ending\n*label echo\n*params value\n*set output value\n*return"
	p := analyzeExample(t, text)
	if nativeClassification(t, p, 0, text, "*print output") != NumberVariable {
		t.Fatal("a later string call rewrote an earlier numeric result")
	}
	if nativeClassification(t, p, 0, text, "*print output & \"\"") != StringVariable {
		t.Fatal("the numeric caller polluted a string result")
	}
}

func TestNativeFlowDisconnectedRootsDoNotRewriteRealCallers(t *testing.T) {
	text := "*create source 1\n*create output 0\n*temp name \"\"\n*input_text name\n${name}\n*gosub common\n*print output\n*ending\n*label common\n*set output source\n*return"
	p := analyzeExample(t, text, "*gosub_scene startup common\n*ending")
	if nativeClassification(t, p, 0, text, "*print output") != NumberVariable {
		t.Fatal("a disconnected scene polluted the resolved story's caller")
	}
}

func TestNativeFlowLocalJumpsPreservePendingArguments(t *testing.T) {
	text := "*create output 0\n*gosub first 7\n*print output\n*ending\n*label first\n*goto bind\n*label bind\n*params incoming\n*set output incoming\n*return"
	p := analyzeExample(t, text)
	if nativeClassification(t, p, 0, text, "*print output") != NumberVariable {
		t.Fatal("a local jump clobbered pending subroutine arguments")
	}
}
func TestNativeFlowSceneReturnRestoresPendingCallerArguments(t *testing.T) {
	text := "*create output 0\n*gosub outer 5\n*print output\n*ending\n*label outer\n*gosub_scene helper\n*params incoming\n*set output incoming\n*return"
	p := analyzeExample(t, text, "*params\n*return")
	if nativeClassification(t, p, 0, text, "*print output") != NumberVariable {
		t.Fatal("a scene call clobbered its caller's parameter registers")
	}
}

func TestNativeRenameIncludesRepeatedSceneLocalDeclarations(t *testing.T) {
	p := analyzeExample(t, "*temp state 1\n*print state\n*temp state true\n*print state\nThe state of the world.")
	edit, err := p.Rename(0, Position{1, 8}, "status")
	if err != nil || edit == nil {
		t.Fatal("resolved local rename failed", err)
	}
	if len(edit.Changes[p.Documents[0].URI]) != 4 {
		t.Fatal("rename omitted a declaration or rewrote prose")
	}
}

func TestNativeFlowStringIndexedFieldsSurviveCallProjection(t *testing.T) {
	text := "*create words_key \"chosen\"\n*create selector \"key\"\n*create output 0\n*gosub read\n*print output\n*ending\n*label read\n*set output words[selector]\n*return"
	p := analyzeExample(t, text)
	if nativeClassification(t, p, 0, text, "*print output") != StringVariable {
		t.Fatal("an indirect string-indexed field was lost from the callee input")
	}
	text = "*create words_key false\n*create selector \"key\"\n*gosub write\n*print words_key\n*ending\n*label write\n*set words[selector] \"changed\"\n*return"
	p = analyzeExample(t, text)
	if nativeClassification(t, p, 0, text, "*print words_key") != StringVariable {
		t.Fatal("a string-indexed write was lost on return")
	}
}

func TestNativeIndirectNumericAndBooleanValuesMatchRuntimeGetVar(t *testing.T) {
	text := "*temp number {42}\n*temp boolean {true}\n*print number\n*print boolean\n*ending"
	p := analyzeExample(t, text)
	if nativeClassification(t, p, 0, text, "*print number") != NumberVariable || nativeClassification(t, p, 0, text, "*print boolean") != BooleanVariable {
		t.Fatal("indirect primitive constants did not follow getVar")
	}
	if builtinQuoteFree("choice_is_invented") {
		t.Fatal("unknown builtin getter was incorrectly proven quote-free")
	}
}
func TestNativeDynamicSceneReferenceRetainsResolvedLabelDefinition(t *testing.T) {
	p := analyzeExample(t, "*temp destination \"helper\"\n*gosub_scene {destination} speak\n*ending", "*label speak\n*return")
	location := p.Definition(0, Position{1, 29})
	if location == nil || location.URI != p.Documents[1].URI || location.Range.Start.Line != 0 {
		t.Fatal("resolved dynamic scene label lost its definition", location)
	}
}
func TestNativeBranchedIndirectReadRetainsAddressedBinding(t *testing.T) {
	text := "*create implicit_control_flow true\n*create pointer \"input\"\n*create input true\n*create output 0\n*gosub read\n*print output\n*ending\n*label read\n*if input\n  *set output {pointer}\n*else\n  *set output {pointer}\n*return"
	p := analyzeExample(t, text)
	if nativeClassification(t, p, 0, text, "*print output") != BooleanVariable {
		t.Fatal("branched indirect read lost its addressed input")
	}
}

func TestNativeVirtualArraysHaveNoElementPrecisionCap(t *testing.T) {
	text := "*create_array items 1000000000 1\n*gosub change\n*print items[999999999]\n*print items[2]\n*ending\n*label change\n*set items[2] true\n*return"
	p := analyzeExample(t, text)
	if nativeClassification(t, p, 0, text, "*print items[999999999]") != NumberVariable || nativeClassification(t, p, 0, text, "*print items[2]") != BooleanVariable {
		t.Fatal("virtual defaults lost precise explicit overrides")
	}
	text = "*create_array items 1501" + strings.Repeat(" 1", 1500) + " true\n*print items[1500]\n*print items[1501]\n*ending"
	p = analyzeExample(t, text)
	if nativeClassification(t, p, 0, text, "*print items[1500]") != NumberVariable || nativeClassification(t, p, 0, text, "*print items[1501]") != BooleanVariable {
		t.Fatal("large heterogeneous initializer was truncated")
	}
	text = "*create_array items 2000 1\n*temp_array items 2000 true\n*print items[1500]\n*delete_array items\n*print items[1501]\n*ending"
	p = analyzeExample(t, text)
	if nativeClassification(t, p, 0, text, "*print items[1500]") != BooleanVariable || nativeClassification(t, p, 0, text, "*print items[1501]") != NumberVariable {
		t.Fatal("virtual array scope or deletion hid a global value")
	}
}

func TestNativeBranchedStableIndirectParametersPreserveCallerBindings(t *testing.T) {
	text := "*create implicit_control_flow true\n*create output 0\n*create score 1\n*create outside false\n*gosub copy \"score\"\n*print output\n*set outside true\n*gosub copy \"score\"\n*print outside\n*ending\n*label copy\n*params target\n*if score > 0\n  *set output {target}\n*else\n  *set output {target}\n*return"
	p := analyzeExample(t, text)
	if nativeClassification(t, p, 0, text, "*print output") != NumberVariable || nativeClassification(t, p, 0, text, "*print outside") != BooleanVariable {
		t.Fatal("specialized branched indirection lost a read or caller binding")
	}
	text = "*create_array items 1000000000 1\n*create output 0\n*gosub read \"items_99999\"\n*print output\n*ending\n*label read\n*params pointer\n*set output {pointer}\n*return"
	p = analyzeExample(t, text)
	if nativeClassification(t, p, 0, text, "*print output") != NumberVariable {
		t.Fatal("projected indirect read lost a virtual array member")
	}
}

func TestSceneJumpAbandonsSubroutineReturns(t *testing.T) {
	for _, call := range []string{"*gosub route", "*gosub_scene startup route"} {
		text := "*create result 1\n" + call + "\n*set result true\n*print result\n*ending\n*label route\n*goto_scene helper"
		p := analyzeExample(t, text, "*return")
		if got := nativeClassification(t, p, 0, text, "*print result"); got != NumberVariable {
			t.Fatalf("%s returned through a stack erased by goto_scene: %s", call, TokenTypes[got])
		}
	}
}

func TestEndOfSceneNeverReturnsToLocalGosub(t *testing.T) {
	text := "*create result 1\n*scene_list\n  startup\n  helper\n*gosub route\n*set result true\n*print result\n*ending\n*label route\n*finish"
	p := analyzeExample(t, text, "*return")
	if got := nativeClassification(t, p, 0, text, "*print result"); got != NumberVariable {
		t.Fatal("finish revived a local gosub frame", TokenTypes[got])
	}
}
func TestFinishCanRetainOuterSceneCallFrame(t *testing.T) {
	p := NewProject()
	p.AddSource(Source{URI: "file:///original/startup.txt", Text: "*create result 1\n*scene_list\n  startup\n  helper\n  onward\n*gosub_scene helper\n*set result true\n*print result\n*ending"})
	p.AddSource(Source{URI: "file:///original/helper.txt", Text: "*gosub local\n*ending\n*label local\nA paragraph.\n*finish"})
	p.AddSource(Source{URI: "file:///original/onward.txt", Text: "*return"})
	if err := p.Analyze(context.Background()); err != nil {
		t.Fatal(err)
	}
	if got := nativeClassification(t, p, 0, "*create result 1\n*scene_list\n  startup\n  helper\n  onward\n*gosub_scene helper\n*set result true\n*print result\n*ending", "*print result"); got != BooleanVariable {
		t.Fatal("finish discarded the outer scene-call frame", TokenTypes[got])
	}
}
