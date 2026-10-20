package main

import (
	"context"
	"encoding/json"
	"errors"
)

// The broker pipe has one writer. Foreground edits only update a coalesced set;
// cancellable requests wait on channels rather than a potentially blocked write.
func (p *toolProcess) write(ctx context.Context, value any) error {
	message := toolOutbound{ctx: ctx, value: value, written: make(chan error, 1)}
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-p.done:
		return p.stoppedError()
	case p.outgoing <- message:
	}
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-p.done:
		return p.stoppedError()
	case err := <-message.written:
		return err
	}
}
func (p *toolProcess) stoppedError() error {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.failure != nil {
		return p.failure
	}
	return errors.New("Game tooling stopped.")
}
func (p *toolProcess) writeLoop() {
	defer close(p.writerDone)
	encoder := json.NewEncoder(p.stream)
	for {
		var value any
		var message *toolOutbound
		select {
		case <-p.done:
			return
		case outbound := <-p.outgoing:
			message = &outbound
			if err := outbound.ctx.Err(); err != nil {
				outbound.written <- err
				continue
			}
			value = outbound.value
		case <-p.staleWake:
			p.mu.Lock()
			var id string
			for candidate := range p.dirtyProjects {
				id = candidate
				delete(p.dirtyProjects, candidate)
				break
			}
			more := len(p.dirtyProjects) > 0
			p.mu.Unlock()
			if more {
				select {
				case p.staleWake <- struct{}{}:
				default:
				}
			}
			if id == "" {
				continue
			}
			value = map[string]any{"method": "stale", "params": map[string]string{"projectId": id}}
		}
		err := encoder.Encode(value)
		if message != nil {
			message.written <- err
		}
		if err != nil {
			p.mu.Lock()
			if p.failure == nil {
				p.failure = err
			}
			p.mu.Unlock()
			_ = p.stream.Close()
			if p.owner != nil {
				_ = p.owner.Close()
			}
			return
		}
	}
}
