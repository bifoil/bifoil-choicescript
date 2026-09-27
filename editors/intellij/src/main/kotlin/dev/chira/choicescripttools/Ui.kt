package dev.chira.choicescripttools

import com.intellij.execution.filters.OpenFileHyperlinkInfo
import com.intellij.execution.ui.ConsoleView
import com.intellij.execution.ui.ConsoleViewContentType
import com.intellij.execution.filters.TextConsoleBuilderFactory
import com.intellij.ide.BrowserUtil
import com.intellij.ide.trustedProjects.TrustedProjects
import com.intellij.openapi.Disposable
import com.intellij.openapi.actionSystem.*
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.components.*
import com.intellij.openapi.fileChooser.FileChooser
import com.intellij.openapi.fileChooser.FileChooserDescriptorFactory
import com.intellij.openapi.fileChooser.FileSaverDescriptor
import com.intellij.openapi.fileChooser.FileChooserFactory
import com.intellij.openapi.fileEditor.FileEditorManager
import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.Messages
import com.intellij.openapi.vfs.LocalFileSystem
import com.intellij.openapi.wm.ToolWindow
import com.intellij.openapi.wm.ToolWindowFactory
import com.intellij.openapi.wm.ToolWindowManager
import com.intellij.platform.lsp.api.*
import com.intellij.ui.content.ContentFactory
import com.intellij.ui.jcef.JBCefApp
import com.intellij.ui.jcef.JBCefBrowser
import com.intellij.util.ui.JBUI
import com.intellij.openapi.util.Disposer
import org.eclipse.lsp4j.DidChangeConfigurationParams
import java.awt.BorderLayout
import java.net.URI
import java.nio.file.Path
import javax.swing.*

