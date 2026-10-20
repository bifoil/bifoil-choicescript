package core

const compactRowThreshold = 1024
const heavySourceRow uint8 = 128

// Every physical line retains its tree links, indentation, kind and lexical
// range. Only command/metadata rows allocate expression and argument fields.
// Byte offsets of discarded prose are unnecessary: its exact UTF-16 extent is
// retained in Widths, and host snapshots own the original immutable source bytes.
type sourceRows struct {
	owner                     *sourceRowOwner
	pages                     []*sourceRowPage
	linksShared               bool
	frozen                    bool
	nodes                     []queryRow
	first, next               []uint32
	firstMetrics, nextMetrics *numericMetrics
	heavy                     []row
}

// RowCount includes the dummy row zero; physical source lines start at row one.
func (d *Document) RowCount() int {
	if d.rowData != nil {
		return len(d.rowData.nodes) - 1
	}
	return len(d.Rows)
}
func (d *Document) hasSourceRows() bool { return d.Rows != nil || d.rowData != nil }
func (d *Document) rowAt(index int) row {
	if d.rowData == nil {
		return d.Rows[index]
	}
	if index == 0 {
		return row{}
	}
	storage := d.rowData
	q := storage.node(index)
	if q.Flags&heavySourceRow != 0 {
		r := storage.heavy[q.Body]
		r.Parent = q.Parent
		r.FirstChild = storage.firstAt(index)
		r.NextSibling = storage.nextAt(index)
		return r
	}
	end := uint32(len(d.Syntax))
	if index+1 < len(storage.nodes)-1 {
		end = storage.node(index + 1).SyntaxStart
	}
	return row{Parent: q.Parent, FirstChild: storage.firstAt(index), NextSibling: storage.nextAt(index), Indent: q.Indent, IndentBytes: q.Body, Arg: q.Body, Command: q.Command, TokenStart: q.SyntaxStart, TokenCount: end - q.SyntaxStart, Kind: q.Kind, Flags: q.Flags, Inline: noOffset}
}

