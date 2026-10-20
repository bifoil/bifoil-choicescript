package dev.bifoil.choicescript

import com.intellij.execution.filters.OpenFileHyperlinkInfo
import com.intellij.execution.filters.TextConsoleBuilderFactory
import com.intellij.execution.ui.ConsoleView
import com.intellij.execution.ui.ConsoleViewContentType
import com.intellij.ide.BrowserUtil
import com.intellij.ide.trustedProjects.TrustedProjects
import com.intellij.ide.util.ChooseElementsDialog
import com.intellij.openapi.Disposable
import com.intellij.openapi.actionSystem.*
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.components.*
import com.intellij.openapi.components.Service.Level.PROJECT
import com.intellij.openapi.fileChooser.FileChooser
import com.intellij.openapi.fileChooser.FileChooserDescriptorFactory
import com.intellij.openapi.fileChooser.FileChooserFactory
import com.intellij.openapi.fileChooser.FileSaverDescriptor
import com.intellij.openapi.fileEditor.FileEditorManager
import com.intellij.openapi.progress.ProgressIndicator
import com.intellij.openapi.progress.ProgressManager
import com.intellij.openapi.progress.Task
import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.Messages
import com.intellij.openapi.util.Disposer
import com.intellij.openapi.vfs.LocalFileSystem
import com.intellij.openapi.vfs.VirtualFile
import com.intellij.openapi.wm.ToolWindow
import com.intellij.openapi.wm.ToolWindowFactory
import com.intellij.openapi.wm.ToolWindowManager
import com.intellij.platform.lsp.api.LspClient
import com.intellij.platform.lsp.api.LspClientManager
import com.intellij.ui.content.Content
import com.intellij.ui.content.ContentFactory
import com.intellij.ui.jcef.JBCefApp
import com.intellij.ui.jcef.JBCefBrowser
import org.eclipse.lsp4j.DidChangeConfigurationParams
import java.awt.BorderLayout
import java.net.URI
import java.nio.file.Path
import java.util.*
import java.util.concurrent.ConcurrentHashMap.newKeySet
import java.util.concurrent.atomic.AtomicLong
import javax.swing.Icon
import javax.swing.JButton
import javax.swing.JPanel

/**
 * Persisted per-project presentation preference; disabling warnings does not alter expression syntax or quote styling.
 */
data class ChoiceState(var quoteWarnings: Boolean = true)

/**
 * IDE-managed settings storage; language semantics remain in the server and are updated through LSP configuration.
 */
@State(name = "BifoilChoiceScript", storages = [Storage("bifoil-choicescript.xml")])
@Service(PROJECT)
class ChoiceSettings : PersistentStateComponent<ChoiceState> {
	private var data = ChoiceState()

	override fun getState() = data

	override fun loadState(state: ChoiceState) {
		data = state
	}
}

/**
 * Project-owned console, job progress, and preview contents.
 * Console/content changes run on the EDT; job completion sets and session IDs bridge
 * background request/progress threads. Session generations prevent retired processes
 * from clearing a replacement session's UI.
 */
@Service(PROJECT)
class ChoiceUi(private val project: Project) : Disposable {
	companion object {
		fun get(project: Project) = project.service<ChoiceUi>()
	}

	@Volatile
	var projects = emptyList<GameProject>()
		set(value) {
			field = value
			project.service<ChoiceCoverage>().projectsChanged(value)
		}
	val console: ConsoleView = TextConsoleBuilderFactory.getInstance().createBuilder(project).console
	val completed: MutableSet<String> = newKeySet()
	private val trackedJobs = newKeySet<String>()
	private val previews = mutableMapOf<String, Content>()
	private val previewProjects = mutableMapOf<String, String>()
	private val sessions = AtomicLong()

	@Volatile
	private var sessionActive = false

	/**
	 * Allocate the generation captured by this server process's exit callback.
	 */
	fun sessionStarted(): Long {
		sessionActive = true
		return sessions.incrementAndGet()
	}

	/**
	 * Ignore an older process exit; only the matching current generation may clear previews and coverage.
	 */
	fun sessionEnded(session: Long) {
		if (sessions.get() != session) return

		sessionActive = false
		ApplicationManager.getApplication().invokeLater {
			if (!project.isDisposed && sessions.get() == session) {
				project.service<ChoiceCoverage>().sessionEnded()
				for (id in previews.keys.toList()) closePreview(id)
				console.print(
					"Language server stopped; rerun active operations.\n", ConsoleViewContentType.ERROR_OUTPUT
				)
			}
		}
	}

	private fun closePreview(id: String) {
		val content = previews.remove(id) ?: return

		previewProjects.remove(id)
		ToolWindowManager.getInstance(project).getToolWindow("Bifoil ChoiceScript")?.contentManager?.removeContent(
			content, true
		)
	}

