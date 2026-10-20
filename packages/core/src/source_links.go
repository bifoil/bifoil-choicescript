package core

// Tree links point forward. Relative offsets retain their exact values while
// exposing repeated paragraph patterns to the existing immutable block encoder.
// Irregular tables remain dense when encoding would not save storage.
func packLinks(values []uint32) ([]uint32, *numericMetrics) {
	if len(values) <= metricPackingThreshold {
		return values, nil
	}
	for i, value := range values {
		if value != 0 && value <= uint32(i) {
			return values, nil
		}
	}
	for i, value := range values {
		if value != 0 {
			values[i] = value - uint32(i)
		}
	}
	packed := packNumericMetrics(values)
	bytes := len(packed.blocks) * 40
	for _, block := range packed.blocks {
		bytes += len(block.values) * 4
	}
	if bytes < len(values)*3 {
		return nil, packed
	}
	for i, value := range values {
		if value != 0 {
			values[i] = value + uint32(i)
		}
	}
	return values, nil
}
func (s *sourceRows) packLinks() {
	if s.firstMetrics == nil {
		s.first, s.firstMetrics = packLinks(s.first)
	}
	if s.nextMetrics == nil {
		s.next, s.nextMetrics = packLinks(s.next)
	}
}
func (s *sourceRows) firstAt(index int) uint32 {
	if s.firstMetrics == nil {
		return s.first[index]
	}
	value := s.firstMetrics.at(uint32(index))
	if value != 0 {
		return value + uint32(index)
	}
	return 0
}
func (s *sourceRows) nextAt(index int) uint32 {
	if s.nextMetrics == nil {
		return s.next[index]
	}
	value := s.nextMetrics.at(uint32(index))
	if value != 0 {
		return value + uint32(index)
	}
	return 0
}
