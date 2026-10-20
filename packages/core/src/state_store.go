package core

// Sparse numeric pages avoid hashing the same scene/row/context tuple for every
// transfer and queue flag. Only visited scene/context combinations allocate data.
// A zero quote mask is the absent-state sentinel; valid states use masks 1..7.
type statePage struct {
	values  [256]flowState
	pending [4]uint64
}
type stateDocument struct{ pages []*statePage }
type stateStore struct {
	documents map[uint64]*stateDocument
	lastID    uint64
	last      *stateDocument
	count     int
}

func (s *stateStore) page(key stateKey, create bool) (*statePage, uint32) {
	document := uint64(key.context)<<32 | key.node>>32
	d := s.last
	if d == nil || s.lastID != document {
		d = s.documents[document]
		if d == nil && create {
			d = new(stateDocument)
			if s.documents == nil {
				s.documents = make(map[uint64]*stateDocument)
			}
			s.documents[document] = d
		}
		s.lastID = document
		s.last = d
	}
	line := uint32(key.node)
	offset := line & 255
	if d == nil {
		return nil, offset
	}
	index := int(line >> 8)
	if index >= len(d.pages) {
		if !create {
			return nil, offset
		}
		if index >= cap(d.pages) {
			next := make([]*statePage, index+1, max(index+1, max(4, cap(d.pages)*2)))
			copy(next, d.pages)
			d.pages = next
		} else {
			d.pages = d.pages[:index+1]
		}
	}
	p := d.pages[index]
	if p == nil && create {
		p = new(statePage)
		d.pages[index] = p
	}
	return p, offset
}
func (s *stateStore) get(key stateKey) flowState {
	p, i := s.page(key, false)
	if p == nil {
		return flowState{}
	}
	return p.values[i]
}
func (s *stateStore) set(key stateKey, value flowState) {
	p, i := s.page(key, true)
	if p.values[i].quote == 0 && value.quote != 0 {
		s.count++
	}
	if p.values[i].quote != 0 && value.quote == 0 {
		s.count--
	}
	p.values[i] = value
}
func (s *stateStore) remove(key stateKey) {
	p, i := s.page(key, false)
	if p != nil && p.values[i].quote != 0 {
		p.values[i] = flowState{}
		s.count--
	}
}
func (s *stateStore) isPending(key stateKey) bool {
	p, i := s.page(key, false)
	return p != nil && p.pending[i>>6]&(uint64(1)<<(i&63)) != 0
}
func (s *stateStore) setPending(key stateKey, value bool) {
	p, i := s.page(key, value)
	if p == nil {
		return
	}
	bit := uint64(1) << (i & 63)
	if value {
		p.pending[i>>6] |= bit
	} else {
		p.pending[i>>6] &^= bit
	}
}
func (s *stateStore) each(visit func(flowState)) {
	for _, d := range s.documents {
		for _, p := range d.pages {
			if p != nil {
				for _, state := range p.values {
					if state.quote != 0 {
						visit(state)
					}
				}
			}
		}
	}
}
func (s *stateStore) reset() { *s = stateStore{} }
