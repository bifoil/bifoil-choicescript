package core

import "strings"

// Store scheduling nodes in reverse postorder. A compiled narrative run keeps
// its exact full transfer and complete row observations; its internal nodes need
// no additional worklist ordering. Uncompiled paths retain the original order.
func (p *Project) prepareOrder() {
	p.ranks = make([][]uint32, len(p.Documents))
	p.orderEnds = nil
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
	// Consecutive uncompiled prose nodes share a stack frame. Every node
	// that the scheduler can receive retains its reverse-postorder rank.
	type orderFrame struct {
		node          uint64
		cursor, count uint32
	}
	var stack []orderFrame
	var finished uint32
	walk := func(root uint64) {
		doc, line := uint32(root>>32), uint32(root)
		if line == 0 || visited[doc][line] {
			return
		}
		stack = append(stack, orderFrame{node: root, count: 1})
		visited[doc][line] = true
		for len(stack) > 0 {
			top := len(stack) - 1
			node := stack[top].node
			cursor := int(stack[top].cursor)
			doc, line := uint32(node>>32), uint32(node)
			d := p.Documents[doc]
			c := p.names.Names[d.rowCommand(line)]
			next := p.graphs[doc].targets(line)
			// A run has one predecessor per internal node and its exact full
			// transfer is already compiled. Only its entry can be scheduled.
			if !p.disableRunOrder && int(doc) < len(p.runs) {
				if run, ok := p.runs[doc][line]; ok {
					next = p.graphs[doc].targets(run.Last)
				}
			}
			var target uint64
			has := false
			switch c {
			case "return", "ending", "abort", "restart":
			case "goto", "gotoref", "goto_scene", "redirect_scene", "gosub", "gosub_scene":
				call := strings.HasPrefix(c, "gosub")
				if call && cursor < len(next) {
					target = nodeID(doc, next[cursor])
					has = true
				} else if cursor == 0 || call && cursor == len(next) {
					target, _, _ = p.jump(d, d.rowAt(int(line)), 0, c)
					has = uint32(target) != 0
				}
			default:
				if c == "finish" || len(next) == 0 {
					if cursor == 0 && nextScene[doc] != noOffset {
						dest := nextScene[doc]
						target = nodeID(dest, p.graphs[dest].entry)
						has = uint32(target) != 0
					}
				} else if cursor < len(next) {
					target = nodeID(doc, next[cursor])
					has = true
				}
			}
			stack[top].cursor++
			if !has {
				finished++
				p.ranks[doc][line] = finished
				if stack[top].count > 1 {
					stack[top].node--
					stack[top].count--
					stack[top].cursor = 1
				} else {
					stack = stack[:top]
				}
				continue
			}
			targetDoc, targetLine := uint32(target>>32), uint32(target)
			if !visited[targetDoc][targetLine] {
				visited[targetDoc][targetLine] = true
				if c == "" && cursor == 0 && len(next) == 1 && targetDoc == doc && targetLine == line+1 {
					stack[top].node = target
					stack[top].count++
					stack[top].cursor = 0
				} else {
					stack = append(stack, orderFrame{node: target, count: 1})
				}
			}
		}
		p.orderEnds = append(p.orderEnds, finished)
	}
	for _, doc := range append(append([]uint32(nil), p.ordered...), documentIndices(len(p.Documents))...) {
		walk(nodeID(doc, p.graphs[doc].entry))
		for line := uint32(1); line < uint32(p.Documents[doc].RowCount()); line++ {
			walk(nodeID(doc, line))
			if !p.disableRunOrder && int(doc) < len(p.runs) {
				if run, ok := p.runs[doc][line]; ok {
					line = run.Last
				}
			}
		}
	}
}
