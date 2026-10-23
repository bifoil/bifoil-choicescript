package core

// Immutable metric blocks retain every value. A short exact period compresses
// repeated paragraphs; nonrepeating blocks keep their complete numeric data.
const metricBlockSize = 256
const metricPackingThreshold = 65536

type metricBlock struct {
	values []uint32
	period uint16
	count  uint16
	total  uint64
}
type numericMetrics struct {
	blocks []metricBlock
	count  int
	total  uint64
}

func makeMetricBlock(values []uint32) metricBlock {
	block := metricBlock{count: uint16(len(values))}
	for _, value := range values {
		block.total += uint64(value)
	}
	for period := 1; period <= min(16, len(values)); period++ {
		matches := true
		for i := period; i < len(values); i++ {
			if values[i] != values[i%period] {
				matches = false
				break
			}
		}
		if matches {
			block.period = uint16(period)
			block.values = append([]uint32(nil), values[:period]...)
			return block
		}
	}
	block.values = append([]uint32(nil), values...)
	return block
}
func packNumericMetrics(values []uint32) *numericMetrics {
	metrics := &numericMetrics{count: len(values), blocks: make([]metricBlock, 0, (len(values)+metricBlockSize-1)/metricBlockSize)}
	common := make(map[[3]uint32][]uint32)
	for start := 0; start < len(values); start += metricBlockSize {
		block := makeMetricBlock(values[start:min(start+metricBlockSize, len(values))])
		if block.period > 0 && block.period <= 2 {
			key := [3]uint32{uint32(block.period), block.values[0]}
			if block.period == 2 {
				key[2] = block.values[1]
			}
			if prior, ok := common[key]; ok {
				block.values = prior
			} else if len(common) < 4096 {
				common[key] = block.values
			}
		}
		metrics.blocks = append(metrics.blocks, block)
		metrics.total += block.total
	}
	return metrics
}
func (m *numericMetrics) at(index uint32) uint32 {
	block := m.blocks[index/metricBlockSize]
	at := int(index % metricBlockSize)
	if block.period != 0 {
		at %= int(block.period)
	}
	return block.values[at]
}
func (m *numericMetrics) updated(index, value uint32) *numericMetrics {
	cloned := *m
	cloned.blocks = append([]metricBlock(nil), m.blocks...)
	blockIndex := index / metricBlockSize
	previous := m.blocks[blockIndex]
	values := make([]uint32, previous.count)
	for i := range values {
		values[i] = m.at(blockIndex*metricBlockSize + uint32(i))
	}
	values[index%metricBlockSize] = value
	block := makeMetricBlock(values)
	cloned.blocks[blockIndex] = block
	cloned.total = m.total - previous.total + block.total
	return &cloned
}
func (d *Document) packMetrics() {
	if len(d.Widths) > metricPackingThreshold && !d.keepDenseRows {
		d.widthMetrics = packNumericMetrics(d.Widths)
		d.Widths = nil
	}
	if len(d.WordCounts) > metricPackingThreshold && !d.keepDenseRows {
		d.wordMetrics = packNumericMetrics(d.WordCounts)
		d.WordCounts = nil
	}
}
func (d *Document) widthCount() int {
	if d.widthMetrics != nil {
		return d.widthMetrics.count
	}
	return len(d.Widths)
}
func (d *Document) wordCountLen() int {
	if d.wordMetrics != nil {
		return d.wordMetrics.count
	}
	return len(d.WordCounts)
}
func (d *Document) widthAt(index uint32) uint32 {
	if d.widthMetrics != nil {
		return d.widthMetrics.at(index)
	}
	return d.Widths[index]
}
func (d *Document) wordAt(index uint32) uint32 {
	if d.wordMetrics != nil {
		return d.wordMetrics.at(index)
	}
	return d.WordCounts[index]
}
func (d *Document) updateLineMetrics(index, width, words uint32) {
	if d.widthMetrics != nil {
		d.widthMetrics = d.widthMetrics.updated(index, width)
	} else {
		d.Widths = append([]uint32(nil), d.Widths...)
		d.Widths[index] = width
	}
	if d.wordMetrics != nil {
		d.wordMetrics = d.wordMetrics.updated(index, words)
	} else {
		d.WordCounts = append([]uint32(nil), d.WordCounts...)
		d.WordCounts[index] = words
	}
}

// LineCount excludes the internal dummy row; LineWidth uses UTF-16 columns.
func (d *Document) LineCount() int               { return max(0, d.widthCount()-1) }
func (d *Document) LineWidth(line uint32) uint32 { return d.widthAt(line + 1) }
