package dev.bifoil.choicescript

import com.intellij.lexer.LexerBase
import com.intellij.openapi.diff.DiffColors
import com.intellij.openapi.editor.HighlighterColors
import com.intellij.openapi.editor.colors.EditorColorsManager
import com.intellij.openapi.editor.colors.TextAttributesKey
import com.intellij.openapi.fileTypes.SyntaxHighlighter
import com.intellij.openapi.fileTypes.SyntaxHighlighterBase
import com.intellij.openapi.fileTypes.SyntaxHighlighterFactory
import com.intellij.openapi.options.colors.AttributesDescriptor
import com.intellij.openapi.options.colors.ColorDescriptor
import com.intellij.openapi.options.colors.ColorSettingsPage
import com.intellij.openapi.project.Project
import com.intellij.openapi.vfs.VirtualFile
import com.intellij.psi.TokenType
import com.intellij.psi.tree.IElementType
import java.awt.Font
import javax.swing.Icon
import com.intellij.openapi.editor.DefaultLanguageHighlighterColors as C

/**
 * Semantic legend and native scheme keys. names must keep exactly the shared core's
 * token ordering; defaults supplies one theme-derived fallback per category.
 * Cross-line/branch classifications arrive from LSP, not this presentation layer.
 */
object ChoiceColors {
	val coverage = TextAttributesKey.createTextAttributesKey("BIFOIL_CHOICESCRIPT_COVERAGE", DiffColors.DIFF_INSERTED)
	val names = listOf(
		"keyword",
		"comment",
		"string",
		"number",
		"operator",
		"variable",
		"function",
		"label",
		"boolean",
		"dialogue",
		"narrative",
		"stringVariable",
		"numberVariable",
		"booleanVariable",
		"markup",
		"interpolation"
	)

	private val defaults = listOf(
		C.KEYWORD,
		C.LINE_COMMENT,
		C.STRING,
		C.NUMBER,
		C.OPERATION_SIGN,
		C.LOCAL_VARIABLE,
		C.FUNCTION_CALL,
		C.LABEL,
		C.KEYWORD,
		C.STRING,
		HighlighterColors.TEXT,
		C.STRING,
		C.NUMBER,
		C.KEYWORD,
		C.MARKUP_TAG,
		C.BRACES
	)

	val keys = names.mapIndexed { i, name ->
		name to TextAttributesKey.createTextAttributesKey(
			"BIFOIL_CHOICESCRIPT_${name.uppercase()}", defaults[i]
		)
	}.toMap()

	/**
	 * Resolve a semantic style and merge bold/italic with the current scheme's attributes.
	 * Derived keys include the attributes hash, so switching schemes do not reuse stale colors.
	 */
	fun key(name: String, modifiers: List<String>): TextAttributesKey? {
		val base = keys[name] ?: return null

		val font = (if ("bold" in modifiers) Font.BOLD else 0) or (if ("italic" in modifiers) Font.ITALIC else 0)
		if (font == 0) return base

		val scheme = EditorColorsManager.getInstance().globalScheme
		val attributes = scheme.getAttributes(base).clone()
		attributes.fontType = attributes.fontType or font

		val key = TextAttributesKey.createTextAttributesKey(
			base.externalName + "_" + font + "_" + attributes.hashCode(), base
		)
		scheme.setAttributes(key, attributes)
		return key
	}

	/**
	 * Plain prose already receives this exact key from the fallback lexer. Avoid
	 * creating a redundant LSP highlighter for every prose row in a large game.
	 * Full token classifications remain available; dialogue and styled prose still
	 * overlay their distinct semantic attributes.
	 */
	fun semanticKey(name: String, modifiers: List<String>): TextAttributesKey? =
		if (name == "narrative" && modifiers.none { it == "bold" || it == "italic" }) null else key(name, modifiers)

	val tokens = names.associateWith { IElementType(it, ChoiceLanguage) }
}

/**
 * Restartable line-local fallback lexer. Expression strings never consume a newline,
 * and prose is deliberately not a stateful string region. LSP supplies dialogue/type
 * semantics. Every token must advance within the requested buffer slice.
 */
class ChoiceLexer : LexerBase() {
	private var buffer: CharSequence = ""
	private var limit = 0
	private var start = 0
	private var end = 0
	private var lineStart = -1
	private var lineEnd = -1
	private var commandLine = false
	private var proseStart = Int.MAX_VALUE
	private var type: IElementType? = null

	override fun start(buffer: CharSequence, startOffset: Int, endOffset: Int, initialState: Int) {
		this.buffer = buffer
		limit = endOffset
		end = startOffset
		lineStart = -1
		lineEnd = -1
		advance()
	}

	override fun getState() = 0

	override fun getTokenType() = type

	override fun getTokenStart() = start

	override fun getTokenEnd() = end

	override fun getBufferSequence() = buffer

	override fun getBufferEnd() = limit

	private fun word(char: Char) = char in 'a'..'z' || char in 'A'..'Z' || char in '0'..'9' || char == '_'

	private fun token(name: String, stop: Int) {
		end = stop.coerceAtLeast(start + 1).coerceAtMost(limit)
		type = ChoiceColors.tokens[name]
	}

