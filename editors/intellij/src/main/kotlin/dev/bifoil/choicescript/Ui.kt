package dev.bifoil.choicescript

import com.intellij.execution.filters.OpenFileHyperlinkInfo
import com.intellij.execution.filters.TextConsoleBuilderFactory
import com.intellij.execution.ui.ConsoleView
import com.intellij.execution.ui.ConsoleViewContentType
import com.intellij.ide.BrowserUtil
import com.intellij.ide.trustedProjects.TrustedProjects
import com.intellij.openapi.Disposable
import com.intellij.openapi.actionSystem.*
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.components.*
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
import java.util.concurrent.ConcurrentHashMap.newKeySet
import javax.swing.JButton
import javax.swing.JPanel

data class ChoiceState(var quoteWarnings: Boolean = true)

@State(name = "BifoilChoiceScript", storages = [Storage("bifoil.choicescript.xml")])
@Service(Service.Level.PROJECT)
class ChoiceSettings : PersistentStateComponent<ChoiceState> {
	private var data = ChoiceState()
	override fun getState() = data
	override fun loadState(state: ChoiceState) {
		data = state
	}
}

@Service(Service.Level.PROJECT)
class ChoiceUi(private val project: Project) : Disposable {
	companion object {
		fun get(project: Project) = project.service<ChoiceUi>()
	}

	@Volatile
	var projects = emptyList<GameProject>()
	val console: ConsoleView = TextConsoleBuilderFactory.getInstance().createBuilder(project).console
	val completed: MutableSet<String> = newKeySet()
	private val previews = mutableMapOf<String, Content>()
	fun event(event: JobEvent) = ApplicationManager.getApplication().invokeLater {
		if (project.isDisposed) return@invokeLater
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
		if (event.kind == "stale") previews[event.jobId]?.displayName = BifoilBundle.message("preview.source.changed.title")
		if (event.kind == "coverage") console.print(
			"Coverage: ${event.coverage?.mapValues { (_, counts) -> "${counts.count { it > 0 }}/${counts.size} lines" }}\n",
			ConsoleViewContentType.NORMAL_OUTPUT
		)
		if (event.kind == "completed") completed.add(event.jobId)
		if (event.kind == "completed") console.print(
			"Exit: ${event.exitCode}\n",
			if (event.exitCode == 0) ConsoleViewContentType.NORMAL_OUTPUT else ConsoleViewContentType.ERROR_OUTPUT
		)
	}

	fun track(result: JobResult) {
		ProgressManager.getInstance().run(object : Task.Backgroundable(project, "Bifoil ChoiceScript operation", true) {
				override fun run(indicator: ProgressIndicator) {
					indicator.isIndeterminate = true
					while (!completed.remove(result.jobId) && !project.isDisposed) {
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
				}
			})
	}

	fun preview(result: JobResult) {
		val url = result.url ?: return
		val window = ToolWindowManager.getInstance(project).getToolWindow("Bifoil ChoiceScript") ?: return
		if (!JBCefApp.isSupported()) {
			BrowserUtil.browse(url)
			return
		}
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
			request(project, {
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
		window.contentManager.addContent(content)
		// Kotlin exposes this property as read-only against the 2026.1 baseline.
		@Suppress("UsePropertyAccessSyntax")
		window.contentManager.setSelectedContent(content)
		window.show()
	}

	override fun dispose() {
		Disposer.dispose(console)
	}
}

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

fun <T> request(
	project: Project, callback: (ChoiceServer) -> java.util.concurrent.CompletableFuture<T>, done: (T?) -> Unit = {}
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
			ApplicationManager.getApplication().invokeLater {
				if (!project.isDisposed) Messages.showErrorDialog(
					project, error.message ?: error.toString(), "Bifoil ChoiceScript"
				)
			}
		}
	}
}

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
				Messages.showInfoMessage(
					project, "Open a folder containing scenes/startup.txt.", "Bifoil ChoiceScript"
				)
				return@request
			}
			val active = FileEditorManager.getInstance(project).selectedFiles.firstOrNull()
			val selected = games.firstOrNull { active != null && active.toNioPath().startsWith(Path.of(it.sceneDir)) }
				?: if (games.size == 1) games.first() else {
					val dialog = object : com.intellij.ide.util.ChooseElementsDialog<GameProject>(
						project, games, "Bifoil ChoiceScript", "Select a game"
					) {
						override fun getItemText(item: GameProject) = item.name + " — " + item.root
						override fun getItemIcon(item: GameProject): javax.swing.Icon? = null

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
					null
				)?.toIntOrNull() ?: return@request
				val seed = Messages.showInputDialog(
					project, "Seed", "RandomTest", null, (selected.randomtest?.seed ?: 0).toString(), null
				)?.toIntOrNull() ?: return@request
				args["iterations"] = count
				args["seed"] = seed
			}
			if (operation == "exportHtml") {
				val file = FileChooserFactory.getInstance().createSaveFileDialog(
					FileSaverDescriptor("Export HTML", "Choose a new output file", "html"), project
				).save(null as com.intellij.openapi.vfs.VirtualFile?, "game.html") ?: return@request
				args["destination"] = file.file.absolutePath
			}
			execute(project, args)
		}
	}

	private fun execute(project: Project, args: Map<String, Any>) {
		ToolWindowManager.getInstance(project).getToolWindow("Bifoil ChoiceScript")?.show()
		request(
			project, { server ->
				if (operation == "run") server.job(args + ("operation" to "stop"))
					.thenCompose { server.job(args) } else server.job(args)
			}) { result ->
			if (result != null) {
				ChoiceUi.get(project).preview(result)
				if (operation in listOf("quicktest", "randomtest", "exportHtml")) ChoiceUi.get(project).track(result)
				if (operation == "createProject") Messages.showInfoMessage(
					project, "Created ${args["destination"]}. Open that folder to edit your game.", "Bifoil ChoiceScript"
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