// Rendering needs exact lexical fields but never child/sibling links. Keep those
// links compressed until a tree/graph consumer asks for them; reconstructing two
// unrelated metrics for every prose span adds work proportional to physical rows.
func (d *Document) lexicalRow(index int) row {
	if d.rowData == nil {
		return d.Rows[index]
	}
	if index == 0 {
		return row{}
	}
	storage := d.rowData
	q := storage.node(index)
	if q.Flags&heavySourceRow != 0 {
		r := storage.heavy[q.Body]
		r.Parent = q.Parent
		r.FirstChild, r.NextSibling = 0, 0
		return r
	}
	end := uint32(len(d.Syntax))
	if index+1 < len(storage.nodes)-1 {
		end = storage.node(index + 1).SyntaxStart
	}
	return row{Parent: q.Parent, Indent: q.Indent, IndentBytes: q.Body, Arg: q.Body, Command: q.Command, TokenStart: q.SyntaxStart, TokenCount: end - q.SyntaxStart, Kind: q.Kind, Flags: q.Flags, Inline: noOffset}
}
func (d *Document) mutableRow(index int) *row {
	if d.rowData == nil {
		return &d.Rows[index]
	}
	storage := d.rowData
	q := storage.mutableNode(index)
	if q.Flags&heavySourceRow == 0 {
		value := d.rowAt(index)
		id := uint32(len(storage.heavy))
		storage.heavy = append(storage.heavy, value)
		q.Body = id
		q.Flags |= heavySourceRow
	}
	return &storage.heavy[q.Body]
}
func (d *Document) setRow(index int, value row) {
	if d.rowData == nil {
		d.Rows[index] = value
		return
	}
	storage := d.rowData
	q := queryRow{Parent: value.Parent, Command: value.Command, Indent: value.Indent, Body: value.IndentBytes, SyntaxStart: value.TokenStart, Kind: value.Kind, Flags: value.Flags}
	needsHeavy := value.Kind == command || value.Kind == comment || value.Kind == metadata || value.Expr != 0 || value.TargetExpr != 0 || value.Target != 0 || value.ExprCount != 0 || index != 0 && value.Inline != noOffset
	if needsHeavy {
		previous := storage.node(index)
		if previous.Flags&heavySourceRow != 0 {
			q.Body = previous.Body
			// Heavy records own their canonical command ID. Keeping the immutable
			// header ID avoids copying a page solely for namespace remapping.
			if storage.frozen {
				q.Command = previous.Command
			}
			storage.heavy[q.Body] = value
		} else {
			q.Body = uint32(len(storage.heavy))
			storage.heavy = append(storage.heavy, value)
		}
		q.Flags |= heavySourceRow
	}
	storage.putNode(index, q)
	d.setFirstChild(index, value.FirstChild)
	d.setNextSibling(index, value.NextSibling)
}
func (d *Document) appendRow(value row) {
	if d.rowData == nil && !d.keepDenseRows && len(d.Rows) >= compactRowThreshold {
		d.packSourceRows()
	}
	if d.rowData == nil {
		d.Rows = append(d.Rows, value)
		return
	}
	index := d.RowCount()
	if d.rowData.frozen {
		d.rowData.materializeNodes()
		d.rowData.mutableLinks()
	}
	d.rowData.nodes = append(d.rowData.nodes, queryRow{})
	d.rowData.first = append(d.rowData.first, 0)
	d.rowData.next = append(d.rowData.next, 0)
	if value.Kind == blank || value.Kind == prose || value.Kind == option {
		d.rowData.nodes[index] = queryRow{Parent: value.Parent, Command: value.Command, Indent: value.Indent, Body: value.IndentBytes, SyntaxStart: value.TokenStart, Kind: value.Kind, Flags: value.Flags}
		d.rowData.first[index], d.rowData.next[index] = value.FirstChild, value.NextSibling
	} else {
		d.setRow(index, value)
	}
}
func (d *Document) packSourceRows() {
	if d.rowData != nil {
		return
	}
	previous := d.Rows
	d.rowData = &sourceRows{nodes: make([]queryRow, len(previous)+1, max(len(previous)+1, d.rowCapacity+1)), first: make([]uint32, len(previous), max(len(previous), d.rowCapacity)), next: make([]uint32, len(previous), max(len(previous), d.rowCapacity)), heavy: make([]row, 1), owner: newSourceRowOwner(nil)}
	for index, value := range previous {
		d.setRow(index, value)
	}
	d.Rows = nil
}
func (d *Document) initRows(count int) {
	d.rowData = nil
	if count <= compactRowThreshold || d.keepDenseRows {
		d.Rows = make([]row, count)
		return
	}
	d.Rows = nil
	d.rowData = &sourceRows{nodes: make([]queryRow, count+1), first: make([]uint32, count), next: make([]uint32, count), heavy: make([]row, 1), owner: newSourceRowOwner(nil)}
}
func (d *Document) setFirstChild(index int, value uint32) {
	if d.rowData != nil {
		if d.rowData.firstAt(index) == value {
			return
		}
		d.rowData.mutableLinks()
		d.rowData.first[index] = value
	} else {
		d.Rows[index].FirstChild = value
	}
}
func (d *Document) setNextSibling(index int, value uint32) {
	if d.rowData != nil {
		if d.rowData.nextAt(index) == value {
			return
		}
		d.rowData.mutableLinks()
		d.rowData.next[index] = value
	} else {
		d.Rows[index].NextSibling = value
	}
}
func (d *Document) setTokenCount(index int, value uint32) {
	if d.rowData == nil {
		d.Rows[index].TokenCount = value
		return
	}
	q := d.rowData.node(index)
	if q.Flags&heavySourceRow != 0 {
		d.rowData.heavy[q.Body].TokenCount = value
	}
}
func (d *Document) cloneSourceRows() {
	if d.rowData == nil {
		return
	}
	original := d.rowData
	if original.owner == nil {
		original.owner = newSourceRowOwner(nil)
	}
	original.frozen = true
	copied := *original
	copied.owner = newSourceRowOwner(original.owner.state.share)
	original.linksShared = true
	copied.linksShared = true
	copied.heavy = append([]row(nil), original.heavy...)
	if original.pages != nil {
		copied.pages = append([]*sourceRowPage(nil), original.pages...)
		for index, page := range copied.pages {
			if page != nil {
				copy := *page
				copied.pages[index] = &copy
			}
		}
	}
	d.rowData = &copied
}

