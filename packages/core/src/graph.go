package core

import "slices"

// A graph row stores its one successor directly, or a count-prefixed edge-vector
// offset. Building ordinary sequences does not allocate a slice per source line.
type flowGraph struct {
	next, edges []uint32
	leaders     []bool
	entry       uint32
}

const edgeVector uint32 = 1 << 31

func (g *flowGraph) targets(line uint32) []uint32 {
	value := g.next[line]
	if value == 0 {
		return nil
	}
	if value&edgeVector == 0 {
		return g.next[line : line+1]
	}
	start := value &^ edgeVector
	return g.edges[start+1 : start+1+g.edges[start]]
}

type graphTargets struct {
	one  uint32
	many []uint32
}

func (t graphTargets) empty() bool { return t.one == 0 && len(t.many) == 0 }
func (t graphTargets) first() uint32 {
	if t.one != 0 {
		return t.one
	}
	if len(t.many) > 0 {
		return t.many[0]
	}
	return 0
}
func (g *flowGraph) put(line uint32, targets graphTargets) {
	if targets.one != 0 {
		g.next[line] = targets.one
		return
	}
	if len(targets.many) == 0 {
		return
	}
	if len(targets.many) == 1 {
		g.next[line] = targets.many[0]
		return
	}
	g.next[line] = edgeVector | uint32(len(g.edges))
	g.edges = append(g.edges, uint32(len(targets.many)))
	g.edges = append(g.edges, targets.many...)
}
func unionTargets(left, right graphTargets) graphTargets {
	if left.empty() {
		return right
	}
	if right.empty() {
		return left
	}
	if left.one != 0 && left.one == right.one {
		return left
	}
	result := append([]uint32(nil), left.many...)
	if left.one != 0 {
		result = append(result, left.one)
	}
	appendUnique := func(value uint32) {
		if slices.Contains(result, value) {
			return
		}
		result = append(result, value)
	}
	if right.one != 0 {
		appendUnique(right.one)
	} else {
		for _, value := range right.many {
			appendUnique(value)
		}
	}
	if len(result) == 1 {
		return graphTargets{one: result[0]}
	}
	return graphTargets{many: result}
}
func buildGraph(d *Document, names *registry) flowGraph {
	g := flowGraph{next: make([]uint32, d.RowCount()), leaders: make([]bool, d.RowCount())}
	var block func([]uint32, graphTargets) graphTargets
	block = func(lines []uint32, after graphTargets) graphTargets {
		filtered := make([]uint32, 0, len(lines))
		for _, line := range lines {
			if names.Names[d.rowCommand(line)] != "comment" {
				filtered = append(filtered, line)
			}
		}
		next := after
		for i := len(filtered) - 1; i >= 0; i-- {
			line := filtered[i]
			c := names.Names[d.rowCommand(line)]
			alternative := func(s string) bool { return s == "else" || s == "elseif" || s == "elsif" }
			if alternative(c) {
				start := i
				for start >= 0 && alternative(names.Names[d.rowCommand(filtered[start])]) {
					start--
				}
				if start >= 0 && names.Names[d.rowCommand(filtered[start])] == "if" {
					alt := next
					for j := i; j >= start; j-- {
						branch := filtered[j]
						body := block(d.children(branch), next)
						if names.Names[d.rowCommand(branch)] != "else" {
							body = unionTargets(body, alt)
						}
						g.put(branch, body)
						alt = graphTargets{one: branch}
					}
					next = alt
					i = start
					continue
				}
			}
			switch {
			case c == "if" || c == "selectable_if":
				g.put(line, unionTargets(block(d.children(line), next), next))
			case c == "choice" || c == "fake_choice":
				targets := graphTargets{}
				for _, child := range d.children(line) {
					kind := d.rowKind(child)
					if kind != blank && kind != comment {
						targets = unionTargets(targets, block([]uint32{child}, next))
					}
				}
				if targets.empty() {
					targets = next
				}
				g.put(line, targets)
			case d.rowKind(line) == metadata || metadataCommands[c]:
				g.put(line, next)
			default:
				child := d.rowFirstChild(line)
				if child == 0 {
					g.put(line, next)
				} else {
					// A paragraph's trailing blank line is a common leaf child. Preserve
					// both physical nodes and the paragraph transfer without recursive
					// block setup or temporary one-element slices.
					if d.rowNextSibling(child) == 0 && d.rowFirstChild(child) == 0 && d.rowKind(child) == blank {
						g.put(child, next)
						g.put(line, graphTargets{one: child})
					} else {
						g.put(line, block(d.children(line), next))
					}
				}
			}
			next = graphTargets{one: line}
		}
		return next
	}
	entries := block(d.Roots, graphTargets{})
	g.entry = entries.first()
	if g.entry != 0 {
		g.leaders[g.entry] = true
	}
	counts := make([]uint8, d.RowCount())
	for i := uint32(1); i < uint32(d.RowCount()); i++ {
		if names.Names[d.rowCommand(i)] == "label" {
			g.leaders[i] = true
		}
		for _, target := range g.targets(i) {
			if counts[target] < 2 {
				counts[target]++
			}
			if counts[target] > 1 {
				g.leaders[target] = true
			}
		}
	}
	return g
}
