package core

import "sort"

// A narrative run composes exact finite-state transfers for a single-predecessor
// chain. Every physical row is retained for rendering, ranges, and diagnostics.
// Only repeated fixed-point traversal is summarized.
type narrativeRun struct {
	FactRows  []uint32
	reads     *callEffects
	whole     bool
	Last      uint32
	Exit      [14]uint8
	Paragraph uint16
}

func markupFlags(tag string) uint8 {
	switch tag {
	case "[b]", "[B]":
		return 16
	case "[/b]", "[/B]":
		return 32
	case "[i]", "[I]":
		return 64
	case "[/i]", "[/I]":
		return 128
	}
	return 0
}
func (p *Project) rank(node uint64) uint64 {
	ordinal := p.ranks[uint32(node>>32)][uint32(node)]
	if ordinal == 0 {
		return 0
	}
	if len(p.orderEnds) == 1 {
		return uint64(p.orderEnds[0] + 1 - ordinal)
	}
	index := sort.Search(len(p.orderEnds), func(i int) bool { return p.orderEnds[i] >= ordinal })
	start := uint32(0)
	if index > 0 {
		start = p.orderEnds[index-1]
	}
	return uint64(start + p.orderEnds[index] + 1 - ordinal)
}
func (p *Project) prepareRuns() {
	p.priority = make([]uint64, len(p.Documents))
	var offset uint64
	seen := make(map[uint32]bool)
	for _, doc := range append(append([]uint32(nil), p.ordered...), documentIndices(len(p.Documents))...) {
		if !seen[doc] {
			seen[doc] = true
			p.priority[doc] = offset
			offset += uint64(p.Documents[doc].RowCount())
		}
	}
	p.runs = make([]map[uint32]narrativeRun, len(p.Documents))
	for docIndex, d := range p.Documents {
		graph := &p.graphs[docIndex]
		runs := make(map[uint32]narrativeRun)
		p.runs[docIndex] = runs
		included := make([]bool, d.RowCount())
		pure := func(line uint32) bool { kind, flags := d.rowClass(line); return flags&3 != 0 || kind == blank }
		for first := uint32(1); first < uint32(d.RowCount()); first++ {
			if included[first] || !pure(first) {
				continue
			}
			run := narrativeRun{}
			for slot := range run.Exit {
				run.Exit[slot] = uint8(slot/2 + 1)
			}
			paragraphs := uint16(0x2aaa)
			var referenceRows []uint32
			count := 0
			// Discover the chain and compose all fourteen input states in one pass.
			// Only the dense reference analyzer retains a temporary list of its rows.
			for line := first; ; {
				included[line] = true
				count++
				run.Last = line
				if p.disableTokenFacts {
					referenceRows = append(referenceRows, line)
				} else if d.rowHasSyntax(line) {
					node := d.rowAt(int(line))
					for token := node.TokenStart; token < node.TokenStart+node.TokenCount; token++ {
						if d.Syntax[token].Type == Variable || d.Syntax[token].Type == Label {
							run.FactRows = append(run.FactRows, line)
							break
						}
					}
				}
				kind, flags := d.rowClass(line)
				if kind == blank {
					paragraphs = 0x3fff
				} else if kind != option {
					var table uint64
					if flags&1 != 0 {
						table = d.Templates[line].Exit
					} else {
						table = p.fixedText[nodeID(uint32(docIndex), line)]
					}
					if table != 0 {
						for slot, quote := range run.Exit {
							input := (quote - 1) * 2
							if paragraphs&(1<<slot) != 0 {
								input++
							}
							run.Exit[slot] = uint8(table >> (input * 3) & 7)
						}
					}
					paragraphs = 0
				}
				next := graph.targets(line)
				if len(next) != 1 || graph.leaders[next[0]] || included[next[0]] || !pure(next[0]) {
					break
				}
				line = next[0]
			}
			if count < 2 {
				continue
			}
			run.Paragraph = paragraphs
			if p.disableTokenFacts {
				run.reads, run.whole = p.runReads(d, referenceRows)
			}
			runs[first] = run
		}
	}
}
func documentIndices(count int) []uint32 {
	result := make([]uint32, count)
	for i := range result {
		result[i] = uint32(i)
	}
	return result
}
func (p *Project) expandRuns() {
	for index, runs := range p.runs {
		d := p.Documents[index]
		g := p.graphs[index]
		for first, run := range runs {
			state := p.observation(uint32(index), first)
			if state.quote == 0 {
				continue
			}
			for line := first; ; {
				p.setObservation(uint32(index), line, state)
				kind, flags := d.rowClass(line)
				if kind == blank {
					state.paragraph = true
				} else if kind != option {
					state.quote = p.flowTextFlags(d, line, state.quote, state.paragraph, flags)
					state.paragraph = false
				}
				if line == run.Last {
					break
				}
				line = g.targets(line)[0]
			}
		}
	}
}