// Query compaction only mutates the line table. A non-consuming snapshot writer
// clones that table while sharing the remaining immutable source fields.
func (d *Document) cloneQueryLineTable() {
	if d.rowData != nil {
		original := d.rowData
		copy := *original
		copy.nodes = make([]queryRow, len(original.nodes))
		for index := range copy.nodes {
			copy.nodes[index] = original.node(index)
		}
		copy.pages = nil
		copy.owner = nil
		copy.linksShared = true
		d.rowData = &copy
	}
}

// semanticRows indexes every row with syntax or command/expression metadata.
// Narrative-only rows still take part in the graph, quote transfers and rendering;
// this index serves passes whose inputs are exclusively code and reference facts.
// It is immutable after parsing and rebuilt from complete rows on cache reads.
func (d *Document) semanticRows() []uint32 {
	if d.semanticRowIndex != nil {
		return d.semanticRowIndex
	}
	d.semanticRowIndex = make([]uint32, 0)
	for line := 1; line < d.RowCount(); line++ {
		if d.rowData != nil {
			q := d.rowData.node(line)
			end := uint32(len(d.Syntax))
			if line+1 < d.RowCount() {
				end = d.rowData.node(line + 1).SyntaxStart
			}
			if q.Flags&heavySourceRow == 0 && q.SyntaxStart == end {
				continue
			}
		} else {
			n := d.Rows[line]
			if n.Kind != command && n.Kind != comment && n.Kind != metadata && n.TokenCount == 0 && n.Expr == 0 && n.TargetExpr == 0 && n.Target == 0 && n.ExprCount == 0 && n.Inline == noOffset {
				continue
			}
		}
		d.semanticRowIndex = append(d.semanticRowIndex, uint32(line))
	}
	return d.semanticRowIndex
}

// Small row predicates avoid copying the full command record in prose loops.
func (d *Document) rowKind(index uint32) uint8 {
	if d.rowData == nil {
		return d.Rows[index].Kind
	}
	q := d.rowData.node(int(index))
	return q.Kind
}
func (d *Document) rowFlags(index uint32) uint8 {
	if d.rowData == nil {
		return d.Rows[index].Flags
	}
	q := d.rowData.node(int(index))
	return q.Flags &^ heavySourceRow
}
func (d *Document) rowCommand(index uint32) uint32 {
	if d.rowData == nil {
		return d.Rows[index].Command
	}
	q := d.rowData.node(int(index))
	if q.Flags&heavySourceRow != 0 {
		return d.rowData.heavy[q.Body].Command
	}
	return q.Command
}
func (d *Document) rowIndent(index uint32) uint32 {
	if d.rowData == nil {
		return d.Rows[index].Indent
	}
	return d.rowData.node(int(index)).Indent
}
func (d *Document) rowHasSyntax(index uint32) bool {
	if d.rowData == nil {
		return d.Rows[index].TokenCount != 0
	}
	q := d.rowData.node(int(index))
	if q.Flags&heavySourceRow != 0 {
		return d.rowData.heavy[q.Body].TokenCount != 0
	}
	end := uint32(len(d.Syntax))
	if int(index)+1 < d.RowCount() {
		end = d.rowData.node(int(index + 1)).SyntaxStart
	}
	return q.SyntaxStart != end
}

func (d *Document) rowFirstChild(index uint32) uint32 {
	if d.rowData == nil {
		return d.Rows[index].FirstChild
	}
	return d.rowData.firstAt(int(index))
}
func (d *Document) rowNextSibling(index uint32) uint32 {
	if d.rowData == nil {
		return d.Rows[index].NextSibling
	}
	return d.rowData.nextAt(int(index))
}

// Parsing marks text after recovering its expressions. Updating only this flag
// avoids reconstructing and rewriting command fields on every narrative row.
func (d *Document) markPureText(index uint32) {
	if d.rowData == nil {
		d.Rows[index].Flags |= 1
		return
	}
	d.rowData.mutableNode(int(index)).Flags |= 1
}

// Consumers which need both fields share one immutable header read. Tree links
// and expression arenas remain separate and retain their complete information.
func (d *Document) rowClass(index uint32) (kind, flags uint8) {
	if d.rowData == nil {
		return d.Rows[index].Kind, d.Rows[index].Flags
	}
	header := d.rowData.node(int(index))
	return header.Kind, header.Flags &^ heavySourceRow
}