	/** Locate the line-local prose after an inline choice, including lexer restarts inside it. */
	private fun inlineProse(first: Int): Int {
		var end = first + 1
		while (end < lineEnd && word(buffer[end])) end++
		val command = buffer.subSequence(first + 1, end).toString().lowercase()
		val reuse = command in listOf("hide_reuse", "disable_reuse", "allow_reuse")
		if (!reuse && command != "if" && command != "selectable_if") return Int.MAX_VALUE
		var quoted = false
		var depth = 0
		var at = end
		while (at < lineEnd) {
			val char = buffer[at]
			if (char == '\\' && quoted) {
				at += 2
				continue
			}
			if (char == '"') quoted = !quoted
			if (!quoted) {
				if (char == '(') depth++
				if (char == ')') depth--
				if (char == '#' && depth == 0 && (reuse || at == end || buffer[at - 1].isWhitespace())) return at + 1
			}
			at++
		}
		return Int.MAX_VALUE
	}

	override fun advance() {
		start = end

		if (start >= limit) {
			type = null
			return
		}

		if (buffer[start].isWhitespace()) {
			end++
			while (end < limit && buffer[end].isWhitespace()) end++
			type = TokenType.WHITE_SPACE
			return
		}

		if (start !in lineStart until lineEnd) {
			lineStart = start
			while (lineStart > 0 && buffer[lineStart - 1] != '\n' && buffer[lineStart - 1] != '\r') lineStart--
			lineEnd = start
			while (lineEnd < limit && buffer[lineEnd] != '\n' && buffer[lineEnd] != '\r') lineEnd++
			var first = lineStart
			while (first < lineEnd && buffer[first].isWhitespace()) first++
			commandLine = first < lineEnd && buffer[first] == '*'
			proseStart = if (commandLine) inlineProse(first) else first
		}

		if (!commandLine || start >= proseStart) {
			token("narrative", lineEnd)
			return
		}

		if (buffer[start] == '*') {
			var stop = start + 1
			while (stop < lineEnd && word(buffer[stop])) stop++
			val command = buffer.subSequence(start + 1, stop).toString()
			token(
				if (command.equals("comment", ignoreCase = true)) "comment" else "keyword",
				if (command.equals("comment", ignoreCase = true)) lineEnd else stop
			)
			return
		}

		if (buffer[start] == '"') {
			var stop = start + 1

			while (stop < lineEnd) if (buffer[stop] == '\\') stop = (stop + 2).coerceAtMost(lineEnd)
			else if (buffer[stop++] == '"') break

			token("string", stop)
			return
		}

		if (buffer[start] in '0'..'9') {
			var stop = start + 1
			while (stop < lineEnd && buffer[stop] in '0'..'9') stop++
			if (stop + 1 < lineEnd && buffer[stop] == '.' && buffer[stop + 1] in '0'..'9') {
				stop++
				while (stop < lineEnd && buffer[stop] in '0'..'9') stop++
			}

			token("number", stop)
			return
		}

		if (word(buffer[start])) {
			var stop = start + 1
			while (stop < lineEnd && word(buffer[stop])) stop++
			val value = buffer.subSequence(start, stop).toString()
			token(if (value.equals("true", true) || value.equals("false", true)) "boolean" else "variable", stop)
			return
		}

		token("operator", start + 1)
	}
}

/**
 * Map fallback lexer categories to the same theme keys used by semantic tokens.
 */
class ChoiceHighlighter : SyntaxHighlighterBase() {
	override fun getHighlightingLexer() = ChoiceLexer()

	override fun getTokenHighlights(tokenType: IElementType) =
		ChoiceColors.keys[tokenType.toString()]?.let { arrayOf(it) } ?: emptyArray()
}

class ChoiceHighlighterFactory : SyntaxHighlighterFactory() {
	override fun getSyntaxHighlighter(project: Project?, virtualFile: VirtualFile?): SyntaxHighlighter =
		ChoiceHighlighter()
}

/**
 * Expose theme overrides and representative token samples; sample tags are settings markup, not ChoiceScript syntax.
 */
class ChoiceColorsPage : ColorSettingsPage {
	override fun getIcon(): Icon? = null

	override fun getHighlighter() = ChoiceHighlighter()

	override fun getDemoText() =
		"*create name \"Alex\"\n*create score 42\n*create brave true\n<dialogue>\"Hello there.\"</dialogue>\n*print <numberVariable>score</numberVariable>\n*print <stringVariable>name</stringVariable>\n*print <booleanVariable>brave</booleanVariable>"

	override fun getAdditionalHighlightingTagToDescriptorMap() = ChoiceColors.keys

	override fun getAttributeDescriptors() =
		(ChoiceColors.names.map { AttributesDescriptor(it, ChoiceColors.keys.getValue(it)) } + AttributesDescriptor(
			BifoilBundle.message("coverage.color.description"), ChoiceColors.coverage
		)).toTypedArray()

	override fun getColorDescriptors(): Array<ColorDescriptor> = ColorDescriptor.EMPTY_ARRAY

	override fun getDisplayName() = "Bifoil ChoiceScript"
}
