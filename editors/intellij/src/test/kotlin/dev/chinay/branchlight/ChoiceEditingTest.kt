package dev.chinay.branchlight

import com.intellij.codeInsight.template.TemplateActionContext
import com.intellij.codeInsight.template.impl.TemplateSettings
import com.intellij.openapi.actionSystem.ActionManager
import com.intellij.openapi.actionSystem.ActionUpdateThread
import com.intellij.openapi.actionSystem.IdeActions
import com.intellij.testFramework.fixtures.BasePlatformTestCase

class ChoiceEditingTest : BasePlatformTestCase() {
	fun testActionAndTemplateMessagesAreRegistered() {
		val manager = ActionManager.getInstance()
		val actions = listOf(
			manager.getAction("Branchlight.New"),
			manager.getAction("Branchlight.Run"),
			manager.getAction("Branchlight.Stop"),
			manager.getAction("Branchlight.QuickTest"),
			manager.getAction("Branchlight.RandomTest"),
			manager.getAction("Branchlight.Export"),
			manager.getAction("Branchlight.Words"),
			manager.getAction("Branchlight.Bold"),
			manager.getAction("Branchlight.Italic"),
			manager.getAction("Branchlight.QuoteWarnings"),
			manager.getAction("Branchlight.About")
		)
		for (action in actions) {
			assertNotNull("Missing registered action", action)
			assertFalse("Missing action text", action.templatePresentation.text.isNullOrBlank())
		}
		assertEquals(ActionUpdateThread.EDT, QuoteWarningsAction().actionUpdateThread)
		assertEquals("Game — Source Changed", BranchlightBundle.message("preview.source.changed.title"))
		val settings = TemplateSettings.getInstance()
		for (key in listOf("csif", "cschoice")) {
			val template = settings.getTemplate(key, "ChoiceScript")
			assertNotNull("Missing template $key", template)
			assertFalse("Missing template description for $key", template!!.description.isNullOrBlank())
		}
	}

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
		val settings = TemplateSettings.getInstance()
		assertNotNull(settings.getTemplate("csif", "ChoiceScript"))
		assertNotNull(settings.getTemplate("cschoice", "ChoiceScript"))
		assertTrue(
			ChoiceTemplateContext().isInContext(
				TemplateActionContext.expanding(
					myFixture.file, myFixture.editor
				)
			)
		)
	}
}
