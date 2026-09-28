package dev.chinay.branchlight

import com.intellij.lang.Commenter
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.actionSystem.CommonDataKeys
import com.intellij.openapi.actionSystem.DataContext
import com.intellij.openapi.command.WriteCommandAction
import com.intellij.codeInsight.editorActions.enter.EnterHandlerDelegate
import com.intellij.codeInsight.editorActions.enter.EnterHandlerDelegateAdapter
import com.intellij.codeInsight.template.TemplateContextType
import com.intellij.codeInsight.template.TemplateActionContext
import com.intellij.openapi.editor.Editor
import com.intellij.psi.PsiFile

class ChoiceCommenter : Commenter {
    override fun getLineCommentPrefix() = "*comment "
    override fun getBlockCommentPrefix(): String? = null
    override fun getBlockCommentSuffix(): String? = null
    override fun getCommentedBlockCommentPrefix(): String? = null
    override fun getCommentedBlockCommentSuffix(): String? = null
}
class ChoiceEnterHandler : EnterHandlerDelegateAdapter() {
    override fun postProcessEnter(file: PsiFile, editor: Editor, dataContext: DataContext): EnterHandlerDelegate.Result {
        if (file.language != ChoiceLanguage) return EnterHandlerDelegate.Result.Continue
        val doc=editor.document;val offset=editor.caretModel.offset;val line=doc.getLineNumber(offset)
        if(line==0)return EnterHandlerDelegate.Result.Continue
        val previous=doc.charsSequence.subSequence(doc.getLineStartOffset(line-1),doc.getLineEndOffset(line-1)).toString()
        val current=doc.charsSequence.subSequence(doc.getLineStartOffset(line),offset).toString()
        if(current.isBlank()&&Regex("^\\s*(?:\\*(?:if|elseif|elsif|else|choice|fake_choice|scene_list|stat_chart|achievement)\\b.*|#.*)$").matches(previous)){
            val indent=previous.takeWhile { it==' '||it=='\t' };val wanted=indent+if(indent.contains('\t'))"\t" else "  "
            doc.replaceString(doc.getLineStartOffset(line),offset,wanted);editor.caretModel.moveToOffset(doc.getLineStartOffset(line)+wanted.length)
        }
        return EnterHandlerDelegate.Result.Continue
    }
}
class ChoiceTemplateContext : TemplateContextType("ChoiceScript") {
    override fun isInContext(context: TemplateActionContext) = context.file.language == ChoiceLanguage
}
open class WrapAction(private val tag:String) : AnAction() {
    override fun actionPerformed(e:AnActionEvent){val editor=e.getData(CommonDataKeys.EDITOR)?:return;WriteCommandAction.runWriteCommandAction(e.project){val selections=editor.caretModel.allCarets.sortedByDescending { it.selectionStart };for(caret in selections){val text=caret.selectedText?:"";editor.document.replaceString(caret.selectionStart,caret.selectionEnd,"[$tag]$text[/$tag]")}}}
}
class BoldAction : WrapAction("b")
class ItalicAction : WrapAction("i")
