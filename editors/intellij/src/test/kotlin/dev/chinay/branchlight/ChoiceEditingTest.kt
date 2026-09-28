package dev.chinay.branchlight

import com.intellij.testFramework.fixtures.BasePlatformTestCase
import com.intellij.openapi.actionSystem.IdeActions

class ChoiceEditingTest : BasePlatformTestCase() {
    fun testFormattingActionsAndComments() {
        myFixture.configureByText(ChoiceFileType, "<selection>Hello</selection>")
        myFixture.testAction(BoldAction())
        assertEquals("[b]Hello[/b]", myFixture.editor.document.text)
        myFixture.editor.selectionModel.setSelection(0, myFixture.editor.document.textLength)
        myFixture.testAction(ItalicAction())
        assertEquals("[i][b]Hello[/b][/i]", myFixture.editor.document.text)
        myFixture.editor.selectionModel.removeSelection()
        myFixture.editor.caretModel.moveToOffset(0)
        myFixture.performEditorAction(IdeActions.ACTION_COMMENT_LINE)
        assertTrue(myFixture.editor.document.text.startsWith("*comment"))
        myFixture.performEditorAction(IdeActions.ACTION_COMMENT_LINE)
        assertEquals("[i][b]Hello[/b][/i]", myFixture.editor.document.text)
    }
    fun testIndentationAndRegisteredTemplates() {
        myFixture.configureByText(ChoiceFileType, "*if true<caret>")
        myFixture.type('\n')
        assertEquals("*if true\n  ", myFixture.editor.document.text)
        val settings = com.intellij.codeInsight.template.impl.TemplateSettings.getInstance()
        assertTrue(settings.templates.any { it.groupName == "ChoiceScript" && it.string.contains("*choice") })
        assertTrue(ChoiceTemplateContext().isInContext(com.intellij.codeInsight.template.TemplateActionContext.expanding(myFixture.file, myFixture.editor)))
    }
}
