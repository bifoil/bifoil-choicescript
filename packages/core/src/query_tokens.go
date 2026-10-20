package core

import (
	"iter"
	"sort"
)

const queryTokenBlockSize = 256

type queryTokenBlock struct {
	values        []Token
	stride        uint32
	count, period uint16
}
type queryTokens struct {
	blocks []queryTokenBlock
	starts []int
	count  int
}

// TokenSequence borrows immutable complete classifications. Repeated blocks store
// exact periods and line strides; irregular blocks retain every original token.
type TokenSequence struct {
	dense  []Token
	packed *queryTokens
}

func DenseTokenSequence(tokens []Token) TokenSequence { return TokenSequence{dense: tokens} }
func (p *Project) TokenSequence(doc uint32) TokenSequence {
	if int(doc) < len(p.queryTokens) && p.queryTokens[doc] != nil {
		return TokenSequence{packed: p.queryTokens[doc]}
	}
	if int(doc) < len(p.Tokens) {
		return DenseTokenSequence(p.Tokens[doc])
	}
	return TokenSequence{}
}
func (s TokenSequence) Len() int {
	if s.packed != nil {
		return s.packed.count
	}
	return len(s.dense)
}
func (b queryTokenBlock) at(index int) Token {
	if b.period == 0 {
		return b.values[index]
	}
	value := b.values[index%int(b.period)]
	value.Line += uint32(index/int(b.period)) * b.stride
	return value
}
func (s TokenSequence) At(index int) Token {
	if s.packed == nil {
		return s.dense[index]
	}
	block := sort.Search(len(s.packed.blocks), func(i int) bool { return s.packed.starts[i+1] > index })
	return s.packed.blocks[block].at(index - s.packed.starts[block])
}
func (s TokenSequence) All() iter.Seq2[int, Token] {
	return func(yield func(int, Token) bool) {
		if s.packed == nil {
			for i, t := range s.dense {
				if !yield(i, t) {
					return
				}
			}
			return
		}
		index := 0
		for _, block := range s.packed.blocks {
			for i := 0; i < int(block.count); i++ {
				if !yield(index, block.at(i)) {
					return
				}
				index++
			}
		}
	}
}
func tokenPattern(tokens []Token) queryTokenBlock {
	block := queryTokenBlock{values: tokens, count: uint16(len(tokens))}
	for period := 1; period <= min(16, len(tokens)/2); period++ {
		stride := tokens[period].Line - tokens[0].Line
		matches := true
		for i := period; i < len(tokens); i++ {
			expected := tokens[i%period]
			expected.Line += uint32(i/period) * stride
			if expected != tokens[i] {
				matches = false
				break
			}
		}
		if matches {
			block.values = tokens[:period]
			block.period = uint16(period)
			block.stride = stride
			break
		}
	}
	return block
}
func packQueryTokens(tokens []Token) *queryTokens {
	if len(tokens) <= 65536 {
		return nil
	}
	result := &queryTokens{count: len(tokens), blocks: make([]queryTokenBlock, 0, (len(tokens)+queryTokenBlockSize-1)/queryTokenBlockSize)}
	stored := 0
	for start := 0; start < len(tokens); start += queryTokenBlockSize {
		block := tokenPattern(tokens[start:min(start+queryTokenBlockSize, len(tokens))])
		stored += len(block.values)
		result.blocks = append(result.blocks, block)
	}
	// Avoid extra retained metadata for incompressible streams. This first pass
	// borrows input slices, so rejecting compression never allocates a dense copy.
	if stored*24+len(result.blocks)*32 >= len(tokens)*24*3/4 {
		return nil
	}
	for i := range result.blocks {
		result.blocks[i].values = append([]Token(nil), result.blocks[i].values...)
	}
	result.index()
	return result
}
func (q *queryTokens) index() {
	q.starts = make([]int, len(q.blocks)+1)
	q.count = 0
	for i, block := range q.blocks {
		q.count += int(block.count)
		q.starts[i+1] = q.count
	}
}
func (p *Project) compactQueryTokens() {
	p.queryTokens = make([]*queryTokens, len(p.Tokens))
	for doc, tokens := range p.Tokens {
		if packed := packQueryTokens(tokens); packed != nil {
			p.queryTokens[doc] = packed
			p.Tokens[doc] = nil
		}
	}
}
func (p *Project) tokenLineBounds(doc, line uint32) (int, int) {
	sequence := p.TokenSequence(doc)
	return sort.Search(sequence.Len(), func(i int) bool { return sequence.At(i).Line >= line }), sort.Search(sequence.Len(), func(i int) bool { return sequence.At(i).Line > line })
}

// Edits replace affected immutable blocks and share every other block. Prefix
// offsets keep random access exact when a changed line gains or loses spans.
func (p *Project) replaceQueryTokens(q *Project, doc uint32, first, last int, replacement []Token) bool {
	sequence := p.TokenSequence(doc)
	if sequence.packed == nil {
		q.Tokens = append([][]Token(nil), p.Tokens...)
		updated := make([]Token, 0, sequence.Len()-(last-first)+len(replacement))
		updated = append(updated, sequence.dense[:first]...)
		updated = append(updated, replacement...)
		updated = append(updated, sequence.dense[last:]...)
		q.Tokens[doc] = updated
		return true
	}
	packed := sequence.packed
	locate := func(index int) int {
		return sort.Search(len(packed.blocks), func(i int) bool { return packed.starts[i+1] > index })
	}
	firstBlock, endBlock := locate(first), locate(last)
	affectedEnd := endBlock
	if endBlock < len(packed.blocks) && last > packed.starts[endBlock] {
		affectedEnd++
	}
	begin, end := first, last
	if firstBlock < len(packed.blocks) {
		begin = packed.starts[firstBlock]
	}
	if affectedEnd > 0 {
		end = packed.starts[affectedEnd]
	}
	middle := make([]Token, 0, first-begin+len(replacement)+end-last)
	for i := begin; i < first; i++ {
		middle = append(middle, sequence.At(i))
	}
	middle = append(middle, replacement...)
	for i := last; i < end; i++ {
		middle = append(middle, sequence.At(i))
	}
	updated := &queryTokens{blocks: make([]queryTokenBlock, 0, firstBlock+(len(middle)+queryTokenBlockSize-1)/queryTokenBlockSize+len(packed.blocks)-affectedEnd)}
	updated.blocks = append(updated.blocks, packed.blocks[:firstBlock]...)
	for start := 0; start < len(middle); start += queryTokenBlockSize {
		block := tokenPattern(middle[start:min(start+queryTokenBlockSize, len(middle))])
		block.values = append([]Token(nil), block.values...)
		updated.blocks = append(updated.blocks, block)
	}
	updated.blocks = append(updated.blocks, packed.blocks[affectedEnd:]...)
	updated.index()
	q.queryTokens = append([]*queryTokens(nil), p.queryTokens...)
	q.queryTokens[doc] = updated
	return true
}
