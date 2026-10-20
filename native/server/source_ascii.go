package main

import "encoding/binary"

// plainASCIISourceLength finds the JSON-safe ASCII prefix without decoding or
// allocating. Both streaming paths stop at the same quote, escape, control or
// Unicode boundary before scalar validation resumes.
func plainASCIISourceLength(chunk []byte) int {
	plain := 0
	for plain+8 <= len(chunk) {
		word := binary.LittleEndian.Uint64(chunk[plain : plain+8])
		const ones uint64 = 0x0101010101010101
		const high = ones * 0x80
		if word&high != 0 || ((word+ones*0x60)&high) != high {
			break
		}
		quote, escape := word^(ones*'"'), word^(ones*'\\')
		if (quote-ones)&^quote&high != 0 || (escape-ones)&^escape&high != 0 {
			break
		}
		plain += 8
	}
	for plain < len(chunk) {
		b := chunk[plain]
		if b == '"' || b == '\\' || b < 0x20 || b >= 0x80 {
			break
		}
		plain++
	}
	return plain
}

// Decode complete ASCII runs and simple JSON escapes directly into the writer's
// available buffer. Unicode, surrogate pairs, incomplete escapes and validation
// stay on the reference scalar path. Every decoded byte still contributes its
// exact immutable source offset and physical-line index.
func decodeASCIISourceChunk(input, output []byte, capture *sourceCapture) (int, []byte) {
	consumed := 0
	for consumed < len(input) && len(output) < cap(output) {
		chunk := input[consumed:]
		plain := plainASCIISourceLength(chunk)
		plain = min(plain, cap(output)-len(output))
		if plain > 0 {
			output = append(output, chunk[:plain]...)
			capture.advancePlain(plain)
			consumed += plain
			continue
		}
		if chunk[0] != '\\' || len(chunk) < 2 {
			break
		}
		var value byte
		switch chunk[1] {
		case 'n':
			value = '\n'
		case 'r':
			value = '\r'
		case 't':
			value = '\t'
		case 'b':
			value = '\b'
		case 'f':
			value = '\f'
		case '\\', '/', '"':
			value = chunk[1]
		default:
			return consumed, output
		}
		capture.advanceRune(rune(value))
		output = append(output, value)
		consumed += 2
	}
	return consumed, output
}
