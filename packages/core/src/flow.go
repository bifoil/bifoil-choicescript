package core

import (
	"context"
	"encoding/binary"
	"errors"
	"fmt"
	"regexp"
	"runtime"
	"sort"
	"strings"
)

// Project owns one complete project analysis. AddSource accepts one file at a
// time so closed narrative buffers can be released immediately after parsing.
type Project struct {
	queryTokens         []*queryTokens
	staticJumps         map[uint64]staticJump
	labelNodes          map[uint64]uint32
	disableStaticJumps  bool
	literalDeclarations map[uint64]literalDeclaration
	unsafeRenames       map[uint32]bool
	dynamicLocalName    uint32
	disableDirectRender bool
	disableRunOrder     bool
	slowQuoteTable      bool
	finishedScenes      map[uint64]flowState
	finishFrameCache    map[uint32][]uint32
	refreshFinishes     bool
	traceVisits         map[uint64]uint64
	dynamicLocals       []bool
	localFamilies       []map[string]bool
	disableReadMemo     bool
	disableBindingProof bool
	disableReturnProof  bool
	returnProofs        map[proofKey]*returnProof
	eagerReturns        bool
	returnPending       map[uint32]bool
	dirtyReturns        []uint32
	Revision            uint64
	forceClassic        bool
	classicScheduling   bool
	round, runningRank  uint32
	frames              map[uint32]*keyMask
	transient           uint32
	tokenValues         [][]Value
	tokenScopes         [][]uint32
	interpolationValues []map[uint64]Value
	arraySymbols        map[uint32]bool
	arrayDeclarations   map[key]uint32
	arrayReferences     map[uint64]bool
	arrayKeys           map[key][]uint32
	arrayKeysScanned    int
	arrayReads          []arrayReadMemo
	parameterScenes     map[string]bool
	arrayBases          map[uint32]bool
	disableTokenFacts   bool
	fixedText           map[uint64]uint64
	fixedSubstitutions  []map[uint64]bool
	disableQuoteProof   bool
	maximumArguments    int
	rootForContext      []uint32
	dynamicContexts     map[uint32]uint32
	declaredNames       map[uint32]bool
	parameters          map[uint64]parameterInfo
	Documents           []*Document
	names               registry
	bindings            []map[uint32]binding
	constantNames       map[uint32]bool
	allConstants        bool
	values              valuePool
	graphs              []flowGraph
	priority            []uint64
	ranks               [][]uint32
	orderEnds           []uint32
	runs                []map[uint32]narrativeRun
	scenes              map[string]uint32
	labels              map[key]uint32
	ordered             []uint32
	arena               envArena
	observed            [][]flowState
	observedQuotes      [][]uint8
	states              stateStore
	queue               []scheduledState
	contexts            map[callKey]uint32
	argumentContexts    map[string]uint32
	summaries           []flowState
	callContexts        []bool
	rootContexts        map[uint32]uint32
	waiting             [][]*continuation
	waitIndex           map[waitKey]*continuation
	effects             map[effectKey]*callEffects
	initial             flowState
	reads               uint32
	observing           bool
	Steps               uint64
	Trace               func(string, uint64, int, int, int)
	QuoteWarnings       bool
	Tokens              [][]Token
	Symbols             []Symbol
	symbols             map[key]uint32
	labelSymbols        map[key]uint32
	SceneSymbols        []uint32
	SymbolValues        []Value
}
type flowState struct {
	env       uint32
	quote     uint8
	paragraph bool
}
type scheduledState struct {
	key      stateKey
	priority uint64
}
type stateKey struct {
	node    uint64
	context uint32
}
type callKey struct {
	argument uint32
	node     uint64
	quote    uint8
}
type waitKey struct {
	site   stateKey
	callee uint32
}
type continuation struct {
	site    stateKey
	caller  flowState
	scope   uint32
	target  uint64
	restore bool
	effects *callEffects
}
type callEffects struct {
	noRegisters           bool
	mask                  *keyMask
	outputMask            *keyMask
	argumentCount         int
	inputKilled           map[uint32]bool
	needed, written       map[uint32]bool
	arrays, writtenArrays map[key]bool
	wideWrittenArrays     map[key]bool
	parameters            []uint32
}

