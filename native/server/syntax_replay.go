package main

import (
	"context"
	"crypto/sha256"
	"io"
	"maps"
	"slices"
	"strings"

	core "github.com/bifoil/bifoil-choicescript/packages/core/src"
)

const syntaxRecipeBudget = 4 * 1024 * 1024
const syntaxRecipeLineLimit = 64 * 1024

// Recipes retain only the original and newest form of each edited line. Their
// baseline is a completely written, SHA-256-addressed lexical snapshot. Replaying
// one never reuses semantic conclusions: the caller still runs full Analyze.
type syntaxRecipe struct {
	version int32
	base    [32]byte
	lines   map[uint32]core.SourceLineEdit
	bytes   int64
}

func (c *parseCache) forgetEdits(uri string) {
	if c == nil {
		return
	}
	c.directoryMu.Lock()
	c.replaceRecipeLocked(uri, syntaxRecipe{})
	c.directoryMu.Unlock()
}
func (c *parseCache) replaceRecipeLocked(uri string, next syntaxRecipe) {
	if previous, ok := c.pending[uri]; ok {
		c.recipeBytes -= previous.bytes
	}
	if len(next.lines) == 0 {
		delete(c.pending, uri)
		return
	}
	c.pending[uri] = next
	c.recipeBytes += next.bytes
}
func boundedRecipeLine(buffer openBuffer, line uint32) (string, bool) {
	if buffer.Store != nil {
		if int(line) >= len(buffer.Store.lines) {
			return "", false
		}
		start, end := buffer.Store.lines[line], buffer.Store.size
		if int(line)+1 < len(buffer.Store.lines) {
			end = buffer.Store.lines[line+1]
		}
		if end-start > syntaxRecipeLineLimit {
			return "", false
		}
	}
	text, ok := bufferLineText(buffer, line)
	return text, ok && len(text) <= syntaxRecipeLineLimit
}
func (c *parseCache) recordEdits(before, after openBuffer, changes []textChange) {
	if c == nil {
		return
	}
	if len(changes) != 1 || changes[0].Range == nil || changes[0].Store != nil || changes[0].Range.Start.Line != changes[0].Range.End.Line || strings.ContainsAny(changes[0].Text, "\r\n") {
		c.forgetEdits(before.URI)
		return
	}
	line := changes[0].Range.Start.Line
	oldText, oldOK := boundedRecipeLine(before, line)
	newText, newOK := boundedRecipeLine(after, line)
	if !oldOK || !newOK || !core.CanReuseSourceLine(oldText, newText) {
		c.forgetEdits(before.URI)
		return
	}
	// A small uncaptured buffer may have been opened over an identical disk parse.
	// Hashing it is bounded; large sources use the digest computed at capture time.
	var smallHash [32]byte
	smallKnown := before.Store == nil && len(before.Text) <= 1024*1024
	if smallKnown {
		smallHash = sha256.Sum256([]byte(before.Text))
	}
	c.directoryMu.Lock()
	defer c.directoryMu.Unlock()
	if c.disabled {
		return
	}
	previous, chained := c.pending[before.URI]
	chained = chained && previous.version == before.Version
	var base [32]byte
	switch {
	case chained:
		base = previous.base
	case before.Store != nil && before.Store.hasDigest:
		base = before.Store.digest
	case before.Store != nil:
		var known bool
		base, known = c.sourceDigests[before.Store.identity]
		if !known {
			c.replaceRecipeLocked(before.URI, syntaxRecipe{})
			return
		}
	case smallKnown:
		base = smallHash
	default:
		c.replaceRecipeLocked(before.URI, syntaxRecipe{})
		return
	}
	if _, found := c.entries[base]; !found {
		c.replaceRecipeLocked(before.URI, syntaxRecipe{})
		return
	}
	next := syntaxRecipe{version: after.Version, base: base, lines: make(map[uint32]core.SourceLineEdit)}
	if chained {
		maps.Copy(next.lines, previous.lines)
		next.bytes = previous.bytes
	}
	if edit, exists := next.lines[line]; exists {
		next.bytes -= int64(len(edit.Before) + len(edit.After) + 128)
		oldText = edit.Before
	}
	edit := core.SourceLineEdit{Before: strings.Clone(oldText), After: strings.Clone(newText)}
	next.lines[line] = edit
	next.bytes += int64(len(edit.Before) + len(edit.After) + 128)
	available := int64(syntaxRecipeBudget) - c.recipeBytes
	if old, ok := c.pending[before.URI]; ok {
		available += old.bytes
	}
	if next.bytes > available {
		c.replaceRecipeLocked(before.URI, syntaxRecipe{})
		return
	}
	c.replaceRecipeLocked(before.URI, next)
}
func (c *parseCache) replay(ctx context.Context, identity core.Source) (*core.ParsedSource, error) {
	c.directoryMu.RLock()
	recipe, found := c.pending[identity.URI]
	c.directoryMu.RUnlock()
	if !found || recipe.version != identity.Version {
		return nil, nil
	}
	parsed, err := c.find(ctx, recipe.base, identity)
	if parsed == nil || err != nil {
		return parsed, err
	}
	lines := make([]uint32, 0, len(recipe.lines))
	for line := range recipe.lines {
		lines = append(lines, line)
	}
	slices.Sort(lines)
	for _, line := range lines {
		ok, err := parsed.ApplySourceLineEdit(ctx, line, recipe.lines[line], identity.Version)
		if err != nil || !ok {
			parsed.Discard()
			if err != nil {
				return nil, err
			}
			c.directoryMu.Lock()
			if latest, found := c.pending[identity.URI]; found && latest.version == identity.Version {
				c.replaceRecipeLocked(identity.URI, syntaxRecipe{})
			}
			c.directoryMu.Unlock()
			return nil, nil
		}
	}
	return parsed, nil
}

// Compaction evicts optional lexical records only. The newest complete record is
// copied forward in bounded chunks while readers hold the directory read lock.
// Missing records always lead to fresh parsing and complete analysis.
func (c *parseCache) compactLocked(key [32]byte, latest parseLocation) {
	fail := func() { c.disabled = true; clear(c.entries); clear(c.pending); c.recipeBytes = 0 }
	if latest.size > c.limit {
		if err := c.file.Truncate(0); err != nil {
			fail()
			return
		}
		if _, err := c.file.Seek(0, io.SeekStart); err != nil {
			fail()
			return
		}
		c.offset = 0
		clear(c.entries)
		clear(c.pending)
		c.recipeBytes = 0
		return
	}
	buffer := make([]byte, 65536)
	for offset := int64(0); offset < latest.size; {
		if c.ctx.Err() != nil {
			fail()
			return
		}
		n := int(min(int64(len(buffer)), latest.size-offset))
		if _, err := c.file.ReadAt(buffer[:n], latest.offset+offset); err != nil {
			fail()
			return
		}
		if _, err := c.file.WriteAt(buffer[:n], offset); err != nil {
			fail()
			return
		}
		offset += int64(n)
	}
	if err := c.file.Truncate(latest.size); err != nil {
		fail()
		return
	}
	if _, err := c.file.Seek(latest.size, io.SeekStart); err != nil {
		fail()
		return
	}
	c.offset = latest.size
	clear(c.entries)
	c.entries[key] = parseLocation{0, latest.size}
	for uri, recipe := range c.pending {
		if recipe.base != key {
			c.replaceRecipeLocked(uri, syntaxRecipe{})
		}
	}
}
