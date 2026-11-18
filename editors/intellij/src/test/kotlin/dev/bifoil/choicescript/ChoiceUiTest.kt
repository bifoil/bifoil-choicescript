package dev.bifoil.choicescript

import com.intellij.execution.impl.ConsoleViewImpl
import com.intellij.ide.trustedProjects.TrustedProjects
import com.intellij.openapi.actionSystem.*
import com.intellij.openapi.actionSystem.ex.ActionUtil
import com.intellij.openapi.components.service
import com.intellij.openapi.fileEditor.FileEditorManager
import com.intellij.openapi.project.DumbService
import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.Messages
import com.intellij.openapi.ui.TestDialogManager
import com.intellij.openapi.util.Disposer
import com.intellij.openapi.util.io.FileUtil
import com.intellij.openapi.vfs.LocalFileSystem
import com.intellij.openapi.vfs.VirtualFile
import com.intellij.openapi.wm.ToolWindow
import com.intellij.platform.lsp.api.LspClientManager
import com.intellij.platform.lsp.api.LspServerState
import com.intellij.testFramework.PlatformTestUtil
import com.intellij.testFramework.PsiTestUtil
import com.intellij.testFramework.fixtures.BasePlatformTestCase
import com.intellij.util.ui.UIUtil
import com.intellij.ui.content.ContentFactory
import java.awt.BorderLayout
import java.lang.reflect.Proxy
import java.nio.file.Files
import java.util.concurrent.CompletableFuture
import java.util.concurrent.atomic.AtomicReference
import javax.swing.JPanel

