package core

import (
	"fmt"
	"strings"
)

type parameterInfo struct {
	names []uint32
	known bool
	binds bool
}

func (p *Project) callParameters(target uint64) parameterInfo {
	if info, ok := p.parameters[target]; ok {
		return info
	}
	doc, line := uint32(target>>32), uint32(target)
	d := p.Documents[doc]
	seen := make(map[uint32]bool)
	info := parameterInfo{known: true}
	for line != 0 && !seen[line] {
		seen[line] = true
		n := d.rowAt(int(line))
		c := p.names.Names[n.Command]
		if c == "params" {
			info.binds = true
			for token := n.TokenStart; token < n.TokenStart+n.TokenCount; token++ {
				if name := d.TokenName[token]; name != 0 {
					info.names = append(info.names, name)
				}
			}
			break
		}
		if c == "return" || c == "ending" || c == "abort" || c == "restart" {
			break
		}
		if c == "goto" {
			destination, _, known := p.jump(d, n, 0, c)
			if known && uint32(destination>>32) == doc && uint32(destination) != 0 {
				line = uint32(destination)
				continue
			}
			info.known = false
			break
		}
		if blockCommands[c] || strings.HasPrefix(c, "goto") || strings.HasPrefix(c, "gosub") || c == "script" || c == "finish" {
			info.known = false
			break
		}
		next := p.graphs[doc].targets(line)
		if len(next) == 0 {
			break
		}
		if len(next) != 1 {
			info.known = false
			break
		}
		line = next[0]
	}
	p.parameters[target] = info
	return info
}
func (p *Project) argumentNeedsConstant(target uint64, index int) bool {
	if p.allConstants {
		return true
	}
	info := p.callParameters(target)
	if !info.known {
		return true
	}
	if index < len(info.names) && p.constantNames[info.names[index]] {
		return true
	}
	return p.constantNames[p.names.name(fmt.Sprintf("param_%d", index+1))]
}
func expressionNames(d *Document, id uint32) []uint32 {
	var result []uint32
	var visit func(uint32)
	visit = func(id uint32) {
		if id == 0 {
			return
		}
		e := d.Exprs[id]
		switch e.Kind {
		case exVariable:
			result = append(result, e.Arg)
		case exIndirect:
			visit(e.A)
		case exBinary:
			visit(e.A)
			visit(e.B)
		case exArray:
			result = append(result, e.Arg)
			fallthrough
		case exCall:
			for _, id := range d.Args[e.A : e.A+e.B] {
				visit(id)
			}
		}
	}
	visit(id)
	return result
}
