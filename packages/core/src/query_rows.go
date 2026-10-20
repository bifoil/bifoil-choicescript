package core

// Query rows retain the fields used by editor features after full analysis.
// Expression/graph construction fields are absent; every physical row remains.
// A final sentinel supplies each row's lexical-token end without a count field.
type queryRow struct {
	Parent, Command, Indent, Body, SyntaxStart uint32
	Kind, Flags                                uint8
}

func (d *Document) node(line uint32) row {
	if d.hasSourceRows() {
		return d.rowAt(int(line))
	}
	q := d.QueryRows[line]
	n := row{Parent: q.Parent, Command: q.Command, Indent: q.Indent, TokenStart: q.SyntaxStart, TokenCount: d.QueryRows[line+1].SyntaxStart - q.SyntaxStart, Kind: q.Kind, Flags: q.Flags, Inline: noOffset}
	switch q.Kind {
	case prose:
		n.IndentBytes = q.Body
	case option:
		if q.Body > 0 {
			n.IndentBytes = q.Body - 1
		}
	default:
		if q.Body > 0 {
			n.Inline = q.Body
		}
	}
	return n
}
func (d *Document) compactQueryRows() {
	if !d.hasSourceRows() {
		return
	}
	rows := make([]queryRow, 0)
	if d.rowData != nil {
		if d.rowData.shared() {
			rows = make([]queryRow, d.RowCount()+1)
		} else {
			d.rowData.materializeNodes()
			rows = d.rowData.nodes
		}
	} else {
		rows = make([]queryRow, d.RowCount()+1)
	}
	var syntax []Token
	for line := range d.RowCount() {
		if d.rowData != nil && line != 0 {
			q := d.rowData.node(line)
			if q.Flags&heavySourceRow == 0 {
				end := uint32(len(d.Syntax))
				if line+1 < d.RowCount() {
					end = d.rowData.node(line + 1).SyntaxStart
				}
				start := q.SyntaxStart
				q.SyntaxStart = uint32(len(syntax))
				if q.Kind == prose || q.Kind == option {
					if q.Kind == option {
						q.Body++
					}
					syntax = append(syntax, d.Syntax[start:end]...)
				} else {
					q.Body = 0
				}
				rows[line] = q
				continue
			}
		}
		n := d.rowAt(line)
		body := uint32(0)
		text := n.Kind == prose || n.Kind == option || n.Inline != noOffset
		if text {
			body = n.IndentBytes
			if n.Kind == option {
				body++
			}
			if n.Inline != noOffset {
				body = n.Inline
			}
		}
		rows[line] = queryRow{Parent: n.Parent, Command: n.Command, Indent: n.Indent, Body: body, SyntaxStart: uint32(len(syntax)), Kind: n.Kind, Flags: n.Flags}
		if text {
			syntax = append(syntax, d.Syntax[n.TokenStart:n.TokenStart+n.TokenCount]...)
		}
	}
	rows[d.RowCount()].SyntaxStart = uint32(len(syntax))
	d.QueryRows = rows
	d.Syntax = syntax
	d.Rows = nil
	if d.rowData != nil {
		d.rowData.releaseOwner()
	}
	d.rowData = nil
	d.Roots = nil
}
