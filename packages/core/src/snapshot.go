package core

import (
	"io"
)

// QuerySnapshot is a lossless language-feature index. Paging a complete index to
// owned local storage bounds memory across many games without dropping scenes,
// syntax diagnostics, symbol bindings, or semantic classifications.
type QuerySnapshot struct {
	LiteralDeclarations map[uint64]literalDeclaration
	Documents           []*Document
	Tokens              [][]Token
	Symbols             []Symbol
	SymbolValues        []Value
	SceneSymbols        []uint32
	Names               []string
	UnsafeRenames       map[uint32]bool
	ArraySymbols        map[uint32]bool
	ParameterScenes     map[string]bool
	Steps               uint64
	QuoteWarnings       bool
	Revision            uint64
}

// CompactForQueries releases flow-only state after the fixed point and rendering.
// Query methods never evaluate source; all classifications and bindings are final.
func (p *Project) CompactForQueries() {
	if p.queryTokens == nil {
		p.compactQueryTokens()
	}
	for _, d := range p.Documents {
		d.compactQueryRows()
		d.Exprs = nil
		d.Args = nil
		d.TokenName = nil
		d.TokenExpr = nil
		d.Substitutions = nil
		d.substitutionRows = nil
		d.semanticRowIndex = nil
		d.nonBlankRows = 0
		d.RawRows = nil
		d.QuoteMarks = nil
		d.Templates = nil
	}
	p.names.keys = nil
	p.names.names = nil
	p.names.Keys = nil
	p.values = valuePool{}
	p.bindings = nil
	p.arrayBases = nil
	p.frames = nil
	p.tokenValues = nil
	p.tokenScopes = nil
	p.interpolationValues = nil
	p.fixedText = nil
	p.fixedSubstitutions = nil
	p.parameters = nil
	p.constantNames = nil
	p.declaredNames = nil
	p.runs = nil
	p.ranks = nil
	p.orderEnds = nil
	p.priority = nil
	p.ordered = nil
	p.scenes = nil
	p.labels = nil
	p.staticJumps = nil
	p.labelNodes = nil
	p.rootForContext = nil
	p.rootContexts = nil
	p.dynamicContexts = nil
	p.argumentContexts = nil
	p.callContexts = nil
	p.symbols = nil
	p.arrayDeclarations = nil
	p.arrayReferences = nil
	p.arrayKeys = nil
	p.arrayReads = nil
	p.labelSymbols = nil
}
func (p *Project) WriteSnapshot(w io.Writer) error {
	s := QuerySnapshot{
		LiteralDeclarations: p.literalDeclarations,
		Documents:           nil,
		Tokens:              nil,
		Symbols:             p.Symbols,
		SymbolValues:        p.SymbolValues,
		SceneSymbols:        p.SceneSymbols,
		Names:               p.names.Names,
		UnsafeRenames:       p.unsafeRenames,
		ArraySymbols:        p.arraySymbols,
		ParameterScenes:     p.parameterScenes,
		Steps:               p.Steps,
		QuoteWarnings:       p.QuoteWarnings,
		Revision:            p.Revision,
	}

	return p.writeNumericSnapshot(w, s)
}
func ReadSnapshot(r io.Reader) (*Project, error) { return readNumericSnapshot(r) }