func NewProject() *Project { return &Project{QuoteWarnings: true} }
func (p *Project) AddSource(source Source) *Document {
	doc := parseSource(source, uint32(len(p.Documents)+1), &p.names, &p.values)
	p.Documents = append(p.Documents, doc)
	return doc
}
func nodeID(doc, line uint32) uint64 { return uint64(doc)<<32 | uint64(line) }
func (p *Project) merge(a, b flowState) flowState {
	if a.quote == 0 {
		return b
	}
	return flowState{p.arena.join(a.env, b.env), a.quote | b.quote, a.paragraph && b.paragraph}
}
func (p *Project) schedule(context uint32, node uint64, state flowState) {
	if uint32(node) == 0 {
		return
	}
	key := stateKey{node, context}
	old := p.states.get(key)
	joined := p.merge(old, state)
	if old == joined {
		return
	}
	if p.Trace != nil && p.Steps%4096 == 0 && old.quote != 0 && old.env != joined.env {
		types, constants, presence := p.arena.differenceCounts(old.env, joined.env)
		p.Trace(fmt.Sprintf("join node=%x types=%d constants=%d presence=%d", node, types, constants, presence), p.Steps, p.states.count, len(p.queue), len(p.contexts))
	}
	p.states.set(key, joined)
	if p.states.isPending(key) {
		return
	}
	p.states.setPending(key, true)
	// Back edges wait for the rest of this round, collecting all branch updates
	// before revisiting an earlier region. No transfer or incoming edge is omitted.
	round := p.round
	if p.classicScheduling {
		round = 0
	}
	rank := uint32(p.rank(node))
	if !p.classicScheduling && rank < p.runningRank {
		round++
	}
	item := scheduledState{key, uint64(round)<<32 | uint64(rank)}
	p.queue = append(p.queue, item)
	for index := len(p.queue) - 1; index > 0; {
		parent := (index - 1) / 2
		if p.queue[parent].priority <= item.priority {
			break
		}
		p.queue[index] = p.queue[parent]
		index = parent
		p.queue[index] = item
	}
}
func (p *Project) pop() stateKey {
	result := p.queue[0]
	p.round = uint32(result.priority >> 32)
	last := p.queue[len(p.queue)-1]
	p.queue = p.queue[:len(p.queue)-1]
	if len(p.queue) > 0 {
		p.queue[0] = last
		for index := 0; ; {
			child := index*2 + 1
			if child >= len(p.queue) {
				break
			}
			if child+1 < len(p.queue) && p.queue[child+1].priority < p.queue[child].priority {
				child++
			}
			if p.queue[child].priority >= last.priority {
				break
			}
			p.queue[index] = p.queue[child]
			index = child
			p.queue[index] = last
		}
	}
	p.states.setPending(result.key, false)
	return result.key
}
func (p *Project) read(root, id uint32) Value {
	v := p.arena.get(root, id)
	if p.observing && v != 0 {
		p.reads = p.arena.set(p.reads, id, v)
	}
	return v
}

type binding struct {
	dynamicLocal                       uint32
	globalOnly                         bool
	local, global, localWild, wildName uint32
	defaults                           [4]uint32
	index                              uint64
}

func (p *Project) binding(scope, name uint32) binding {
	for len(p.bindings) <= int(scope) {
		p.bindings = append(p.bindings, nil)
	}
	if p.bindings[scope] == nil {
		p.bindings[scope] = make(map[uint32]binding)
	}
	if result, ok := p.bindings[scope][name]; ok {
		return result
	}
	wildcard := p.names.name(p.names.Names[name] + "_*")
	result := binding{local: p.names.key(scope, name), global: p.names.key(0, name), localWild: p.names.key(scope, wildcard), wildName: wildcard}
	result.globalOnly = p.globalBinding(scope, name)
	if int(scope) < len(p.dynamicLocals) && p.dynamicLocals[scope] {
		result.dynamicLocal = p.names.key(scope, p.dynamicLocalName)
	}
	p.bindVirtual(scope, name, &result)
	p.bindings[scope][name] = result
	return result
}
func (p *Project) active(root, scope, name uint32) uint32 {
	b := p.binding(scope, name)
	if b.globalOnly {
		return b.global
	}
	value, _ := p.localBinding(root, b)
	if value != 0 {
		return b.local
	}
	return b.global
}
func (p *Project) lookup(root, scope, name uint32) Value {
	if spelling := p.names.Names[name]; strings.HasSuffix(spelling, "_$any") {
		return p.anyArrayValue(root, scope, strings.TrimSuffix(spelling, "_$any"))
	}
	value, _ := p.lookupAndScope(root, scope, name)
	return value
}
func (p *Project) eval(d *Document, id, root uint32) Value {
	return evaluate(d, id, &p.names, &p.values, func(name uint32) Value { return p.lookup(root, d.Scope, name) })
}
func (p *Project) assigned(d *Document, node row, root uint32) uint32 {
	if node.TargetExpr == 0 {
		return node.Target
	}
	e := d.Exprs[node.TargetExpr]
	switch e.Kind {
	case exVariable:
		return e.Arg
	case exIndirect:
		if value, ok := p.values.constant(p.eval(d, e.A, root)); ok && Value(value.Kind) == StringType {
			return p.names.name(strings.ToLower(value.Text))
		}
	case exArray:
		var name strings.Builder
		name.WriteString(p.names.Names[e.Arg])
		for _, id := range d.Args[e.A : e.A+e.B] {
			value, ok := p.values.constant(p.eval(d, id, root))
			if !ok {
				return p.names.name(p.names.Names[e.Arg] + "_*")
			}
			name.WriteString("_" + value.string())
		}
		return p.names.name(name.String())
	}
	return 0
}