	/**
	 * Marshal server notifications to the EDT, correlate tracked completions, and preserve
	 * output history. Displayed source lines are one-based; hyperlink APIs remain zero-based.
	 */
	fun event(event: JobEvent) = ApplicationManager.getApplication().invokeLater {
		if (project.isDisposed) return@invokeLater

		project.service<ChoiceCoverage>().event(event)
		if (event.message != null) console.print(
			"[${event.kind}] ${event.message}\n", ConsoleViewContentType.NORMAL_OUTPUT
		)

		if (event.uri != null) {
			val file = runCatching {
				LocalFileSystem.getInstance().refreshAndFindFileByNioFile(Path.of(URI(event.uri)))
			}.getOrNull()
			if (file != null) console.printHyperlink(
				"${file.name}:${(event.line ?: 0) + 1}\n", OpenFileHyperlinkInfo(project, file, event.line ?: 0)
			)
		}

		if (event.kind == "preview" && event.url != null) {
			console.printHyperlink("Preview: ${event.url}\n") { BrowserUtil.browse(event.url) }
		}

		if (event.kind == "stale") previews[event.jobId]?.displayName =
			BifoilBundle.message("preview.source.changed.title")
		if (event.kind == "coverage") console.print(
			"Coverage: ${event.coverage?.mapValues { (_, counts) -> "${counts.count { it > 0 }}/${counts.size} lines" }}\n",
			ConsoleViewContentType.NORMAL_OUTPUT
		)

		if (event.kind == "completed") {
			if (event.jobId in trackedJobs) completed.add(event.jobId)
			closePreview(event.jobId)
		}

		if (event.kind == "completed") console.print(
			"Exit: ${event.exitCode}\n",
			if (event.exitCode == 0) ConsoleViewContentType.NORMAL_OUTPUT else ConsoleViewContentType.ERROR_OUTPUT
		)
	}

	/**
	 * Register progress before sending the start request so an immediate terminal event
	 * has an owner. End on completion, project disposal, or session replacement. The handle
	 * does not indicate success; output/completion carries the actual exit status.
	 */
	fun track(result: JobResult) {
		trackedJobs.add(result.jobId)

		val session = sessions.get()
		ProgressManager.getInstance().run(object : Task.Backgroundable(project, "Bifoil ChoiceScript operation", true) {
			override fun run(indicator: ProgressIndicator) {
				indicator.isIndeterminate = true

				try {
					while (!completed.remove(result.jobId) && !project.isDisposed && sessionActive && sessions.get() == session) {
						if (indicator.isCanceled) {
							request(
								project, {
									it.job(
										mapOf(
											"protocolVersion" to 1,
											"operation" to "stop",
											"projectId" to result.projectId,
											"jobId" to result.jobId,
											"trusted" to true
										)
									)
								})
							return
						}

						Thread.sleep(100)
					}
				} finally {
					trackedJobs.remove(result.jobId)
					completed.remove(result.jobId)
				}
			}
		})
	}

	/**
	 * Create JCEF content for an acknowledged local preview, with browser fallback.
	 * The content disposer owns the browser and requests stop for that job. A browser fallback
	 * has no embedded content lifecycle. Game scripts already loaded in the browser may outlive the server.
	 */
	fun preview(result: JobResult) {
		val url = result.url ?: return

		val window = ToolWindowManager.getInstance(project).getToolWindow("Bifoil ChoiceScript") ?: return

		if (!JBCefApp.isSupported()) {
			BrowserUtil.browse(url)
			return
		}

		for (id in previewProjects.filterValues { it == result.projectId }.keys.toList()) closePreview(id)

		val browser = JBCefBrowser(url)
		val panel = JPanel(BorderLayout())
		panel.add(browser.component, BorderLayout.CENTER)

		val browserButton = JButton("Open in Browser")
		browserButton.addActionListener { BrowserUtil.browse(url) }
		panel.add(browserButton, BorderLayout.NORTH)

		val content = ContentFactory.getInstance().createContent(panel, "Game", true)
		content.setDisposer {
			Disposer.dispose(browser)
			previews.remove(result.jobId)
			previewProjects.remove(result.jobId)

			if (!project.isDisposed && sessionActive) request(project, {
				it.job(
					mapOf(
						"protocolVersion" to 1,
						"operation" to "stop",
						"projectId" to result.projectId,
						"jobId" to result.jobId,
						"trusted" to TrustedProjects.isProjectTrusted(project)
					)
				)
			})
		}

		previews[result.jobId] = content
		previewProjects[result.jobId] = result.projectId
		window.contentManager.addContent(content)
		// Kotlin exposes this property as read-only against the 2026.1 baseline.
		@Suppress("UsePropertyAccessSyntax") window.contentManager.setSelectedContent(content)
		window.show()
	}

