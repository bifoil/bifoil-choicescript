package core

// A scene change erases local gosub frames. An ordinary goto_scene also clears
// the global gosub_scene stack. finish can enter the next scene either directly
// or through its page button; the pinned engine preserves the global frame in
// the latter path. Keep both possible global continuations without ever reviving
// an erased local return frame.
func (p *Project) finishFrames(context uint32) []uint32 {
	if result, ok := p.finishFrameCache[context]; ok {
		return result
	}
	pending := []uint32{context}
	seen := make(map[uint32]bool)
	frames := map[uint32]bool{p.rootForContext[context]: true}
	for len(pending) > 0 {
		current := pending[len(pending)-1]
		pending = pending[:len(pending)-1]
		if seen[current] {
			continue
		}
		seen[current] = true
		for _, caller := range p.waiting[current] {
			if caller.restore {
				frames[current] = true
			} else {
				pending = append(pending, caller.site.context)
			}
		}
	}
	result := make([]uint32, 0, len(frames))
	for frame := range frames {
		result = append(result, frame)
	}
	p.finishFrameCache[context] = result
	return result
}
func (p *Project) propagateFinish(contextID, doc uint32, state flowState) {
	state.paragraph = true
	for index, scene := range p.ordered {
		if scene == doc && index+1 < len(p.ordered) {
			target := p.ordered[index+1]
			state.env = p.arena.normalize(p.arena.dropClass(state.env, 3, 0))
			for _, context := range p.finishFrames(contextID) {
				p.schedule(context, nodeID(target, p.graphs[target].entry), state)
			}
			return
		}
	}
	p.complete(p.rootForContext[contextID], state)
}
func (p *Project) refreshSceneFrames() {
	p.refreshFinishes = false
	clear(p.finishFrameCache)
	for id, state := range p.finishedScenes {
		p.propagateFinish(uint32(id), uint32(id>>32), state)
	}
}