var arraySuffix = regexp.MustCompile(`^(?:\d+(?:_\d+)*|count|\*)$`)

func (p *Project) collect() {
	clear(p.arrayReads)
	p.arena.beginCollection()
	p.arena.mark(p.initial.env)
	p.arena.mark(p.transient)
	for _, state := range p.finishedScenes {
		p.arena.mark(state.env)
	}
	p.states.each(func(s flowState) { p.arena.mark(s.env) })
	if p.disableTokenFacts {
		for _, rows := range p.observed {
			for _, s := range rows {
				p.arena.mark(s.env)
			}
		}
	}
	for _, s := range p.summaries {
		p.arena.mark(s.env)
	}
	for _, waits := range p.waiting {
		for _, w := range waits {
			p.arena.mark(w.caller.env)
		}
	}
	p.arena.endCollection()

	// Select a lower-retention worklist before live state can fill the arena.
	// A retry recomputes the entire fixed point; no partial result is published.
	if !p.forceClassic && p.arena.used-p.arena.freeCount > maxEnvPages*3/4 {
		panic(errSchedulePressure)
	}

}
func (p *Project) prepare() {

	p.queryTokens = nil
	p.finishedScenes = make(map[uint64]flowState)
	p.finishFrameCache = make(map[uint32][]uint32)
	p.refreshFinishes = false
	if p.Trace != nil {
		p.traceVisits = make(map[uint64]uint64)
	}
	p.returnProofs = make(map[proofKey]*returnProof)
	p.classicScheduling = p.forceClassic
	p.Steps = 0
	p.maximumArguments = 0
	p.transient = 0
	p.frames = nil
	p.bindings = nil
	p.queue = nil
	for _, d := range p.Documents {
		d.Diagnostics = d.Diagnostics[:d.syntaxDiagnostics]
	}
	p.round, p.runningRank = 0, 0
	p.arena = envArena{registry: &p.names, values: &p.values}
	p.graphs = make([]flowGraph, len(p.Documents))
	p.observed = make([][]flowState, len(p.Documents))
	p.observedQuotes = make([][]uint8, len(p.Documents))
	p.scenes = make(map[string]uint32)
	p.labels = make(map[key]uint32)
	p.states = stateStore{}
	p.contexts = make(map[callKey]uint32)
	p.argumentContexts = make(map[string]uint32)
	p.summaries = make([]flowState, 2)
	p.callContexts = make([]bool, 2)
	p.rootForContext = make([]uint32, 2)
	p.dynamicContexts = map[uint32]uint32{0: 1}
	p.rootContexts = make(map[uint32]uint32)
	p.waiting = make([][]*continuation, 2)
	p.waitIndex = make(map[waitKey]*continuation)
	p.returnPending = make(map[uint32]bool)
	p.dirtyReturns = nil
	p.effects = make(map[effectKey]*callEffects)
	p.parameters = make(map[uint64]parameterInfo)
	p.declaredNames = make(map[uint32]bool)
	p.arrayBases = make(map[uint32]bool)
	p.arrayKeys = make(map[key][]uint32)
	p.arrayKeysScanned = 1
	p.arrayReads = nil
	var declarations, calls uint64
	for index, d := range p.Documents {
		p.scenes[d.Scene] = uint32(index)
		for _, sourceRowIndex := range d.semanticRows() {
			n := d.rowAt(int(sourceRowIndex))
			if command := p.names.Names[n.Command]; command == "create_array" || command == "temp_array" {
				p.arrayBases[n.Target] = true
			}
			if command := p.names.Names[n.Command]; command == "gosub" || command == "gosub_scene" {
				calls++
			}
			if declarationCommands[p.names.Names[n.Command]] {
				declarations++
				p.declaredNames[n.Target] = true
			}
		}
		p.graphs[index] = buildGraph(d, &p.names)
		if p.disableTokenFacts {
			p.observed[index] = make([]flowState, d.RowCount())
		} else {
			p.observedQuotes[index] = make([]uint8, d.RowCount())
		}
		for _, line := range d.semanticRows() {
			if p.names.Names[d.rowAt(int(line)).Command] == "label" {
				p.labels[key{d.Scope, d.rowAt(int(line)).Target}] = line
			}
		}
	}
	startup, ok := p.scenes["startup"]
	if !ok {
		startup = 0
	}
	if len(p.Documents) == 0 {
		return
	}
	p.ordered = []uint32{startup}
	d := p.Documents[startup]
	for _, line := range d.semanticRows() {
		n := d.rowAt(int(line))
		if n.Kind == metadata && n.Parent > 0 && p.names.Names[d.rowAt(int(n.Parent)).Command] == "scene_list" {
			if target, exists := p.scenes[p.names.Names[n.Target]]; exists && target != startup {
				p.ordered = append(p.ordered, target)
			}
		}
	}
	// Select a worklist before materializing expensive overlapping call inputs.
	// This is a storage estimate only; either strategy computes the same complete fixed point.
	if calls*declarations/uint64(envFanout) > uint64(maxEnvPages/3) {
		p.classicScheduling = true
		p.forceClassic = true
	}
	p.prepareStaticJumps()
	p.prepareSymbols()
	p.prepareBindings()
	p.tokenValues = make([][]Value, len(p.Documents))
	p.tokenScopes = make([][]uint32, len(p.Documents))
	p.interpolationValues = make([]map[uint64]Value, len(p.Documents))
	for index, d := range p.Documents {
		p.tokenValues[index] = make([]Value, len(d.Syntax))
		p.tokenScopes[index] = make([]uint32, len(d.Syntax))
		p.interpolationValues[index] = make(map[uint64]Value)
	}
	p.prepareConstants()
	if !p.disableQuoteProof {
		p.prepareQuoteProof()
	}
	p.prepareRuns()
	p.prepareOrder()
	p.initial = flowState{p.arena.set(0, p.names.key(0, p.names.name("implicit_control_flow")), p.values.boolean(false)), 1, true}
	p.rootContexts[0] = startup
	p.schedule(0, nodeID(startup, p.graphs[startup].entry), p.initial)
}

