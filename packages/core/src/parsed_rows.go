package core

import (
	"encoding/binary"
	"errors"
	"io"
	"math/bits"
)

// Large source tables already have a compact numeric representation. Write it
// directly in bounded fixed-width pages rather than reconstructing every full
// command record. This cache retains every row and link; it contains no reduced
// semantic analysis. All integers have an explicit little-endian encoding.
func (w *snapshotOutput) parsedRows(d *Document) {
	if d.rowData == nil {
		w.u(0)
		w.u(uint64(d.RowCount()))
		var previous [20]uint32
		for _, r := range d.Rows {
			fields := rowFields(r)
			var mask uint32
			for i, value := range fields {
				if value != previous[i] {
					mask |= 1 << i
				}
			}
			w.u(uint64(mask))
			for mask != 0 {
				i := bits.TrailingZeros32(mask)
				w.u(uint64(fields[i]))
				mask &= mask - 1
			}
			previous = fields
		}
		return
	}
	w.u(2)
	w.u(uint64(d.RowCount()))
	s := d.rowData
	var block [metricBlockSize]queryRow
	for start := 0; start < d.RowCount(); start += metricBlockSize {
		count := min(metricBlockSize, d.RowCount()-start)
		rows := block[:count]
		if s.pages == nil {
			copy(rows, s.nodes[start:start+count])
		} else {
			for i := range rows {
				rows[i] = s.node(start + i)
			}
		}
		// A blank paragraph row often belongs to the immediately preceding prose.
		// Encode that backward distance so exact repeated paragraphs stay periodic.
		for i := range rows {
			if rows[i].Parent != 0 {
				if rows[i].Parent >= uint32(start+i) {
					w.err = errors.New("invalid source parent")
					return
				}
				rows[i].Parent = uint32(start+i) - rows[i].Parent
			}
		}
		period := sourceNodePeriod(rows)
		w.u(uint64(period))
		if period != 0 {
			rows = rows[:period]
		}
		for _, q := range rows {
			w.sourceNode(q)
		}
	}
	w.metrics(s.first, s.firstMetrics)
	w.metrics(s.next, s.nextMetrics)
	w.u(uint64(len(s.heavy)))
	for _, r := range s.heavy {
		if cap(w.buffer)-len(w.buffer) < 80 {
			w.flush()
		}
		for _, value := range rowFields(r) {
			w.buffer = binary.LittleEndian.AppendUint32(w.buffer, value)
		}
	}
}

