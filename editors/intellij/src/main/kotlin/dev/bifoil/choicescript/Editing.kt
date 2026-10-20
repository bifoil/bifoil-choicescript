package dev.bifoil.choicescript

import com.intellij.codeInsight.editorActions.enter.EnterHandlerDelegate
import com.intellij.codeInsight.editorActions.enter.EnterHandlerDelegateAdapter
import com.intellij.codeInsight.template.TemplateActionContext
import com.intellij.codeInsight.template.TemplateContextType
import com.intellij.lang.Commenter
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.actionSystem.CommonDataKeys
import com.intellij.openapi.actionSystem.DataContext
import com.intellij.openapi.command.WriteCommandAction
import com.intellij.openapi.editor.Editor
import com.intellij.psi.PsiFile

/**
 * ChoiceScript has line comments only; do not invent a block-comment delimiter pair.
 */
class ChoiceCommenter : Commenter {
	override fun getLineCommentPrefix() = "*comment "

	override fun getBlockCommentPrefix(): String? = null

	override fun getBlockCommentSuffix(): String? = null

	override fun getCommentedBlockCommentPrefix(): String? = null

	override fun getCommentedBlockCommentSuffix(): String? = null
}

/**
 * Indent after recognized block/option headers only within ChoiceScript files.
 * Preserves tab-based indentation or adds two spaces; this handles the Enter key, not a
 * whole-document formatter or a substitute for the shared parser.
 */
class ChoiceEnterHandler : EnterHandlerDelegateAdapter() {
	override fun postProcessEnter(
		file: PsiFile, editor: Editor, dataContext: DataContext
	): EnterHandlerDelegate.Result {
		if (file.language != ChoiceLanguage) return EnterHandlerDelegate.Result.Continue

		val doc = editor.document
		val offset = editor.caretModel.offset
		val line = doc.getLineNumber(offset)
		if (line == 0) return EnterHandlerDelegate.Result.Continue

		val previous =
			doc.charsSequence.subSequence(doc.getLineStartOffset(line - 1), doc.getLineEndOffset(line - 1)).toString()
		val current = doc.charsSequence.subSequence(doc.getLineStartOffset(line), offset).toString()
		val pattern =
			"^\\s*(?:\\*(?:if|elseif|elsif|else|choice|fake_choice|scene_list|stat_chart|achievement)\\b.*|#.*)$"

		if (current.isBlank() && Regex(pattern).matches(previous)) {
			val indent = previous.takeWhile { it == ' ' || it == '\t' }
			val wanted = indent + if ('\t' in indent) "\t" else "  "
			doc.replaceString(doc.getLineStartOffset(line), offset, wanted)
			editor.caretModel.moveToOffset(doc.getLineStartOffset(line) + wanted.length)
		}

		return EnterHandlerDelegate.Result.Continue
	}
}

/**
 * Restrict live-template expansion to files using the ChoiceScript language.
 */
class ChoiceTemplateContext : TemplateContextType("ChoiceScript") {
	override fun isInContext(context: TemplateActionContext) = context.file.language == ChoiceLanguage
}

/**
 * Wrap every caret selection in narrative markup in one undoable write command.
 * Process offsets backwards so earlier edits cannot shift later ranges. This inserts
 * tags, including for empty selections; it does not toggle or normalize existing markup.
 */
open class WrapAction(private val tag: String) : AnAction() {
	override fun actionPerformed(e: AnActionEvent) {
		val editor = e.getData(CommonDataKeys.EDITOR) ?: return

		WriteCommandAction.runWriteCommandAction(e.project) {
			val selections = editor.caretModel.allCarets.sortedByDescending { it.selectionStart }

			for (caret in selections) {
				val text = caret.selectedText ?: ""
				editor.document.replaceString(caret.selectionStart, caret.selectionEnd, "[$tag]$text[/$tag]")
			}
		}
	}
}

class BoldAction : WrapAction("b")
class ItalicAction : WrapAction("i")
