package core

import (
	"encoding/binary"
	"math/bits"
)

const asciiBytes uint64 = 0x0101010101010101
const asciiHigh = asciiBytes * 0x80

func hasASCIIByte(word uint64, b byte) bool {
	value := word ^ (asciiBytes * uint64(b))
	return (value-asciiBytes)&^value&asciiHigh != 0
}

// Classify eight ASCII bytes with independent byte arithmetic. High-bit input,
// quotation punctuation, apostrophes and markup use the ordinary Unicode path.
// No architecture-specific instructions or unsafe string access are required.
func plainASCIIBlock(word uint64) bool {
	return word&asciiHigh == 0 && !hasASCIIByte(word, '"') && !hasASCIIByte(word, '\'') && !hasASCIIByte(word, '[')
}

func asciiWordMask(word uint64) uint64 {
	lower := word | (asciiBytes * 0x20)
	letters := (lower + asciiBytes*(0x80-'a')) &^ (lower + asciiBytes*(0x7f-'z')) & asciiHigh
	digits := (word + asciiBytes*(0x80-'0')) &^ (word + asciiBytes*(0x7f-'9')) & asciiHigh
	return (letters | digits) >> 7
}

func asciiWordStarts(word uint64, inside bool) (starts uint32, last, ok bool) {
	if !plainASCIIBlock(word) {
		return 0, false, false
	}
	words := asciiWordMask(word)
	previous := words << 8
	if inside {
		previous |= 1
	}
	return uint32(bits.OnesCount64(words &^ previous)), words&(uint64(1)<<56) != 0, true
}

// Process a contiguous ASCII prefix in one call. Special punctuation remains
// on the scalar path; this changes neither word boundaries nor quote events.
func asciiWordRun(text string, inside bool) (size int, starts uint32, last bool) {
	previous := uint64(0)
	if inside {
		previous = 1
	}
	for size+8 <= len(text) {
		block := binary.LittleEndian.Uint64([]byte(text[size : size+8]))
		if !plainASCIIBlock(block) {
			break
		}
		words := asciiWordMask(block)
		starts += uint32(bits.OnesCount64(words &^ (words<<8 | previous)))
		previous = words >> 56
		size += 8
	}
	return size, starts, previous != 0
}