	override fun dispose() {
		Disposer.dispose(console)
	}
}

/**
 * Native container for the project console and existing registered tool actions.
 */
class ChoiceToolWindow : ToolWindowFactory {
	override fun createToolWindowContent(project: Project, toolWindow: ToolWindow) {
		val console = ChoiceUi.get(project).console
		val panel = JPanel(BorderLayout())
		val actions = ActionManager.getInstance()
		val group = DefaultActionGroup(
			actions.getAction("BifoilChoiceScript.Run"),
			actions.getAction("BifoilChoiceScript.Stop"),
			actions.getAction("BifoilChoiceScript.QuickTest"),
			actions.getAction("BifoilChoiceScript.RandomTest"),
			actions.getAction("BifoilChoiceScript.Export")
		)

		val toolbar = actions.createActionToolbar("Bifoil ChoiceScript", group, true)
		toolbar.targetComponent = panel
		panel.add(toolbar.component, BorderLayout.NORTH)
		panel.add(console.component, BorderLayout.CENTER)
		toolWindow.contentManager.addContent(ContentFactory.getInstance().createContent(panel, "Output", false))
	}
}

/**
 * Run a custom request through the platform-managed client, waiting for initialization
 * off the EDT. done is delivered on the EDT when the project is live; onError runs on
 * the pooled thread. Current failures display a modal error, including cancellation unless
 * the caller/path classifies it. This startup wait is not a sub-second latency guarantee.
 */
fun <T> request(
	project: Project,
	callback: (ChoiceServer) -> java.util.concurrent.CompletableFuture<T>,
	onError: () -> Unit = {},
	done: (T?) -> Unit = {}
) {
	ApplicationManager.getApplication().executeOnPooledThread {
		try {
			val manager = LspClientManager.getInstance(project)
			manager.ensureClientStarted(ChoiceIntegration::class.java, ChoiceDescriptor(project))

			var client: LspClient? = null

			for (i in 0..100) {
				client = manager.getClients(ChoiceIntegration::class.java).firstOrNull { it.initializeResult != null }
				if (client != null || project.isDisposed) break
				Thread.sleep(100)
			}

			check(client != null) { "ChoiceScript language server did not start. Check packaged runtime resources." }

			val result = client.sendRequestSync { callback(it as ChoiceServer) }
			ApplicationManager.getApplication().invokeLater { if (!project.isDisposed) done(result) }
		} catch (error: Exception) {
			onError()
			ApplicationManager.getApplication().invokeLater {
				if (!project.isDisposed) Messages.showErrorDialog(
					project, error.message ?: error.toString(), "Bifoil ChoiceScript"
				)
			}
		}
	}
}

/**
 * Collect user options and enforce IDE trust before dispatching a game operation.
 * Language assistance does not require trust. Stop remains available for owned work.
 * Project selection uses server discovery rather than treating arbitrary .txt files as games.
 */
open class ToolAction(private val operation: String) : AnAction() {
	override fun actionPerformed(event: AnActionEvent) {
		val project = event.project ?: return

		if (operation != "stop" && !TrustedProjects.isProjectTrusted(project)) {
			Messages.showInfoMessage(project, "Trust this project before running game code.", "Bifoil ChoiceScript")
			return
		}

		val args = mutableMapOf<String, Any>("protocolVersion" to 1, "operation" to operation, "trusted" to true)

		if (operation == "createProject") {
			val parent =
				FileChooser.chooseFile(FileChooserDescriptorFactory.createSingleFolderDescriptor(), project, null)
					?: return
			val name = Messages.showInputDialog(
				project, "New project folder name", "Bifoil ChoiceScript", null, "my-choice-game", null
			) ?: return

			if (!name.matches(Regex("[\\w -]+"))) return

			args["destination"] = parent.toNioPath().resolve(name).toString()
			execute(project, args)
			return
		}

		request(project, { it.projects() }) { games ->
			if (games.isNullOrEmpty()) {
				if (operation == "stop") {
					execute(project, args)
					return@request
				}

				Messages.showInfoMessage(
					project, "Open a folder containing scenes/startup.txt.", "Bifoil ChoiceScript"
				)
				return@request
			}

			val active = FileEditorManager.getInstance(project).selectedFiles.firstOrNull()
			val selected = games.firstOrNull { active != null && active.toNioPath().startsWith(Path.of(it.sceneDir)) }
				?: if (games.size == 1) games.first() else {
					val dialog = object : ChooseElementsDialog<GameProject>(
						project, games, "Bifoil ChoiceScript", "Select a game"
					) {
						override fun getItemText(item: GameProject) = item.name + " — " + item.root

						override fun getItemIcon(item: GameProject): Icon? = null

						init {
							myChooser.setSingleSelectionMode()
						}
					}

					dialog.showAndGetResult().singleOrNull()
				} ?: return@request
			args["projectId"] = selected.id

			if (operation == "randomtest") {
				val count = Messages.showInputDialog(
					project,
					"Iterations",
					"RandomTest",
					null,
					(selected.randomtest?.iterations ?: 1000).toString(),
					RandomTestInput.iterationsValidator
				)?.let(RandomTestInput::iterations) ?: return@request

				val seed = Messages.showInputDialog(
					project,
					"Seed",
					"RandomTest",
					null,
					(selected.randomtest?.seed ?: 0).toString(),
					RandomTestInput.seedValidator(count)
				)?.let(RandomTestInput::seed) ?: return@request

				args["iterations"] = count
				args["seed"] = seed
			}

			if (operation == "exportHtml") {
				val file = FileChooserFactory.getInstance().createSaveFileDialog(
					FileSaverDescriptor("Export HTML", "Choose a new output file", "html"), project
				).save(null as VirtualFile?, "game.html") ?: return@request

				args["destination"] = file.file.absolutePath
			}

			execute(project, args)
		}
	}

