package dev.bifoil.choicescript

import com.intellij.execution.impl.ConsoleViewImpl
import com.intellij.ide.trustedProjects.TrustedProjects
import com.intellij.openapi.actionSystem.*
import com.intellij.openapi.actionSystem.ex.ActionUtil
import com.intellij.openapi.components.service
import com.intellij.openapi.fileEditor.FileEditorManager
import com.intellij.openapi.project.DumbService
import com.intellij.openapi.ui.Messages
import com.intellij.openapi.ui.TestDialogManager
import com.intellij.openapi.util.Disposer
import com.intellij.openapi.util.io.FileUtil
import com.intellij.openapi.vfs.LocalFileSystem
import com.intellij.platform.lsp.api.LspClientManager
import com.intellij.platform.lsp.api.LspServerState
import com.intellij.testFramework.PlatformTestUtil
import com.intellij.testFramework.PsiTestUtil
import com.intellij.testFramework.fixtures.BasePlatformTestCase
import com.intellij.util.ui.UIUtil
import java.nio.file.Files
import java.util.concurrent.CompletableFuture
import java.util.concurrent.atomic.AtomicReference

/** Real IDE actions, native custom requests, progress and console notifications share one owned session. */
class ChoiceUiTest : BasePlatformTestCase() {
	fun testNativeToolActionsPreserveProgressOutputAndSettings() {
		val directory = Files.createTempDirectory("bifoil ui Ω ")
		val source = directory.resolve("scenes/startup.txt")
		Files.createDirectories(source.parent)
		Files.writeString(source, "*create score 1\nOriginal narrative words.\n*ending\n")
		val file = LocalFileSystem.getInstance().refreshAndFindFileByNioFile(source)!!
		PsiTestUtil.addContentRoot(module, file.parent.parent)
		val manager = LspClientManager.getInstance(project)
		val dialogs = mutableListOf<String>()
		val previousDialog = TestDialogManager.setTestDialog { text -> dialogs.add(text); Messages.OK }
		val answers = ArrayDeque(listOf("2", "123"))
		val previousInput = TestDialogManager.setTestInputDialog { answers.removeFirstOrNull() }
		// Match normal GUI scheduling; headless test mode otherwise waits before the job can start.
		val previousProgressMode = System.setProperty("intellij.progress.task.ignoreHeadless", "true")
		val ui = ChoiceUi.get(project)
		val console = ui.console as ConsoleViewImpl
		assertNotNull(console.component)

		fun text(): String {
			console.flushDeferredText()
			return checkNotNull(console.editor).document.text
		}

		fun awaitOutput(needle: String) {
			try {
				PlatformTestUtil.waitWithEventsDispatching(
					"Missing operation output: $needle", { needle in text() }, 20
				)
			} catch (error: AssertionError) {
				throw AssertionError("$needle; console=${text()}; dialogs=$dialogs", error)
			}
		}

		fun perform(action: AnAction) {
			PlatformTestUtil.waitWithEventsDispatching(
				"Indexing did not settle before action", { !DumbService.isDumb(project) }, 20
			)
			assertTrue("Action disabled: ${action.javaClass.simpleName}", myFixture.testAction(action).isEnabled)
		}

		try {
			TrustedProjects.setProjectTrusted(project, true)
			myFixture.configureFromExistingVirtualFile(file)
			FileEditorManager.getInstance(project).openFile(file, true)
			manager.ensureClientStarted(ChoiceIntegration::class.java, ChoiceDescriptor(project))
			PlatformTestUtil.waitWithEventsDispatching("Native UI client did not start", {
				manager.getClients(ChoiceIntegration::class.java).any { it.state == LspServerState.Running }
			}, 20)
			val discovered = AtomicReference<List<GameProject>>()
			request(project, { it.projects() }) { discovered.set(it) }
			PlatformTestUtil.waitWithEventsDispatching("Custom request did not return to EDT", {
				discovered.get()?.size == 1
			}, 10)
			val game = discovered.get().single()

			val settings = project.service<ChoiceSettings>()
			settings.loadState(ChoiceState(false))
			perform(QuoteWarningsAction())
			assertTrue(settings.state.quoteWarnings)
			perform(WordCountAction())
			PlatformTestUtil.waitWithEventsDispatching("Word count dialog missing", {
				dialogs.any { "Narrative word count: 3" in it }
			}, 10)
			perform(AboutAction())
			assertTrue(dialogs.any { "unaffiliated" in it })

			perform(QuickTestAction())
			awaitOutput("Exit: 0")
			val beforeRandom = text().length
			perform(RandomTestAction())
			PlatformTestUtil.waitWithEventsDispatching("RandomTest did not complete", {
				"Exit: 0" in text().drop(beforeRandom)
			}, 20)
			assertTrue(answers.isEmpty())

			perform(RunAction())
			awaitOutput("http://127.0.0.1:")
			perform(StopAction())
			val settled = CompletableFuture<Unit>()
			request(project, { it.job(mapOf("protocolVersion" to 1, "operation" to "stop", "projectId" to game.id)) }) {
				settled.complete(Unit)
			}
			PlatformTestUtil.waitWithEventsDispatching("Stop did not settle", { settled.isDone }, 10)

			ui.event(JobEvent("original", game.id, "output", "Original linked failure", source.toUri().toString(), 1))
			ui.event(JobEvent("original", game.id, "coverage", coverage = mapOf("startup" to listOf(1, 0, 2))))
			ui.event(JobEvent("original", game.id, "stale"))
			ui.event(JobEvent("original", game.id, "completed", exitCode = 130))
			ui.event(JobEvent("invalid", game.id, "output", uri = "not a file URI"))
			awaitOutput("startup.txt:2")
			awaitOutput("Coverage:")
			awaitOutput("Exit: 130")
			assertFalse("Untracked completion retained forever", "original" in ui.completed)

			val previousStops = Regex("Language server stopped").findAll(text()).count()
			val retired = ui.sessionStarted()
			val current = ui.sessionStarted()
			ui.sessionEnded(retired)
			UIUtil.dispatchAllInvocationEvents()
			assertEquals(
				"Older server exit cleared current UI",
				previousStops,
				Regex("Language server stopped").findAll(text()).count()
			)
			ui.sessionEnded(current)
			PlatformTestUtil.waitWithEventsDispatching(
				"Current server exit was not displayed",
				{ Regex("Language server stopped").findAll(text()).count() == previousStops + 1 },
				10
			)
		} finally {
			if (previousProgressMode == null) System.clearProperty("intellij.progress.task.ignoreHeadless")
			else System.setProperty("intellij.progress.task.ignoreHeadless", previousProgressMode)
			TestDialogManager.setTestInputDialog(previousInput)
			TestDialogManager.setTestDialog(previousDialog)
			manager.stopClients(ChoiceIntegration::class.java)
			FileEditorManager.getInstance(project).closeFile(file)
			Disposer.dispose(console)
			FileUtil.delete(directory.toFile())
		}
	}

	fun testActionsWithoutAProjectDoNotStartRequests() {
		val event = AnActionEvent.createEvent(
			DataContext.EMPTY_CONTEXT, Presentation(), ActionPlaces.UNKNOWN, ActionUiKind.NONE, null
		)
		for (action in listOf(
			NewProjectAction(),
			RunAction(),
			StopAction(),
			QuickTestAction(),
			RandomTestAction(),
			ExportAction(),
			WordCountAction(),
			BoldAction()
		))
			ActionUtil.performAction(action, event)
		assertTrue(QuoteWarningsAction().isSelected(event))
		QuoteWarningsAction().setSelected(event, false)
	}
}
