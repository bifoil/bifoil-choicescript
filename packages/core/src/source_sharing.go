package core

import (
	"context"
	"runtime"
	"sync/atomic"
	"time"
)

const sourceRowPageSize = 256

type sourceRowPage [sourceRowPageSize]queryRow
type sourceRowShare struct{ owners atomic.Int32 }
type sourceRowRelease struct {
	share    *sourceRowShare
	released atomic.Bool
}
type sourceRowOwner struct {
	state   *sourceRowRelease
	cleanup runtime.Cleanup
}

func (s *sourceRowRelease) release() {
	if s.released.CompareAndSwap(false, true) {
		s.share.owners.Add(-1)
	}
}
func newSourceRowOwner(share *sourceRowShare) *sourceRowOwner {
	if share == nil {
		share = new(sourceRowShare)
	}
	share.owners.Add(1)
	owner := &sourceRowOwner{state: &sourceRowRelease{share: share}}
	owner.cleanup = runtime.AddCleanup(owner, func(state *sourceRowRelease) { state.release() }, owner.state)
	return owner
}
func (s *sourceRows) releaseOwner() {
	if s.owner != nil {
		s.owner.state.release()
		s.owner.cleanup.Stop()
		s.owner = nil
	}
}
func (s *sourceRows) shared() bool { return s.owner != nil && s.owner.state.share.owners.Load() > 1 }
func (s *sourceRows) node(index int) queryRow {
	if s.pages != nil {
		if page := s.pages[index/sourceRowPageSize]; page != nil {
			return page[index%sourceRowPageSize]
		}
	}
	return s.nodes[index]
}
func (s *sourceRows) mutableNode(index int) *queryRow {
	if !s.frozen {
		return &s.nodes[index]
	}
	shared := s.shared()
	if s.pages == nil && !shared {
		return &s.nodes[index]
	}
	if s.pages == nil {
		s.pages = make([]*sourceRowPage, (len(s.nodes)+sourceRowPageSize-1)/sourceRowPageSize)
	}
	pageIndex := index / sourceRowPageSize
	page := s.pages[pageIndex]
	if page == nil {
		if !shared {
			return &s.nodes[index]
		}
		page = new(sourceRowPage)
		start := pageIndex * sourceRowPageSize
		copy(page[:], s.nodes[start:min(start+sourceRowPageSize, len(s.nodes))])
		s.pages[pageIndex] = page
	}
	return &page[index%sourceRowPageSize]
}
func (s *sourceRows) putNode(index int, value queryRow) {
	if !s.frozen {
		s.nodes[index] = value
		return
	}
	if s.node(index) != value {
		*s.mutableNode(index) = value
	}
}
func (s *sourceRows) mutableLinks() {
	firstPacked, nextPacked := s.firstMetrics != nil, s.nextMetrics != nil
	if firstPacked {
		values := make([]uint32, len(s.nodes)-1)
		for i := range values {
			values[i] = s.firstAt(i)
		}
		s.first = values
		s.firstMetrics = nil
	}
	if nextPacked {
		values := make([]uint32, len(s.nodes)-1)
		for i := range values {
			values[i] = s.nextAt(i)
		}
		s.next = values
		s.nextMetrics = nil
	}
	if s.linksShared {
		if !firstPacked {
			s.first = append([]uint32(nil), s.first...)
		}
		if !nextPacked {
			s.next = append([]uint32(nil), s.next...)
		}
		s.linksShared = false
	}
}
func (s *sourceRows) materializeNodes() {
	if s.shared() {
		nodes := make([]queryRow, len(s.nodes))
		for index := range nodes {
			nodes[index] = s.node(index)
		}
		s.releaseOwner()
		s.nodes = nodes
		s.owner = newSourceRowOwner(nil)
	} else if s.pages != nil {
		for index, page := range s.pages {
			if page != nil {
				start := index * sourceRowPageSize
				copy(s.nodes[start:min(start+sourceRowPageSize, len(s.nodes))], page[:])
			}
		}
	}
	s.pages = nil
}

// TransferCopyBytes estimates the arrays that canonical ID remapping and quote
// proofs may change. It selects cache scheduling, never semantic coverage. RSS
// acceptance still measures every owned process rather than trusting this bound.
func (p *ParsedSource) TransferCopyBytes() uint64 {
	d := p.document
	bytes := uint64(len(d.Rows))*76 + uint64(len(d.Exprs))*16 + uint64(len(d.Syntax))*24 + uint64(len(d.TokenName))*64
	if storage := d.rowData; storage != nil {
		bytes += uint64(len(storage.heavy))*76 + uint64((len(storage.nodes)+sourceRowPageSize-1)/sourceRowPageSize)*8
		previous := -1
		for _, line := range d.semanticRows() {
			page := int(line) / sourceRowPageSize
			if page != previous {
				bytes += sourceRowPageSize * 24
				previous = page
			}
		}
		for _, page := range storage.pages {
			if page != nil {
				bytes += sourceRowPageSize * 24
			}
		}
	}
	return 2 * bytes
}

// Discard consumes a detached parse after its owner has serialized it. Shared
// immutable pages remain alive in transferred projects until their final use.
func (p *ParsedSource) Discard() {
	if p.document != nil && p.document.rowData != nil {
		p.document.rowData.releaseOwner()
	}
	p.document = nil
	p.names = registry{}
	p.values = valuePool{}
}

// Waiting before a large query-table conversion prevents two full line tables
// from overlapping. The cache already writes concurrently with complete analysis;
// cancellation abandons obsolete work rather than publishing a partial index.
func (p *Project) WaitForLargeSourceTransfers(ctx context.Context) error {
	for {
		waiting := false
		for _, d := range p.Documents {
			if s := d.rowData; s != nil && len(s.nodes)*24 > 8*1024*1024 && s.shared() {
				waiting = true
				break
			}
		}
		if !waiting {
			return ctx.Err()
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(time.Millisecond):
		}
	}
}