	/**
	 * Allocate and track a test/export UUID before the wire start. Starting preview first
	 * stops the selected game's prior operation. Result callbacks run on the EDT through request.
	 */
	private fun execute(project: Project, options: Map<String, Any>) {
		val tracked = operation in listOf("quicktest", "randomtest", "exportHtml")
		val args = if (tracked) options + ("jobId" to UUID.randomUUID().toString()) else options
		ToolWindowManager.getInstance(project).getToolWindow("Bifoil ChoiceScript")?.show()
		request(project, { server ->
			if (tracked) ChoiceUi.get(project).track(JobResult(args["jobId"] as String, args["projectId"] as String))
			if (operation == "run") server.job(args + ("operation" to "stop"))
				.thenCompose { server.job(args) } else server.job(args)
		}, onError = { (args["jobId"] as? String)?.let { ChoiceUi.get(project).completed.add(it) } }) { result ->
			if (result != null) {
				ChoiceUi.get(project).preview(result)
				if (operation == "createProject") Messages.showInfoMessage(
					project,
					"Created ${args["destination"]}. Open that folder to edit your game.",
					"Bifoil ChoiceScript"
				)
			}
		}
	}
}

class NewProjectAction : ToolAction("createProject")
class RunAction : ToolAction("run")
class StopAction : ToolAction("stop")
class QuickTestAction : ToolAction("quicktest")
class RandomTestAction : ToolAction("randomtest")
class ExportAction : ToolAction("exportHtml")
class WordCountAction : AnAction() {
	override fun actionPerformed(e: AnActionEvent) {
		val project = e.project ?: return

		val file = FileEditorManager.getInstance(project).selectedFiles.firstOrNull() ?: return

		request(project, { it.wordCount(mapOf("uri" to file.toNioPath().toUri().toString())) }) {
			Messages.showInfoMessage(
				project, "Narrative word count: $it", "Bifoil ChoiceScript"
			)
		}
	}
}

class AboutAction : AnAction() {
	override fun actionPerformed(e: AnActionEvent) {
		Messages.showInfoMessage(
			e.project,
			"Bifoil ChoiceScript 0.1.0\nAn independent Bifoil Foundation project, unaffiliated with Choice of Games or upstream ChoiceScript.",
			"About Bifoil ChoiceScript"
		)
	}
}

/**
 * Project warning preference synchronized to active LSP clients; the toggle reads/writes mutable state on the EDT.
 */
class QuoteWarningsAction : ToggleAction() {
	// The toggle reads the same mutable settings state that UI actions update.
	override fun getActionUpdateThread() = ActionUpdateThread.EDT

	override fun isSelected(e: AnActionEvent) = e.project?.service<ChoiceSettings>()?.state?.quoteWarnings ?: true

	override fun setSelected(e: AnActionEvent, state: Boolean) {
		val project = e.project ?: return

		project.service<ChoiceSettings>().state.quoteWarnings = state
		for (client in LspClientManager.getInstance(project)
			.getClients(ChoiceIntegration::class.java)) client.sendNotification {
			it.workspaceService.didChangeConfiguration(
				DidChangeConfigurationParams(mapOf("bifoil" to mapOf("choicescript" to mapOf("quoteWarnings" to state))))
			)
		}
	}
}