/** Real IDE actions, native custom requests, progress and console notifications share one owned session. */
class ChoiceUiTest : BasePlatformTestCase() {
	fun testNativeToolActionsPreserveProgressOutputAndSettings() {
		val directory = Files.createTempDirectory("bifoil ui Ω ")
		val source = directory.resolve("scenes/startup.txt")
		Files.createDirectories(source.parent)
		Files.writeString(source, "*create score 1\nOriginal narrative words.\n*ending\n")
		for (name in listOf("choicescript_stats", "choicescript_upgrade")) {
			Files.writeString(source.parent.resolve("$name.txt"), "*finish\n")
		}
		val file = LocalFileSystem.getInstance().refreshAndFindFileByNioFile(source)!!
		PsiTestUtil.addContentRoot(module, file.parent.parent)
		val manager = LspClientManager.getInstance(project)
		// The shared light fixture can retain a client initialized for an earlier
		// content-root inventory. This test owns a fresh session for its new game.
		manager.stopClients(ChoiceIntegration::class.java)
		PlatformTestUtil.waitWithEventsDispatching("Previous native client did not stop", {
			manager.getClients(ChoiceIntegration::class.java).none { it.state == LspServerState.Running }
		}, 10)
		val dialogs = mutableListOf<String>()
		val previousDialog = TestDialogManager.setTestDialog { text -> dialogs.add(text); Messages.OK }
		val answers = ArrayDeque<String?>(listOf("2", "123"))
		val previousInput = TestDialogManager.setTestInputDialog { answers.removeFirstOrNull() }
		// Match normal GUI scheduling; headless test mode otherwise waits before the job can start.
		val previousProgressMode = System.setProperty("intellij.progress.task.ignoreHeadless", "true")
		val ui = ChoiceUi.get(project)
		val console = ui.console as ConsoleViewImpl
		assertNotNull(console.component)
		val contents = ContentFactory.getInstance().createContentManager(false, project)
		Disposer.register(testRootDisposable, contents)
		val window = Proxy.newProxyInstance(
			ToolWindow::class.java.classLoader, arrayOf(ToolWindow::class.java)
		) { proxy, method, args ->
			when (method.name) {
				"getContentManager" -> contents
				"toString" -> "Original test tool window"
				"hashCode" -> System.identityHashCode(proxy)
				"equals" -> proxy === args?.firstOrNull()
				else -> error("Unexpected tool-window call: ${method.name}")
			}
		} as ToolWindow
		ChoiceToolWindow().createToolWindowContent(project, window)
		assertEquals(1, contents.contentCount)
		val output = checkNotNull(contents.getContent(0))
		assertEquals("Output", output.displayName)
		val outputPanel = output.component as JPanel
		assertSame(console.component, (outputPanel.layout as BorderLayout).getLayoutComponent(BorderLayout.CENTER))

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
			try {
				PlatformTestUtil.waitWithEventsDispatching("Custom request did not return to EDT", {
					discovered.get()?.size == 1
				}, 10)
			} catch (error: AssertionError) {
				throw AssertionError("Custom request: games=${discovered.get()}, dialogs=$dialogs", error)
			}
			val game = discovered.get().single()

			val failedCallbacks = java.util.concurrent.atomic.AtomicInteger()
			for (failure in listOf(IllegalStateException("Original callback failure"), IllegalStateException())) {
				val previousDialogs = dialogs.size
				request<String>(project, { CompletableFuture.failedFuture(failure) }, onError = {
					failedCallbacks.incrementAndGet()
				}) { fail("A failed request delivered a successful result") }
				PlatformTestUtil.waitWithEventsDispatching("Request failure did not reach the error dialog", {
					dialogs.size > previousDialogs
				}, 10)
			}
			assertEquals(2, failedCallbacks.get())
			assertTrue(dialogs.any { "Original callback failure" in it })
			val missingResult = CompletableFuture<Boolean>()
			request<String?>(project, { CompletableFuture.completedFuture<String?>(null) }) { missingResult.complete(it == null) }
			PlatformTestUtil.waitWithEventsDispatching("Nullable request result was lost", { missingResult.isDone }, 10)
			assertTrue(missingResult.get())
			val pendingReply = CompletableFuture<String>()
			request(project, { pendingReply }) { fail("A timed-out request delivered a successful result") }
			PlatformTestUtil.waitWithEventsDispatching("Request timeout did not reach the error dialog", {
				dialogs.any { "request timed out or its language server stopped" in it }
			}, 20)
			assertTrue("Timeout did not cancel the original wire request", pendingReply.isCancelled)

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

			// Cancelling either prompt, or supplying an invalid answer, must stop
			// before a new native RandomTest job is dispatched.
			for (cancelled in listOf(listOf(null), listOf("0"), listOf("2", null), listOf("2", "invalid"))) {
				answers.addAll(cancelled)
				perform(RandomTestAction())
				PlatformTestUtil.waitWithEventsDispatching("Cancelled inputs were not consumed", { answers.isEmpty() }, 10)
			}

			val parent = file.parent.parent
			perform(object : ToolAction("createProject") {
				override fun chooseProjectParent(project: Project): VirtualFile? = null
			})
			for (name in listOf(null, "../invalid")) {
				answers.add(name)
				perform(object : ToolAction("createProject") {
					override fun chooseProjectParent(project: Project) = parent
				})
				assertTrue(answers.isEmpty())
			}
			val created = directory.resolve("created-game")
			answers.add("created-game")
			perform(object : ToolAction("createProject") {
				override fun chooseProjectParent(project: Project) = parent
			})
			PlatformTestUtil.waitWithEventsDispatching("Native project creation did not finish", {
				Files.isRegularFile(created.resolve("scenes/startup.txt")) &&
					dialogs.any { "Created " in it && "created-game" in it }
			}, 20)
			assertTrue(Files.readString(created.resolve("scenes/startup.txt")).isNotBlank())
			assertEquals("*create score 1\nOriginal narrative words.\n*ending\n", Files.readString(source))

			val cancelledExport = CompletableFuture<Boolean>()
			perform(object : ToolAction("exportHtml") {
				override fun chooseExportDestination(project: Project): String? {
					cancelledExport.complete(true)
					return null
				}
			})
			PlatformTestUtil.waitWithEventsDispatching("Export cancellation did not return", { cancelledExport.isDone }, 10)
			val exported = directory.resolve("original.html")
				val beforeExport = text().length
			perform(object : ToolAction("exportHtml") {
				override fun chooseExportDestination(project: Project) = exported.toString()
			})
				try {
					PlatformTestUtil.waitWithEventsDispatching("Native HTML export did not finish", {
						"Exit:" in text().drop(beforeExport)
					}, 20)
				} catch (error: AssertionError) {
					throw AssertionError("Export: console=${text().drop(beforeExport)}; dialogs=$dialogs", error)
				}
				assertTrue("Export failed: ${text().drop(beforeExport)}", "Exit: 0" in text().drop(beforeExport))
				assertTrue(Files.isRegularFile(exported))
				assertTrue(Files.readString(exported).contains("Original narrative words."))

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
			ui.event(JobEvent("optional", game.id, "output", uri = source.toUri().toString()))
			ui.event(JobEvent("optional", game.id, "coverage"))
			ui.event(JobEvent("optional", game.id, "preview"))
			ui.event(JobEvent("optional", game.id, "preview", url = "http://127.0.0.1:1/original"))
			awaitOutput("startup.txt:2")
			awaitOutput("startup.txt:1")
			awaitOutput("Coverage:")
			awaitOutput("Coverage: null")
			awaitOutput("Preview: http://127.0.0.1:1/original")
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

	fun testUntrustedExecutionActionsStopBeforeStartingAClient() {
		val previouslyTrusted = TrustedProjects.isProjectTrusted(project)
		val dialogs = mutableListOf<String>()
		val previousDialog = TestDialogManager.setTestDialog { text -> dialogs.add(text); Messages.OK }
		val manager = LspClientManager.getInstance(project)
		val clientsBefore = manager.getClients(ChoiceIntegration::class.java).size
		val context = DataContext { id -> if (id == CommonDataKeys.PROJECT.name) project else null }
		val event = AnActionEvent.createEvent(
			context, Presentation(), ActionPlaces.UNKNOWN, ActionUiKind.NONE, null
		)
		try {
			TrustedProjects.setProjectTrusted(project, false)
			for (action in listOf(NewProjectAction(), RunAction(), QuickTestAction(), RandomTestAction(), ExportAction())) {
				action.actionPerformed(event)
			}
			assertEquals(5, dialogs.size)
			assertTrue(dialogs.all { "Trust this project before running game code." in it })
			assertEquals(clientsBefore, manager.getClients(ChoiceIntegration::class.java).size)
		} finally {
			TrustedProjects.setProjectTrusted(project, previouslyTrusted)
			TestDialogManager.setTestDialog(previousDialog)
		}
	}
}
