package core

import "errors"

func (w *snapshotOutput) metrics(dense []uint32, packed *numericMetrics) {
	if packed == nil {
		w.u(0)
		w.uints(dense)
		return
	}
	w.u(1)
	w.u(uint64(packed.count))
	w.u(uint64(len(packed.blocks)))
	for _, block := range packed.blocks {
		w.u(uint64(block.period))
		w.uints(block.values)
	}
}
func (r *snapshotInput) metrics() ([]uint32, *numericMetrics) {
	mode := r.u()
	if mode == 0 {
		return r.uints(), nil
	}
	if mode != 1 {
		r.err = errors.New("invalid numeric metric encoding")
		return nil, nil
	}
	count := int(r.u32())
	blocks := r.count(3)
	if r.err != nil {
		return nil, nil
	}
	if blocks != (count+metricBlockSize-1)/metricBlockSize {
		r.err = errors.New("invalid numeric metric block count")
		return nil, nil
	}
	metrics := &numericMetrics{count: count, blocks: make([]metricBlock, blocks)}
	for index := range metrics.blocks {
		period := r.u32()
		values := r.uints()
		rows := min(metricBlockSize, count-index*metricBlockSize)
		if period > 16 || period != 0 && (int(period) > rows || len(values) != int(period)) || period == 0 && len(values) != rows {
			r.err = errors.New("invalid numeric metric block")
			return nil, nil
		}
		block := metricBlock{period: uint16(period), count: uint16(rows), values: values}
		if period == 0 {
			for _, value := range values {
				block.total += uint64(value)
			}
		} else {
			var cycle uint64
			for _, value := range values {
				cycle += uint64(value)
			}
			block.total = uint64(rows/int(period)) * cycle
			for _, value := range values[:rows%int(period)] {
				block.total += uint64(value)
			}
		}
		metrics.blocks[index] = block
		metrics.total += block.total
	}
	return nil, metrics
}
