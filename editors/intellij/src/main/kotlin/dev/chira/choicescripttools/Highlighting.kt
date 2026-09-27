package dev.chira.choicescripttools

import com.intellij.lexer.LexerBase
import com.intellij.openapi.editor.DefaultLanguageHighlighterColors as C
import com.intellij.openapi.editor.HighlighterColors
import com.intellij.openapi.editor.colors.TextAttributesKey
import com.intellij.openapi.fileTypes.SyntaxHighlighterBase
import com.intellij.openapi.fileTypes.SyntaxHighlighterFactory
import com.intellij.openapi.fileTypes.SyntaxHighlighter
import com.intellij.openapi.options.colors.*
import com.intellij.openapi.project.Project
import com.intellij.openapi.vfs.VirtualFile
import com.intellij.psi.tree.IElementType
import com.intellij.psi.TokenType
import javax.swing.Icon

object ChoiceColors {
    val names = listOf("keyword", "comment", "string", "number", "operator", "variable", "function", "label", "boolean", "dialogue", "narrative", "stringVariable", "numberVariable", "booleanVariable", "markup", "interpolation")
    private val defaults = listOf(C.KEYWORD, C.LINE_COMMENT, C.STRING, C.NUMBER, C.OPERATION_SIGN, C.LOCAL_VARIABLE, C.FUNCTION_CALL, C.LABEL, C.KEYWORD, C.STRING, HighlighterColors.TEXT, C.STRING, C.NUMBER, C.KEYWORD, C.MARKUP_TAG, C.BRACES)
    val keys = names.mapIndexed { i, name -> name to TextAttributesKey.createTextAttributesKey("CHOICESCRIPT_TOOLS_${name.uppercase()}", defaults[i]) }.toMap()
    fun key(name: String, modifiers: List<String>): TextAttributesKey? {
        val base = keys[name] ?: return null
        val font = (if ("bold" in modifiers) java.awt.Font.BOLD else 0) or (if ("italic" in modifiers) java.awt.Font.ITALIC else 0)
        if (font == 0) return base
        val attributes = com.intellij.openapi.editor.colors.EditorColorsManager.getInstance().globalScheme.getAttributes(base).clone()
        attributes.fontType = attributes.fontType or font
        return TextAttributesKey.createTextAttributesKey(base.externalName + "_" + font + "_" + attributes.hashCode(), attributes)
    }
    val tokens = names.associateWith { IElementType(it, ChoiceLanguage) }
}
class ChoiceLexer : LexerBase() {
    private var buffer: CharSequence = ""
    private var limit = 0
    private var start = 0
    private var end = 0
    private var type: IElementType? = null
    override fun start(buffer: CharSequence, startOffset: Int, endOffset: Int, initialState: Int) { this.buffer = buffer; limit = endOffset; end = startOffset; advance() }
    override fun getState() = 0
    override fun getTokenType() = type
    override fun getTokenStart() = start
    override fun getTokenEnd() = end
    override fun getBufferSequence() = buffer
    override fun getBufferEnd() = limit
    override fun advance() {
        start = end
        if (start >= limit) { type = null; return }
        val lineStart = buffer.subSequence(0, start).lastIndexOf('\n') + 1
        val lineEnd = buffer.indexOf('\n', start).let { if (it < 0 || it > limit) limit else it }
        val text = buffer.subSequence(start, lineEnd).toString()
        val commandLine = buffer.subSequence(lineStart, lineEnd).trimStart().startsWith("*")
        if (buffer[start].isWhitespace()) { end++; while (end < limit && buffer[end].isWhitespace()) end++; type = TokenType.WHITE_SPACE; return }
        fun token(name: String, length: Int) { end = start + length.coerceAtLeast(1); type = ChoiceColors.tokens[name] }
        if (commandLine && text.startsWith("*comment")) { token("comment", text.length); return }
        if (commandLine && text.startsWith("*")) { token("keyword", Regex("^\\*\\w+").find(text)?.value?.length ?: 1); return }
        if (commandLine && text.startsWith('"')) { var n = 1; while (n < text.length) { if (text[n] == '\\') n += 2 else if (text[n++] == '"') break }; token("string", n.coerceAtMost(text.length)); return }
        if (commandLine) {
            Regex("^\\d+(?:\\.\\d+)?").find(text)?.let { token("number", it.value.length); return }
            Regex("^\\w+").find(text)?.let { token(if (it.value in listOf("true", "false")) "boolean" else "variable", it.value.length); return }
            token("operator", 1); return
        }
        token("narrative", text.length)
    }
}
class ChoiceHighlighter : SyntaxHighlighterBase() {
    override fun getHighlightingLexer() = ChoiceLexer()
    override fun getTokenHighlights(tokenType: IElementType) = ChoiceColors.keys[tokenType.toString()]?.let { arrayOf(it) } ?: emptyArray()
}
class ChoiceHighlighterFactory : SyntaxHighlighterFactory() {
    override fun getSyntaxHighlighter(project: Project?, virtualFile: VirtualFile?): SyntaxHighlighter = ChoiceHighlighter()
}
class ChoiceColorsPage : ColorSettingsPage {
    override fun getIcon(): Icon? = null
    override fun getHighlighter() = ChoiceHighlighter()
    override fun getDemoText() = "*create name \"Alex\"\n*create score 42\n*create brave true\n<dialogue>\"Hello there.\"</dialogue>\n*print <numberVariable>score</numberVariable>\n*print <stringVariable>name</stringVariable>\n*print <booleanVariable>brave</booleanVariable>"
    override fun getAdditionalHighlightingTagToDescriptorMap() = ChoiceColors.keys
    override fun getAttributeDescriptors() = ChoiceColors.names.map { AttributesDescriptor(it, ChoiceColors.keys.getValue(it)) }.toTypedArray()
    override fun getColorDescriptors(): Array<ColorDescriptor> = ColorDescriptor.EMPTY_ARRAY
    override fun getDisplayName() = "ChoiceScript Tools"
}