func (r *snapshotInput) fixedRecords(count, stride int, consume func(int, []byte) error) error {
	buffer := make([]byte, min(count, 65536/stride)*stride)
	for first := 0; first < count; {
		size := min(len(buffer)/stride, count-first)
		data := buffer[:size*stride]
		if _, err := io.ReadFull(r, data); err != nil {
			return err
		}
		for index := range size {
			if err := consume(first+index, data[index*stride:(index+1)*stride]); err != nil {
				return err
			}
		}
		first += size
	}
	return r.err
}
func (r *snapshotInput) parsedRows(d *Document) error {
	mode := r.u()
	if mode == 0 {
		d.initRows(r.count(1))
		var fields [20]uint32
		for i := range d.RowCount() {
			mask := r.u32()
			if mask>>20 != 0 {
				return errors.New("invalid syntax row field mask")
			}
			for mask != 0 {
				index := bits.TrailingZeros32(mask)
				fields[index] = r.u32()
				mask &= mask - 1
			}
			if fields[18] > 255 || fields[19] > 255 {
				return errors.New("syntax row byte overflow")
			}
			d.setRow(i, rowFromFields(fields))
		}
		return r.err
	}
	if mode != 2 {
		return errors.New("invalid source row encoding")
	}
	count64 := r.u()
	// This is an optional local cache. Reject corrupt expansion before allocating;
	// the host reparses original bytes on a miss rather than reducing coverage.
	if r.err != nil {
		return r.err
	}
	if count64 < compactRowThreshold || count64 > 128*1024*1024/24 || r.known && (r.consumed > r.total || (count64+metricBlockSize-1)/metricBlockSize > (r.total-r.consumed)/25) {
		return errors.New("invalid compact source row count")
	}
	count := int(count64)
	s := &sourceRows{nodes: make([]queryRow, count+1), owner: newSourceRowOwner(nil)}
	d.Rows, d.rowData = nil, s
	for start := 0; start < count; start += metricBlockSize {
		size := min(metricBlockSize, count-start)
		period := r.u32()
		if period > 16 || int(period) > size {
			return errors.New("invalid source row period")
		}
		encoded := size
		if period != 0 {
			encoded = int(period)
		}
		err := r.fixedRecords(encoded, 24, func(i int, data []byte) error {
			flags := binary.LittleEndian.Uint32(data[20:])
			if flags>>16 != 0 {
				return errors.New("invalid compact source row flags")
			}
			s.nodes[start+i] = queryRow{Parent: binary.LittleEndian.Uint32(data), Command: binary.LittleEndian.Uint32(data[4:]), Indent: binary.LittleEndian.Uint32(data[8:]), Body: binary.LittleEndian.Uint32(data[12:]), SyntaxStart: binary.LittleEndian.Uint32(data[16:]), Kind: uint8(flags), Flags: uint8(flags >> 8)}
			return nil
		})
		if err != nil {
			return err
		}
		for copied := encoded; copied < size; {
			n := copy(s.nodes[start+copied:start+size], s.nodes[start:start+copied])
			copied += n
		}
	}
	for i := range s.nodes[:count] {
		if delta := s.nodes[i].Parent; delta != 0 {
			if delta >= uint32(i) {
				return errors.New("invalid relative source parent")
			}
			s.nodes[i].Parent = uint32(i) - delta
		}
	}
	s.first, s.firstMetrics = r.metrics()
	s.next, s.nextMetrics = r.metrics()
	if r.err != nil {
		return r.err
	}
	linkCount := func(dense []uint32, packed *numericMetrics) int {
		if packed != nil {
			return packed.count
		}
		return len(dense)
	}
	if linkCount(s.first, s.firstMetrics) != count || linkCount(s.next, s.nextMetrics) != count {
		return errors.New("invalid source link count")
	}
	heavy := r.count(80)
	if r.err != nil {
		return r.err
	}
	if heavy == 0 {
		return errors.New("missing compact source records")
	}
	s.heavy = make([]row, heavy)
	err := r.fixedRecords(heavy, 80, func(i int, data []byte) error {
		var fields [20]uint32
		for j := range fields {
			fields[j] = binary.LittleEndian.Uint32(data[j*4:])
		}
		if fields[18] > 255 || fields[19] > 255 {
			return errors.New("syntax row byte overflow")
		}
		s.heavy[i] = rowFromFields(fields)
		return nil
	})
	if err != nil {
		return err
	}
	for _, q := range s.nodes[:count] {
		if q.Flags&heavySourceRow != 0 && int(q.Body) >= heavy {
			return errors.New("invalid compact source record")
		}
	}
	return nil
}

// Repetition is exact within a bounded block; irregular source keeps every row.
func sourceNodePeriod(rows []queryRow) int {
	for period := 1; period <= min(16, len(rows)); period++ {
		matches := true
		for i := period; i < len(rows); i++ {
			if rows[i] != rows[i%period] {
				matches = false
				break
			}
		}
		if matches {
			return period
		}
	}
	return 0
}
func (w *snapshotOutput) sourceNode(q queryRow) {
	if cap(w.buffer)-len(w.buffer) < 24 {
		w.flush()
	}
	w.buffer = binary.LittleEndian.AppendUint32(w.buffer, q.Parent)
	w.buffer = binary.LittleEndian.AppendUint32(w.buffer, q.Command)
	w.buffer = binary.LittleEndian.AppendUint32(w.buffer, q.Indent)
	w.buffer = binary.LittleEndian.AppendUint32(w.buffer, q.Body)
	w.buffer = binary.LittleEndian.AppendUint32(w.buffer, q.SyntaxStart)
	w.buffer = binary.LittleEndian.AppendUint32(w.buffer, uint32(q.Kind)|uint32(q.Flags)<<8)
}
