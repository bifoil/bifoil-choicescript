package core

import "strings"

// Reverse postorder follows actual static jump destinations rather than file
// layout. Ordering changes convergence work, never the reachable graph or joins.
func (p *Project) referencePrepareOrder() {
	p.ranks = make([][]uint32, len(p.Documents))
	visited := make([][]bool, len(p.Documents))
	nextScene := make([]uint32, len(p.Documents))
	for index, d := range p.Documents {
		p.ranks[index] = make([]uint32, d.RowCount())
		visited[index] = make([]bool, d.RowCount())
		nextScene[index] = noOffset
	}
	for i, doc := range p.ordered {
		if i+1 < len(p.ordered) {
			nextScene[doc] = p.ordered[i+1]
		}
	}
	type frame struct {
		node uint64
		next int
	}
	var postorder []uint64
	var stack []frame
	var roots []uint64
	for _, doc := range append(append([]uint32(nil), p.ordered...), documentIndices(len(p.Documents))...) {
		roots = append(roots, nodeID(doc, p.graphs[doc].entry))
		for line := uint32(1); line < uint32(p.Documents[doc].RowCount()); line++ {
			roots = append(roots, nodeID(doc, line))
		}
	}
	// Each reachable component receives its own reverse postorder.
	var priority uint32
	for rootIndex := 0; rootIndex < len(roots); rootIndex++ {
		root := roots[rootIndex]
		doc, line := uint32(root>>32), uint32(root)
		if line == 0 || visited[doc][line] {
			continue
		}
		componentStart := len(postorder)
		stack = append(stack, frame{node: root})
		visited[doc][line] = true
		for len(stack) > 0 {
			top := &stack[len(stack)-1]
			doc, line := uint32(top.node>>32), uint32(top.node)
			d := p.Documents[doc]
			n := d.rowAt(int(line))
			c := p.names.Names[n.Command]
			next := p.graphs[doc].targets(line)
			var target uint64
			has := false
			switch c {
			case "return", "ending", "abort", "restart":
			case "goto", "gotoref", "goto_scene", "redirect_scene", "gosub", "gosub_scene":
				call := strings.HasPrefix(c, "gosub")
				if call && top.next < len(next) {
					target = nodeID(doc, next[top.next])
					has = true
				} else if top.next == 0 || call && top.next == len(next) {
					target, _, _ = p.jump(d, n, 0, c)
					has = uint32(target) != 0
				}
			default:
				if c == "finish" || len(next) == 0 {
					if top.next == 0 && nextScene[doc] != noOffset {
						dest := nextScene[doc]
						target = nodeID(dest, p.graphs[dest].entry)
						has = uint32(target) != 0
					}
				} else if top.next < len(next) {
					target = nodeID(doc, next[top.next])
					has = true
				}
			}
			top.next++
			if !has {
				postorder = append(postorder, top.node)
				stack = stack[:len(stack)-1]
				continue
			}
			targetDoc, targetLine := uint32(target>>32), uint32(target)
			if !visited[targetDoc][targetLine] {
				visited[targetDoc][targetLine] = true
				stack = append(stack, frame{node: target})
			}
		}
		count := len(postorder) - componentStart
		for index, node := range postorder[componentStart:] {
			p.ranks[uint32(node>>32)][uint32(node)] = priority + uint32(count-index)
		}
		priority += uint32(count)
	}
}