data class ChoiceState(var quoteWarnings: Boolean = true)
@State(name = "ChoiceScriptTools", storages = [Storage("choicescript-tools.xml")])
@Service(Service.Level.PROJECT)
class ChoiceSettings : PersistentStateComponent<ChoiceState> {
    private var data = ChoiceState()
    override fun getState() = data
    override fun loadState(state: ChoiceState) { data = state }
}
@Service(Service.Level.PROJECT)
class ChoiceUi(private val project: Project) : Disposable {
    companion object { fun get(project: Project) = project.service<ChoiceUi>() }
    @Volatile var projects: List<GameProject> = emptyList()
    val console: ConsoleView = TextConsoleBuilderFactory.getInstance().createBuilder(project).console
    val completed = java.util.concurrent.ConcurrentHashMap.newKeySet<String>()
    private val previews = mutableMapOf<String, com.intellij.ui.content.Content>()
    fun event(event: JobEvent) = ApplicationManager.getApplication().invokeLater {
        if (project.isDisposed) return@invokeLater
        if (event.message != null) console.print("[${event.kind}] ${event.message}\n", ConsoleViewContentType.NORMAL_OUTPUT)
        if (event.uri != null) {
            val file = runCatching { LocalFileSystem.getInstance().refreshAndFindFileByNioFile(Path.of(URI(event.uri))) }.getOrNull()
            if (file != null) console.printHyperlink("${file.name}:${(event.line ?: 0) + 1}\n", OpenFileHyperlinkInfo(project, file, event.line ?: 0))
        }
        if (event.kind == "stale") previews[event.jobId]?.displayName = "Game — source changed"
        if (event.kind == "coverage") console.print("Coverage: ${event.coverage?.mapValues { (_, counts) -> "${counts.count { it > 0 }}/${counts.size} lines" }}\n", ConsoleViewContentType.NORMAL_OUTPUT)
        if (event.kind == "completed") completed.add(event.jobId)
        if (event.kind == "completed") console.print("Exit: ${event.exitCode}\n", if (event.exitCode == 0) ConsoleViewContentType.NORMAL_OUTPUT else ConsoleViewContentType.ERROR_OUTPUT)
    }
    fun track(result: JobResult) {
        com.intellij.openapi.progress.ProgressManager.getInstance().run(object : com.intellij.openapi.progress.Task.Backgroundable(project, "ChoiceScript operation", true) {
            override fun run(indicator: com.intellij.openapi.progress.ProgressIndicator) {
                indicator.isIndeterminate = true
                while (!completed.remove(result.jobId) && !project.isDisposed) {
                    if (indicator.isCanceled) { request(project, { it.job(mapOf("protocolVersion" to 1, "operation" to "stop", "projectId" to result.projectId, "jobId" to result.jobId, "trusted" to true)) }); return }
                    Thread.sleep(100)
                }
            }
        })
    }
    fun preview(result: JobResult) {
        val url = result.url ?: return
        val window = ToolWindowManager.getInstance(project).getToolWindow("ChoiceScript Tools") ?: return
        if (!JBCefApp.isSupported()) { BrowserUtil.browse(url); return }
        val browser = JBCefBrowser(url)
        val panel = JPanel(BorderLayout())
        panel.add(browser.component, BorderLayout.CENTER)
        val browserButton = JButton("Open in Browser")
        browserButton.addActionListener { BrowserUtil.browse(url) }
        panel.add(browserButton, BorderLayout.NORTH)
        val content = ContentFactory.getInstance().createContent(panel, "Game", true)
        content.setDisposer { Disposer.dispose(browser); previews.remove(result.jobId); request(project, { it.job(mapOf("protocolVersion" to 1, "operation" to "stop", "projectId" to result.projectId, "jobId" to result.jobId, "trusted" to TrustedProjects.isProjectTrusted(project))) }) }
        previews[result.jobId] = content
        window.contentManager.addContent(content); window.contentManager.setSelectedContent(content); window.show()
    }
    override fun dispose() { Disposer.dispose(console) }
}
class ChoiceToolWindow : ToolWindowFactory {
    override fun createToolWindowContent(project: Project, toolWindow: ToolWindow) {
        val console = ChoiceUi.get(project).console
        val panel = JPanel(BorderLayout())
        val group = DefaultActionGroup()
        for (id in listOf("Run", "Stop", "QuickTest", "RandomTest", "Export")) group.add(ActionManager.getInstance().getAction("ChoiceScriptTools.$id"))
        val toolbar = ActionManager.getInstance().createActionToolbar("ChoiceScriptTools", group, true)
        toolbar.targetComponent = panel
        panel.add(toolbar.component, BorderLayout.NORTH); panel.add(console.component, BorderLayout.CENTER)
        toolWindow.contentManager.addContent(ContentFactory.getInstance().createContent(panel, "Output", false))
    }
}
fun <T> request(project: Project, callback: (ChoiceServer) -> java.util.concurrent.CompletableFuture<T>, done: (T?) -> Unit = {}) {
    ApplicationManager.getApplication().executeOnPooledThread {
        try {
            val manager = LspClientManager.getInstance(project)
            manager.ensureClientStarted(ChoiceIntegration::class.java, ChoiceDescriptor(project))
            var client: LspClient? = null
            for (i in 0..100) { client = manager.getClients(ChoiceIntegration::class.java).firstOrNull { it.initializeResult != null }; if (client != null || project.isDisposed) break; Thread.sleep(100) }
            check(client != null) { "ChoiceScript language server did not start. Check packaged runtime resources." }
            val result = client!!.sendRequestSync { callback(it as ChoiceServer) }
            ApplicationManager.getApplication().invokeLater { if (!project.isDisposed) done(result) }
        } catch (error: Exception) { ApplicationManager.getApplication().invokeLater { if (!project.isDisposed) Messages.showErrorDialog(project, error.message ?: error.toString(), "ChoiceScript Tools") } }
    }
}
open class ToolAction(private val operation: String) : AnAction() {
    override fun actionPerformed(event: AnActionEvent) {
        val project = event.project ?: return
        if (operation != "stop" && !TrustedProjects.isProjectTrusted(project)) { Messages.showInfoMessage(project, "Trust this project before running game code.", "ChoiceScript Tools"); return }
        val args = mutableMapOf<String, Any>("protocolVersion" to 1, "operation" to operation, "trusted" to true)
        if (operation == "createProject") {
            val parent = FileChooser.chooseFile(FileChooserDescriptorFactory.createSingleFolderDescriptor(), project, null) ?: return
            val name = Messages.showInputDialog(project, "New project folder name", "ChoiceScript Tools", null, "my-choice-game", null) ?: return
            if (!name.matches(Regex("[\\w -]+"))) return
            args["destination"] = parent.toNioPath().resolve(name).toString()
            execute(project, args); return
        }
        request(project, { it.projects() }) { games ->
            if (games.isNullOrEmpty()) { Messages.showInfoMessage(project, "Open a folder containing scenes/startup.txt.", "ChoiceScript Tools"); return@request }
            val active = FileEditorManager.getInstance(project).selectedFiles.firstOrNull()
            val selected = games.firstOrNull { active != null && active.toNioPath().startsWith(Path.of(it.sceneDir)) }
                ?: if (games.size == 1) games.first() else {
                    val index = Messages.showChooseDialog(project, "Select a game", "ChoiceScript Tools", null, games.map { it.name }.toTypedArray(), games.first().name)
                    games.getOrNull(index)
                } ?: return@request
            args["projectId"] = selected.id
            if (operation == "randomtest") {
                val count = Messages.showInputDialog(project, "Iterations", "RandomTest", null, (selected.randomtest?.iterations ?: 1000).toString(), null)?.toIntOrNull() ?: return@request
                val seed = Messages.showInputDialog(project, "Seed", "RandomTest", null, (selected.randomtest?.seed ?: 0).toString(), null)?.toIntOrNull() ?: return@request
                args["iterations"] = count; args["seed"] = seed
            }
            if (operation == "exportHtml") {
                val file = FileChooserFactory.getInstance().createSaveFileDialog(FileSaverDescriptor("Export HTML", "Choose a new output file", "html"), project).save(null as com.intellij.openapi.vfs.VirtualFile?, "game.html") ?: return@request
                args["destination"] = file.file.absolutePath
            }
            execute(project, args)
        }
    }
    private fun execute(project: Project, args: Map<String, Any>) {
        ToolWindowManager.getInstance(project).getToolWindow("ChoiceScript Tools")?.show()
        request(project, { server -> if (operation == "run") server.job(args + ("operation" to "stop")).thenCompose { server.job(args) } else server.job(args) }) { result -> if (result != null) { ChoiceUi.get(project).preview(result); if (operation in listOf("quicktest", "randomtest", "exportHtml")) ChoiceUi.get(project).track(result); if (operation == "createProject") Messages.showInfoMessage(project, "Created ${args["destination"]}. Open that folder to edit your game.", "ChoiceScript Tools") } }
    }
}
class NewProjectAction : ToolAction("createProject")
class RunAction : ToolAction("run")
class StopAction : ToolAction("stop")
class QuickTestAction : ToolAction("quicktest")
class RandomTestAction : ToolAction("randomtest")
class ExportAction : ToolAction("exportHtml")
class WordCountAction : AnAction() {
    override fun actionPerformed(e: AnActionEvent) { val project=e.project?:return; val file=FileEditorManager.getInstance(project).selectedFiles.firstOrNull()?:return; request(project, { it.wordCount(mapOf("uri" to file.toNioPath().toUri().toString())) }) { Messages.showInfoMessage(project, "Narrative word count: $it", "ChoiceScript Tools") } }
}
class AboutAction : AnAction() {
    override fun actionPerformed(e: AnActionEvent) { Messages.showInfoMessage(e.project, "Branchlight 0.1.0 — ChoiceScript Tools\nAn independent personal project, unaffiliated with Choice of Games or upstream ChoiceScript.", "About ChoiceScript Tools") }
}
class QuoteWarningsAction : ToggleAction() {
    override fun isSelected(e: AnActionEvent) = e.project?.service<ChoiceSettings>()?.state?.quoteWarnings ?: true
    override fun setSelected(e: AnActionEvent, state: Boolean) { val project=e.project?:return;project.service<ChoiceSettings>().state.quoteWarnings=state;for(client in LspClientManager.getInstance(project).getClients(ChoiceIntegration::class.java))client.sendNotification { it.workspaceService.didChangeConfiguration(DidChangeConfigurationParams(mapOf("choicescriptTools" to mapOf("quoteWarnings" to state)))) } }
}
