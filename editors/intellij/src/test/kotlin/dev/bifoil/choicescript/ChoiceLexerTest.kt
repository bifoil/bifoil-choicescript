package dev.bifoil.choicescript

import org.junit.Assert.assertTrue
import org.junit.Test

class ChoiceLexerTest {
	@Test
	fun malformedCommandStringCannotConsumeNextLine() {
		val text = "*set name \"broken\n*print 42"
		val lexer = ChoiceLexer()
		lexer.start(text, 0, text.length, 0)
		val tokens = mutableListOf<Pair<String, String>>()
		while (lexer.tokenType != null) {
			tokens += lexer.tokenType.toString() to text.substring(lexer.tokenStart, lexer.tokenEnd)
			lexer.advance()
		}
		assertTrue(tokens.contains("string" to "\"broken"))
		assertTrue(tokens.contains("keyword" to "*print"))
		assertTrue(tokens.contains("number" to "42"))
	}

	@Test
	fun proseQuotesDoNotCaptureCommands() {
		val text = "She said \"hello\n*if male\n  William.\""
		val lexer = ChoiceLexer()
		lexer.start(text, 0, text.length, 0)
		var found = false
		while (lexer.tokenType != null) {
			if (text.substring(lexer.tokenStart, lexer.tokenEnd) == "*if") found = true
			lexer.advance()
		}
		assertTrue(found)
	}
	@Test
	fun carriageReturnLinesKeepMalformedStringsLocal() {
		val text = "*set name \"broken\r*print 42"
		val lexer = ChoiceLexer()
		lexer.start(text, 0, text.length, 0)
		val tokens = mutableListOf<Pair<String, String>>()
		while (lexer.tokenType != null) {
			tokens += lexer.tokenType.toString() to text.substring(lexer.tokenStart, lexer.tokenEnd)
			lexer.advance()
		}
		assertTrue(tokens.contains("string" to "\"broken"))
		assertTrue(tokens.contains("keyword" to "*print"))
	}
}
// Count copied characters rather than relying on timing on CI.
class ChoiceLexerComplexityTest {
	@Test
	fun longCommandLinesDoNotRepeatedlyCopyTheRemainingLine() {
		class CountedSequence(private val text: String) : CharSequence {
			var copied = 0L
			override val length = text.length
			override fun get(index: Int) = text[index]
			override fun subSequence(startIndex: Int, endIndex: Int): CharSequence {
				copied += endIndex - startIndex
				return text.subSequence(startIndex, endIndex)
			}
		}
		val text = CountedSequence("*print " + "value & ".repeat(20_000) + "value")
		val lexer = ChoiceLexer()
		lexer.start(text, 0, text.length, 0)
		var tokens = 0
		while (lexer.tokenType != null) {
			tokens++
			lexer.advance()
		}
		assertTrue(tokens > 40_000)
		assertTrue("Copied undefined characters for 0 characters of input", text.copied < 2L * text.length)
	}
}
