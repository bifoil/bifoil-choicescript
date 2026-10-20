package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"runtime"
)

type queryScopeKey struct{}
type queryScope struct{ releases []func() }

func (s *queryScope) close() {
	for _, release := range s.releases {
		release()
	}
	s.releases = nil
}

// Request leases include response encoding. A giant token response therefore
// cannot keep an evicted index alive while the next project is being allocated.
func (s *nativeServer) retainQueryLocked(ctx context.Context) {
	scope := ctx.Value(queryScopeKey{}).(*queryScope)
	if s.readersChanged == nil {
		s.readersChanged = make(chan struct{})
	}
	s.readers++
	scope.releases = append(scope.releases, func() {
		s.mu.Lock()
		defer s.mu.Unlock()
		s.readers--
		if s.readers == 0 {
			close(s.readersChanged)
			s.readersChanged = make(chan struct{})
		}
	})
}
func (s *nativeServer) waitForQueries() error {
	for {
		s.mu.Lock()
		if s.readers == 0 {
			s.mu.Unlock()
			return nil
		}
		changed := s.readersChanged
		s.mu.Unlock()
		select {
		case <-s.ctx.Done():
			return s.ctx.Err()
		case <-changed:
		}
	}
}

type currentSnapshotWriter struct {
	server      *nativeServer
	id          string
	revision    uint64
	destination io.Writer
}

func (w currentSnapshotWriter) Write(data []byte) (int, error) {
	if err := w.server.ctx.Err(); err != nil {
		return 0, err
	}
	w.server.mu.Lock()
	fresh := w.server.revisions[w.id] == w.revision
	w.server.mu.Unlock()
	if !fresh {
		return 0, context.Canceled
	}
	return w.destination.Write(data)
}

// Complete results are immediately available in the current immutable index.
// Only eviction needs a disk copy. One analysis owner persists and retires that
// index before loading another; neither typing nor hover waits for a cache write.
func (s *nativeServer) evictCurrent() error {
	for {
		if err := s.ctx.Err(); err != nil {
			return err
		}
		s.mu.Lock()
		p, id, revision := s.current, s.currentID, s.currentRevision
		if p == nil {
			s.mu.Unlock()
			return s.waitForQueries()
		}
		index := s.indexes[id]
		needsCopy := index.complete && index.revision == revision && index.cacheFile == ""
		s.mu.Unlock()
		filename := ""
		var err error
		if needsCopy {
			hash := sha256.Sum256([]byte(fmt.Sprintf("%s:%d", id, revision)))
			filename = filepath.Join(s.cacheDir, hex.EncodeToString(hash[:])+".gob")
			var file *os.File
			file, err = os.OpenFile(filename, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
			if err == nil {
				err = p.WriteSnapshot(currentSnapshotWriter{s, id, revision, file})
				if closeErr := file.Close(); err == nil {
					err = closeErr
				}
			}
		}
		s.mu.Lock()
		fresh := s.current == p && s.currentID == id && s.currentRevision == revision && s.revisions[id] == revision
		if err == nil && fresh {
			if needsCopy {
				index = s.indexes[id]
				index.cacheFile = filename
				s.indexes[id] = index
			}
			s.current = nil
			s.currentID = ""
			s.currentRevision = 0
		}
		s.mu.Unlock()
		p = nil
		if err != nil || !fresh {
			if filename != "" {
				_ = os.Remove(filename)
			}
		}
		if !fresh || errors.Is(err, context.Canceled) {
			continue
		}
		if err != nil {
			return fmt.Errorf("could not page the complete language index: %w", err)
		}
		if err = s.waitForQueries(); err != nil {
			return err
		}
		runtime.GC()
		return nil
	}
}
func (s *nativeServer) failPagingLocked(id string, err error) {
	index := s.indexes[id]
	index.complete = false
	index.failure = err.Error()
	s.indexes[id] = index
	s.signalLocked()
}