// Analyze always reaches the complete abstract fixed point unless cancelled or a
// genuine resource error occurs. It never publishes a reduced or partial result.
var errSchedulePressure = errors.New("complete analysis requires a lower-retention worklist")

func (p *Project) Analyze(ctx context.Context) error {
	err := p.analyze(ctx)
	if errors.Is(err, errSchedulePressure) {
		if p.Trace != nil {
			p.Trace("retrying complete analysis with lower-retention ordering", p.Steps, p.states.count, len(p.queue), len(p.contexts))
		}
		p.forceClassic = true
		return p.analyze(ctx)
	}
	return err
}
func (p *Project) analyze(ctx context.Context) (err error) {
	defer func() {
		if recovered := recover(); recovered != nil {
			if failure, ok := recovered.(error); ok {
				err = failure
			} else {
				panic(recovered)
			}
		}
	}()
	if err = ctx.Err(); err != nil {
		return err
	}
	p.prepare()
	if err = ctx.Err(); err != nil {
		return err
	}
	if p.Trace != nil {
		p.Trace("prepared", p.Steps, p.states.count, len(p.queue), len(p.contexts))
	}
	if err = p.run(ctx); err != nil {
		return err
	}
	for index, d := range p.Documents {
		seen := p.hasObservation(uint32(index))
		if !seen && p.graphs[index].entry != 0 {
			p.retireRootFlow()
			contextID := uint32(len(p.summaries))
			p.summaries = append(p.summaries, flowState{})
			p.waiting = append(p.waiting, nil)
			p.callContexts = append(p.callContexts, false)
			p.rootForContext = append(p.rootForContext, contextID)
			p.rootContexts[contextID] = uint32(index)
			isolated := p.initial
			isolated.quote = 7
			p.schedule(contextID, nodeID(uint32(index), p.graphs[index].entry), isolated)
			if err = p.run(ctx); err != nil {
				return err
			}
		}
		_ = d
	}
	if p.Trace != nil {
		var nodes []uint64
		for node := range p.traceVisits {
			nodes = append(nodes, node)
		}
		sort.Slice(nodes, func(i, j int) bool { return p.traceVisits[nodes[i]] > p.traceVisits[nodes[j]] })
		for _, node := range nodes[:min(25, len(nodes))] {
			d := p.Documents[uint32(node>>32)]
			n := d.rowAt(int(uint32(node)))
			p.Trace(fmt.Sprintf("hotspot doc=%d row=%d cmd=%s visits=%d", node>>32, uint32(node), p.names.Names[n.Command], p.traceVisits[node]), p.Steps, p.states.count, len(p.queue), len(p.contexts))
		}
	}
	p.states.reset()
	p.waiting = nil
	p.waitIndex = nil
	p.effects = nil
	p.queue = nil
	p.expandRuns()
	// All row observations are now complete. Rendering needs scene entry IDs,
	// but no successor vectors, worklist ranks or composed-run allocations.
	retired := 0
	for index := range p.graphs {
		graph := &p.graphs[index]
		retired += 4*(len(graph.next)+len(graph.edges)+len(p.ranks[index])) + len(graph.leaders)
		graph.next, graph.edges, graph.leaders = nil, nil, nil
	}
	p.ranks, p.orderEnds, p.priority = nil, nil, nil
	p.runs = nil
	release := retired > 8*1024*1024
	if !p.disableTokenFacts {
		p.collectSymbolValues()
		// Final rendering reads complete reference/interpolation facts, not live flow
		// environments. Retire pages before allocating final semantic spans so these
		// two large representations do not overlap at the process high-water mark.
		release = release || p.arena.used*(envFanout*4+16) > 8*1024*1024
		p.arena = envArena{registry: &p.names, values: &p.values}
	}
	if release {
		runtime.GC()
	}
	if err = ctx.Err(); err != nil {
		return err
	}
	p.render()
	p.prepareLiteralDeclarations()
	p.graphs = nil
	p.observed = nil
	p.observedQuotes = nil
	p.summaries = nil
	p.contexts = nil
	p.arena = envArena{}
	return nil
}
func (p *Project) complete(contextID uint32, state flowState) {
	old := p.summaries[contextID]
	joined := p.merge(old, state)
	if old == joined {
		return
	}
	p.summaries[contextID] = joined
	if p.eagerReturns {
		for _, w := range p.waiting[contextID] {
			p.deliver(w, joined)
		}
	} else if len(p.waiting[contextID]) > 0 && !p.returnPending[contextID] {
		p.returnPending[contextID] = true
		p.dirtyReturns = append(p.dirtyReturns, contextID)
	}
}
func (p *Project) deliver(w *continuation, summary flowState) {
	s := summary
	if w.effects != nil {
		s.env = p.arena.replace(w.caller.env, summary.env, p.returnMask(w.effects))
	}
	if w.restore {
		s.env = p.arena.normalize(p.arena.dropClass(s.env, 3, 0))
		s.env = p.arena.replace(s.env, w.caller.env, p.frameMask(w.scope))
	}

	doc, line := uint32(w.site.node>>32), uint32(w.site.node)
	for _, next := range p.graphs[doc].targets(line) {
		p.schedule(w.site.context, nodeID(doc, next), s)
	}
}
func (p *Project) jump(d *Document, n row, root uint32, c string) (target uint64, sceneKnown, labelKnown bool) {
	if resolved, ok := p.staticJumps[uint64(d.Scope)<<32|uint64(n.ExprStart)]; ok && n.ExprCount != 0 {
		return resolved.target, resolved.sceneKnown, resolved.labelKnown
	}
	refs := d.Args[n.ExprStart : n.ExprStart+n.ExprCount]
	get := func(index int) (string, bool) {
		if index >= len(refs) {
			return "", false
		}
		e := d.Exprs[refs[index]]
		id := refs[index]
		if e.Kind == exIndirect {
			id = e.A
		}
		if value, ok := p.values.constant(p.eval(d, id, root)); ok {
			return value.string(), true
		}
		if e.Kind == exVariable {
			return p.names.Names[e.Arg], true
		}
		return "", false
	}
	doc := d.Scope - 1
	var label string
	if strings.HasSuffix(c, "_scene") {
		scene, known := get(0)
		sceneKnown = known
		var exists bool
		doc, exists = p.scenes[scene]
		if !exists {
			return 0, sceneKnown, false
		}
		if len(refs) < 2 {
			return nodeID(doc, p.graphs[doc].entry), sceneKnown, true
		}
		label, labelKnown = get(1)
	} else {
		sceneKnown = true
		label, labelKnown = get(0)
	}
	if c == "gotoref" {
		value, ok := p.values.constant(p.eval(d, n.Expr, root))
		labelKnown = ok
		if ok {
			label = value.string()
		}
	}
	if labelKnown {
		target = nodeID(doc, p.labels[key{p.Documents[doc].Scope, p.names.name(strings.ToLower(label))}])
	}
	return
}
func (p *Project) run(ctx context.Context) error {
	var direct stateKey
	var directState flowState
	for len(p.queue) > 0 || direct.node != 0 || len(p.dirtyReturns) > 0 || p.refreshFinishes {
		if p.refreshFinishes {
			p.refreshSceneFrames()
		}
		if len(p.queue) == 0 && direct.node == 0 {
			dirty := p.dirtyReturns
			p.dirtyReturns = nil
			p.transient = 0
			for _, callee := range dirty {
				p.returnPending[callee] = false
				for _, w := range p.waiting[callee] {
					if p.arena.needsCollection() {
						p.collect()
					}
					p.deliver(w, p.summaries[callee])
				}
			}
			continue
		}
		if p.Steps&255 == 0 {
			if err := ctx.Err(); err != nil {
				return err
			}
		}
		p.transient = directState.env
		if p.arena.needsCollection() {
			p.collect()
		}
		p.Steps++
		if p.Trace != nil && p.Steps%1000000 == 0 {
			p.Trace(fmt.Sprintf("flow keys=%d constants=%d pages=%d preserveAll=%t", len(p.names.Keys), len(p.values.entries), p.arena.used, p.allConstants), p.Steps, p.states.count, len(p.queue), len(p.contexts))
		}
		key := direct
		input := directState
		if direct.node == 0 {
			key = p.pop()
			input = p.states.get(key)
		}
		direct = stateKey{}
		directState = flowState{}
		docIndex, line := uint32(key.node>>32), uint32(key.node)
		if p.Trace != nil {
			p.traceVisits[key.node]++
		}
		d := p.Documents[docIndex]
		n := d.lexicalRow(int(line))
		c := p.names.Names[n.Command]
		p.runningRank = uint32(p.rank(key.node))
		if !p.graphs[docIndex].leaders[line] {
			p.states.remove(key)
		}
		s := input
		if run, ok := p.runs[docIndex][line]; ok {
			observed := input
			observed.env = 0
			if !p.disableTokenFacts {
				for _, current := range run.FactRows {
					node := d.lexicalRow(int(current))
					p.recordRowTokens(d, &node, current, input.env, UnknownType)
				}
			} else if run.whole {
				observed.env = input.env
			} else if run.reads != nil {
				observed.env = p.projectCall(input, run.reads).env
			}
			p.observe(docIndex, line, observed)
			slot := (input.quote - 1) * 2
			if input.paragraph {
				slot++
			}
			s.quote = run.Exit[slot]
			s.paragraph = run.Paragraph&(1<<slot) != 0
			line = run.Last
			next := p.graphs[docIndex].targets(line)
			if len(next) > 0 {
				for _, target := range next {
					p.schedule(key.context, nodeID(docIndex, target), s)
				}
				continue
			}
			p.finish(key.context, docIndex, s)
			continue
		}
		p.observing = p.disableTokenFacts
		p.reads = 0

		expressionValue := UnknownType
		if n.Expr != 0 {
			expressionValue = p.eval(d, n.Expr, input.env)
		}
		if !p.disableTokenFacts {
			p.recordRowTokens(d, &n, line, input.env, expressionValue)
		} else {
			for id := n.TokenStart; id < n.TokenStart+n.TokenCount; id++ {
				if name := d.TokenName[id]; name != 0 {
					p.lookup(input.env, d.Scope, name)
					base := elementBase(p.names.Names[name])
					if base != p.names.Names[name] {
						p.lookup(input.env, d.Scope, p.names.name(base))
					}
				}
			}
			if n.TargetExpr != 0 {
				p.eval(d, n.TargetExpr, input.env)
			}
			for _, id := range d.Args[n.ExprStart : n.ExprStart+n.ExprCount] {
				p.eval(d, id, input.env)
			}
			for id := n.TokenStart; id < n.TokenStart+n.TokenCount; id++ {
				if expression := d.TokenExpr[id]; expression != 0 {
					p.eval(d, expression, input.env)
				}
			}
			if c == "params" {
				p.read(input.env, p.names.key(parameterScope, p.names.name("count")))
				parameter := 0
				for token := n.TokenStart; token < n.TokenStart+n.TokenCount; token++ {
					if d.Syntax[token].Type == Variable {
						p.read(input.env, p.names.key(parameterScope, p.names.name(fmt.Sprint(parameter))))
						parameter++
					}
				}
			}
		}
		if n.Kind == blank {
			s.paragraph = true
		}
		if n.Kind == prose || n.Kind == option || n.Inline != noOffset {
			p.textTransfer(d, line, &s, false, 0, 0, false)
		}
		observation := flowState{p.reads, input.quote, input.paragraph}
		p.observing = false
		p.observe(docIndex, line, observation)
		switch c {
		case "create", "temp", "set", "rand", "input_text", "input_number":
			if n.Target == 0 {
				break
			}
			value := expressionValue
			if c == "rand" || c == "input_number" {
				value = NumberType
			}
			if c == "input_text" {
				value = StringType
			}
			name := p.assigned(d, n, s.env)
			if name == 0 {
				s.env = p.arena.forget(s.env)
				break
			}
			id := p.active(s.env, d.Scope, name)
			if c == "create" {
				id = p.names.key(0, name)
			}
			if c == "temp" {
				id = p.names.key(d.Scope, name)
			}
			value = p.bindingValue(name, value)
			spelling := p.names.Names[name]
			if before, ok := strings.CutSuffix(spelling, "_*"); ok {
				s.env = p.writeUnknownArray(d, n, s.env, before, value)
			} else {
				if c == "create" || c == "temp" {
					s.env = p.arena.set(s.env, id, value)
				} else {
					s.env = p.writeActive(s.env, d.Scope, name, value)
				}
			}
			base := numericBase(spelling)
			if base != spelling {
				wildcard := p.active(s.env, d.Scope, p.names.name(base+"_*"))
				s.env = p.arena.set(s.env, wildcard, p.values.join(p.arena.get(s.env, wildcard), value))
			}
		case "create_array", "temp_array":
			var err error
			s.env, err = p.defineArray(ctx, d, n, s.env, c == "temp_array")
			if err != nil {
				return err
			}

		case "params":
			count := p.arena.get(s.env, p.names.key(parameterScope, p.names.name("count")))
			if count == 0 {
				count = UnknownType
			}
			countName := p.names.name("param_count")
			s.env = p.arena.set(s.env, p.names.key(d.Scope, countName), p.bindingValue(countName, count))
			index := 0
			for id := n.TokenStart; id < n.TokenStart+n.TokenCount; id++ {
				if d.Syntax[id].Type != Variable {
					continue
				}
				v := p.arena.get(s.env, p.names.key(parameterScope, p.names.name(fmt.Sprint(index))))
				if v == 0 {
					v = UnknownType
				}
				s.env = p.arena.set(s.env, p.names.key(d.Scope, d.TokenName[id]), p.bindingValue(d.TokenName[id], v))
				index++
				alias := p.names.name(fmt.Sprintf("param_%d", index))
				s.env = p.arena.set(s.env, p.names.key(d.Scope, alias), p.bindingValue(alias, v))
			}
			p.maximumArguments = max(p.maximumArguments, index)
			if limit, ok := p.values.constant(count); ok {
				for ; index < int(limit.Number); index++ {
					value := p.arena.get(s.env, p.names.key(parameterScope, p.names.name(fmt.Sprint(index))))
					if value == 0 {
						value = UnknownType
					}
					alias := p.names.name(fmt.Sprintf("param_%d", index+1))
					s.env = p.arena.set(s.env, p.names.key(d.Scope, alias), p.bindingValue(alias, value))
				}
			}
			s.env = p.arena.normalize(p.arena.dropClass(s.env, 2, 0))
		case "delete", "delete_array":
			name := p.assigned(d, n, s.env)
			if name == 0 {
				s.env = p.arena.forget(s.env)
				break
			}
			if c == "delete" {
				s.env = p.writeActive(s.env, d.Scope, name, bindingDeleted)
			} else {
				s.env = p.deleteArray(d, name, s.env)
			}
		case "setref":
			if name, ok := p.values.constant(p.eval(d, n.TargetExpr, s.env)); ok && Value(name.Kind) == StringType {
				targetName := p.names.name(strings.ToLower(name.Text))
				s.env = p.writeActive(s.env, d.Scope, targetName, p.bindingValue(targetName, p.eval(d, n.Expr, s.env)))
			} else {
				s.env = p.arena.forget(s.env)
			}
		case "print":
			p.renderedValue(&s, expressionValue)
		case "script":
			s.quote = 7
			s.env = p.arena.forgetValues(s.env, true)
			s.env = p.arena.set(s.env, p.names.key(d.Scope, p.dynamicLocalName), UnknownType)
		case "return":
			p.complete(key.context, s)
			continue
		case "ending", "abort", "restart":
			if p.callContexts[key.context] {
				p.complete(p.rootForContext[key.context], s)
			} else {
				p.complete(key.context, s)
			}
			continue
		case "goto", "gosub", "goto_scene", "gosub_scene", "redirect_scene", "gotoref":
			target, sceneKnown, labelKnown := p.jump(d, n, s.env, c)
			if uint32(target) != 0 {
				var refs []uint32
				var args []Value
				offset := 0
				if strings.HasPrefix(c, "gosub") || strings.HasSuffix(c, "_scene") {
					refs = d.Args[n.ExprStart : n.ExprStart+n.ExprCount]
					offset = 1
					if strings.HasSuffix(c, "_scene") && len(refs) > 1 {
						offset = 2
					}
					if offset > len(refs) {
						offset = len(refs)
					}
					args = make([]Value, len(refs)-offset)
					p.maximumArguments = max(p.maximumArguments, len(args))
					for i, id := range refs[offset:] {
						args[i] = p.eval(d, id, s.env)
						if !p.argumentNeedsConstant(target, i) {
							args[i] = p.values.abstract(args[i], p.values.quote(args[i]))
						}
					}
					if strings.HasSuffix(c, "_scene") {
						s.env = p.arena.normalize(p.arena.dropClass(s.env, 1, 0))
					}
					s.env = p.arena.normalize(p.arena.dropClass(s.env, 2, 0))
					s.env = p.arena.set(s.env, p.names.key(parameterScope, p.names.name("count")), p.values.number(float64(len(args))))
					for i, value := range args {
						s.env = p.arena.set(s.env, p.names.key(parameterScope, p.names.name(fmt.Sprint(i))), value)
					}
				}
				if strings.HasPrefix(c, "gosub") {
					planArguments := make([]Value, len(args))
					partition := uint32(0)
					if len(args) > 0 {
						signature := make([]byte, len(args)*4)
						for i, value := range args {
							code := uint32(value & 15)
							primitive, known := p.values.constant(value)
							stableName := known && Value(primitive.Kind) == StringType && p.declaredNames[p.names.name(strings.ToLower(primitive.Text))]
							if d.Exprs[refs[offset+i]].Kind == exLiteral || stableName && p.argumentNeedsConstant(target, i) {
								code = uint32(value) | 1<<31
							}
							if code&(1<<31) != 0 {
								planArguments[i] = value
							} else {
								planArguments[i] = p.values.abstract(value, p.values.quote(value))
							}
							binary.LittleEndian.PutUint32(signature[i*4:], code)
						}
						encoded := string(signature)
						var exists bool
						partition, exists = p.argumentContexts[encoded]
						if !exists {
							partition = uint32(len(p.argumentContexts) + 1)
							p.argumentContexts[encoded] = partition
						}
					}
					if !p.disableReturnProof && !p.disableTokenFacts {
						if proof := p.proveReturn(target, planArguments); proof != nil {
							returned := p.provedReturn(proof, s, args)
							if c == "gosub_scene" {
								returned.env = p.arena.normalize(p.arena.dropClass(returned.env, 3, 0))
								returned.env = p.arena.replace(returned.env, input.env, p.frameMask(d.Scope))
							}
							for _, next := range p.graphs[docIndex].targets(line) {
								p.schedule(key.context, nodeID(docIndex, next), returned)
							}
							continue
						}
					}
					calleeKey := callKey{argument: partition, node: target, quote: s.quote}
					callee, exists := p.contexts[calleeKey]
					if !exists {
						callee = uint32(len(p.summaries))
						p.contexts[calleeKey] = callee
						p.summaries = append(p.summaries, flowState{})
						p.waiting = append(p.waiting, nil)
						p.callContexts = append(p.callContexts, true)
						p.rootForContext = append(p.rootForContext, p.rootForContext[key.context])
					}
					effects := p.calleeEffects(target, partition, planArguments)
					waitID := waitKey{key, callee}
					w := p.waitIndex[waitID]
					if w == nil {
						w = &continuation{site: key, scope: d.Scope, target: target, restore: c == "gosub_scene", effects: effects}
						p.waitIndex[waitID] = w
						p.waiting[callee] = append(p.waiting[callee], w)
						p.refreshFinishes = true
					}
					w.caller = p.merge(w.caller, input)
					p.schedule(callee, target, p.projectCall(s, effects))
					if p.summaries[callee].quote != 0 {
						p.deliver(w, p.summaries[callee])
					}
				} else {
					contextID := key.context
					if c == "goto_scene" || c == "redirect_scene" {
						contextID = p.rootForContext[contextID]
					}
					p.schedule(contextID, target, s)
				}
			} else {
				s.quote = 7
				s.env = p.arena.forget(s.env)
				if strings.HasSuffix(c, "_scene") && !sceneKnown {
					for index, g := range p.graphs {
						p.scheduleDynamic(p.rootForContext[key.context], nodeID(uint32(index), g.entry), s)
					}
				} else if !labelKnown {
					for k, line := range p.labels {
						if k.Scope == d.Scope {
							p.scheduleDynamic(key.context, nodeID(docIndex, line), s)
						}
					}
				}
				if strings.HasPrefix(c, "gosub") {
					for _, next := range p.graphs[docIndex].targets(line) {
						p.schedule(key.context, nodeID(docIndex, next), s)
					}
				}
			}
			continue
		case "goto_random_scene":
			for _, child := range d.children(line) {
				if target, ok := p.scenes[p.names.Names[d.rowAt(int(child)).Target]]; ok {
					next := s
					next.env = p.arena.normalize(p.arena.dropClass(next.env, 1, 0))
					p.schedule(p.rootForContext[key.context], nodeID(target, p.graphs[target].entry), next)
				}
			}
			if strings.Contains(d.args(line), "allow_no_selection") {
				for _, next := range p.graphs[docIndex].targets(line) {
					p.schedule(key.context, nodeID(docIndex, next), s)
				}
			}
			continue
		}
		next := p.graphs[docIndex].targets(line)
		if c == "finish" || len(next) == 0 {
			p.finish(key.context, docIndex, s)
			continue
		}
		if len(next) == 1 && !p.graphs[docIndex].leaders[next[0]] {
			direct = stateKey{nodeID(docIndex, next[0]), key.context}
			directState = s
		} else {
			for _, target := range next {
				p.schedule(key.context, nodeID(docIndex, target), s)
			}
		}
	}
	p.transient = 0
	return nil
}

