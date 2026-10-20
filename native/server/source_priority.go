package main

import "sync"

// A large standard LSP frame is already delivering its immutable editor source.
// Keep valid disk work running while source bytes arrive. Only a validated
// notification can invalidate that snapshot; malformed input cannot cancel it.
// Malformed frames release the lease too; they never become project snapshots.
func (s *nativeServer) beginSourceRead() func() {
	s.mu.Lock()
	s.receivingSources++
	s.signalLocked()
	s.mu.Unlock()
	var once sync.Once
	return func() { once.Do(func() { s.mu.Lock(); s.receivingSources--; s.signalLocked(); s.mu.Unlock() }) }
}
func (m *rpcMessage) finishSourceRead() {
	if m.sourceReadDone != nil {
		m.sourceReadDone()
		m.sourceReadDone = nil
	}
}
