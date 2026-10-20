package core

// A graph row either stores its single successor directly, or an offset into a
// shared count-prefixed edge arena. Structural edges never cross scenes.
type referenceFlowGraph struct {
	next    []uint32
	edges   []uint32
	leaders []bool
	entry   uint32
}

const referenceEdgeVector uint32 = 1 << 31

func (g *referenceFlowGraph) targets(line uint32) []uint32 {
	value := g.next[line]
	if value == 0 {
		return nil
	}
	if value&referenceEdgeVector == 0 {
		return g.next[line : line+1]
	}
	start := value &^ referenceEdgeVector
	return g.edges[start+1 : start+1+g.edges[start]]
}
func (g *referenceFlowGraph) put(line uint32, targets []uint32) {
	if len(targets) == 0 {
		return
	}
	if len(targets) == 1 {
		g.next[line] = targets[0]
		return
	}
	g.next[line] = referenceEdgeVector | uint32(len(g.edges))
	g.edges = append(g.edges, uint32(len(targets)))
	g.edges = append(g.edges, targets...)
}
func referenceUnionTargets(left, right []uint32) []uint32 {
	result := append([]uint32(nil), left...)
	for _, value := range right {
		found := false
		for _, old := range result {
			found = found || old == value
		}
		if !found {
			result = append(result, value)
		}
	}
	return result
}
func referenceBuildGraph(d *Document, names *registry) referenceFlowGraph {
	g := referenceFlowGraph{next: make([]uint32, len(d.Rows)), leaders: make([]bool, len(d.Rows))}
	var block func([]uint32, []uint32) []uint32
	block = func(lines, after []uint32) []uint32 {
		filtered := make([]uint32, 0, len(lines))
		for _, line := range lines {
			if names.Names[d.Rows[line].Command] != "comment" {
				filtered = append(filtered, line)
			}
		}
		next := after
		for i := len(filtered) - 1; i >= 0; i-- {
			line := filtered[i]
			node := d.Rows[line]
			c := names.Names[node.Command]
			alternative := func(s string) bool { return s == "else" || s == "elseif" || s == "elsif" }
			if alternative(c) {
				start := i
				for start >= 0 && alternative(names.Names[d.Rows[filtered[start]].Command]) {
					start--
				}
				if start >= 0 && names.Names[d.Rows[filtered[start]].Command] == "if" {
					alt := next
					for j := i; j >= start; j-- {
						branch := filtered[j]
						body := block(d.children(branch), next)
						if names.Names[d.Rows[branch].Command] != "else" {
							body = referenceUnionTargets(body, alt)
						}
						g.put(branch, body)
						alt = []uint32{branch}
					}
					next = alt
					i = start
					continue
				}
			}
			children := d.children(line)
			switch {
			case c == "if" || c == "selectable_if":
				g.put(line, referenceUnionTargets(block(children, next), next))
			case c == "choice" || c == "fake_choice":
				var targets []uint32
				for _, child := range children {
					if d.Rows[child].Kind != blank && d.Rows[child].Kind != comment {
						targets = referenceUnionTargets(targets, block([]uint32{child}, next))
					}
				}
				if len(targets) == 0 {
					targets = next
				}
				g.put(line, targets)
			case node.Kind == metadata || metadataCommands[c]:
				g.put(line, next)
			default:
				if len(children) > 0 {
					g.put(line, block(children, next))
				} else {
					g.put(line, next)
				}
			}
			next = []uint32{line}
		}
		return next
	}
	entries := block(d.Roots, nil)
	if len(entries) > 0 {
		g.entry = entries[0]
		g.leaders[g.entry] = true
	}
	counts := make([]uint8, len(d.Rows))
	for i := uint32(1); i < uint32(len(d.Rows)); i++ {
		if names.Names[d.Rows[i].Command] == "label" {
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