func (p *Project) finish(contextID, doc uint32, state flowState) {
	id := uint64(doc)<<32 | uint64(contextID)
	p.finishedScenes[id] = p.merge(p.finishedScenes[id], state)
	p.propagateFinish(contextID, doc, state)
}

// Disconnected scene roots have no proven predecessor. Their complete analysis
// must not widen real callers through shared subroutine continuations. Keep the
// per-line observations, then retire a finished root's flow and call subscriptions.
func (p *Project) retireRootFlow() {
	clear(p.finishedScenes)
	clear(p.finishFrameCache)
	p.refreshFinishes = false
	p.states.reset()
	clear(p.contexts)
	clear(p.waitIndex)
	for id := range p.summaries {
		if _, root := p.rootContexts[uint32(id)]; root {
			state := p.summaries[id]
			state.env = 0
			p.summaries[id] = state
		} else {
			p.summaries[id] = flowState{}
		}
		p.waiting[id] = nil
	}
	p.collect()
}
func (p *Project) scheduleDynamic(contextID uint32, node uint64, state flowState) {
	root := p.rootForContext[contextID]
	dynamic, exists := p.dynamicContexts[root]
	if !exists {
		dynamic = uint32(len(p.summaries))
		p.dynamicContexts[root] = dynamic
		p.summaries = append(p.summaries, flowState{})
		p.waiting = append(p.waiting, nil)
		p.callContexts = append(p.callContexts, false)
		p.rootForContext = append(p.rootForContext, root)
	}
	p.schedule(dynamic, node, state)
}
