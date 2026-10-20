package core

import "encoding/binary"

// Virtual array values are immutable run-length encoded variable bindings. The
// endpoint is independent of the mutable _count variable: redefining or deleting
// an array prefix must preserve older tail variables. Space follows source writes,
// never a potentially enormous runtime length. Kind zero is internal metadata;
// it cannot be produced by a ChoiceScript expression or exposed as a constant.
const arrayRangeWidth = 12

type arrayRange struct {
	last  uint64
	value Value
}

func (p *valuePool) arrayRanges(value Value) (string, bool) {
	// Runtime primitive values always have a nonzero type mask. Avoid touching
	// the intern pool on the overwhelmingly common scalar-join path.
	if value&15 != 0 || value&^bindingPresence == 0 {
		return "", false
	}
	id := uint32(value&^bindingPresence) >> 4
	if id == 0 || int(id) >= len(p.entries) {
		return "", false
	}
	entry := p.entries[id]
	return entry.Text, entry.Kind == 0 && entry.Abstract
}
func arrayRangeEnd(data string, index int) uint64 {
	return binary.LittleEndian.Uint64([]byte(data[index : index+8]))
}
func arrayRangeValue(data string, index int) Value {
	return Value(binary.LittleEndian.Uint32([]byte(data[index+8 : index+12])))
}
func appendArrayRange(data []byte, last uint64, value Value) []byte {
	if len(data) > 0 && Value(binary.LittleEndian.Uint32(data[len(data)-4:])) == value {
		binary.LittleEndian.PutUint64(data[len(data)-arrayRangeWidth:], last)
		return data
	}
	data = binary.LittleEndian.AppendUint64(data, last)
	return binary.LittleEndian.AppendUint32(data, uint32(value))
}
func (p *valuePool) internArrayRanges(data []byte) Value {
	if len(data) == 0 {
		return 0
	}
	if Value(binary.LittleEndian.Uint32(data[len(data)-4:])) == 0 {
		data = data[:len(data)-arrayRangeWidth]
	}
	if len(data) == 0 {
		return 0
	}
	return p.literal(primitive{Abstract: true, Text: string(data)})
}
func (p *valuePool) arrayValue(value Value, index uint64) Value {
	data, ok := p.arrayRanges(value)
	if !ok {
		return value
	}
	low, high := 0, len(data)/arrayRangeWidth
	for low < high {
		mid := (low + high) / 2
		if arrayRangeEnd(data, mid*arrayRangeWidth) < index {
			low = mid + 1
		} else {
			high = mid
		}
	}
	if low == len(data)/arrayRangeWidth {
		return 0
	}
	result := arrayRangeValue(data, low*arrayRangeWidth)
	if value&bindingPresence != 0 {
		result |= value & bindingPresence
	}
	return result
}
func (p *valuePool) replaceArrayPrefix(previous Value, replacements []arrayRange, count uint64) Value {
	data := make([]byte, 0, (len(replacements)+2)*arrayRangeWidth)
	for _, part := range replacements {
		data = appendArrayRange(data, part.last, part.value)
	}
	old, ok := p.arrayRanges(previous)
	if !ok {
		if previous != 0 && count < ^uint64(0) {
			data = appendArrayRange(data, ^uint64(0), previous)
		}
	} else {
		for index := 0; index < len(old); index += arrayRangeWidth {
			if last := arrayRangeEnd(old, index); last > count {
				data = appendArrayRange(data, last, arrayRangeValue(old, index)|(previous&bindingPresence))
			}
		}
	}
	return p.internArrayRanges(data)
}

// A missing range on one incoming path means element-wise optional presence,
// rather than an unknown value for every element on every path.
func (p *valuePool) joinArrayRanges(left, right Value) Value {
	if left == right {
		return left
	}
	a, aok := p.arrayRanges(left)
	b, bok := p.arrayRanges(right)
	var output []byte
	ai, bi := 0, 0
	for ai < len(a) || bi < len(b) || !aok && left != 0 || !bok && right != 0 {
		ae, be := ^uint64(0), ^uint64(0)
		av, bv := left, right
		if aok {
			av = 0
			if ai < len(a) {
				ae = arrayRangeEnd(a, ai)
				av = arrayRangeValue(a, ai) | (left & bindingPresence)
			}
		}
		if bok {
			bv = 0
			if bi < len(b) {
				be = arrayRangeEnd(b, bi)
				bv = arrayRangeValue(b, bi) | (right & bindingPresence)
			}
		}
		end := min(ae, be)
		if av == bv {
			output = appendArrayRange(output, end, av)
			if end == ^uint64(0) {
				break
			}
			if ae == end {
				ai += arrayRangeWidth
			}
			if be == end {
				bi += arrayRangeWidth
			}
			continue
		}
		flags := (av | bv) & bindingPresence
		if av == 0 || bv == 0 {
			flags |= bindingMissing
		}
		x, y := av&^bindingPresence, bv&^bindingPresence
		value := x
		if x == 0 {
			value = y
		} else if y != 0 {
			value = p.join(x, y)
		}
		output = appendArrayRange(output, end, value|flags)
		if end == ^uint64(0) {
			break
		}
		if ae == end {
			ai += arrayRangeWidth
		}
		if be == end {
			bi += arrayRangeWidth
		}
	}
	return p.internArrayRanges(output)
}
