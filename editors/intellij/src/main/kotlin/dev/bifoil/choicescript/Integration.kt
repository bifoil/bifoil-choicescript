package dev.bifoil.choicescript

import com.intellij.execution.configurations.GeneralCommandLine
import com.intellij.execution.process.BaseProcessHandler
import com.intellij.openapi.components.service
import com.intellij.openapi.project.Project
import com.intellij.openapi.vfs.VirtualFile
import com.intellij.platform.lsp.api.*
import com.intellij.platform.lsp.api.customization.LspCustomization
import com.intellij.platform.lsp.api.customization.LspSemanticTokensSupport
import com.intellij.psi.PsiFile
import org.eclipse.lsp4j.jsonrpc.services.JsonNotification
import org.eclipse.lsp4j.jsonrpc.services.JsonRequest
import java.util.concurrent.CompletableFuture

data class RandomTestOptions(val iterations: Int = 1000, val seed: Long = 0)
data class GameProject(
	val id: String = "",
	val root: String = "",
	val sceneDir: String = "",
	val assetDir: String = "",
	val name: String = "",
	val randomtest: RandomTestOptions? = null
)

data class JobResult(
	val jobId: String = "", val projectId: String = "", val url: String? = null, val output: String? = null
)

data class JobEvent(
	val jobId: String = "",
	val projectId: String = "",
	val kind: String = "",
	val message: String? = null,
	val uri: String? = null,
	val line: Int? = null,
	val url: String? = null,
	val exitCode: Int? = null,
	val coverage: Map<String, List<Long>>? = null,
	val stale: Boolean = false
)

interface ChoiceServer : Lsp4jServer {
	@JsonNotification("choicescript/assetChanged")
	fun assetChanged(request: Map<String, String>)
	@JsonRequest("choicescript/projects")
	fun projects(): CompletableFuture<List<GameProject>>

	@JsonRequest("choicescript/job")
	fun job(request: Map<String, Any>): CompletableFuture<JobResult>

	@JsonRequest("choicescript/wordCount")
	fun wordCount(request: Map<String, String>): CompletableFuture<Int>
}

class ChoiceIntegration : LspIntegrationProvider {
	override fun fileOpened(
		project: Project, file: VirtualFile, clientStarter: LspIntegrationProvider.LspClientStarter
	) {
		if (ChoiceProjects.supports(project, file)) clientStarter.ensureClientStarted(ChoiceDescriptor(project))
	}
}

class ChoiceDescriptor(project: Project) : ProjectWideLspClientDescriptor(project, "Bifoil ChoiceScript (Unofficial)") {
	override fun isSupportedFile(file: VirtualFile) = ChoiceProjects.supports(project, file)
	override fun getLanguageId(file: VirtualFile) = "choicescript"
	override fun createCommandLine(): GeneralCommandLine {
		val root = BundledRuntime.directory()
		val server = root.resolve("server")
		return GeneralCommandLine(
			BundledRuntime.node(root),
			"--max-old-space-size=96",
			"--max-semi-space-size=2",
			server.resolve("server.cjs").toString(),
			"--stdio",
			"--bundle-root",
			server.toString()
		)
	}

	override fun startServerProcess(): BaseProcessHandler<*> {
		val handler = super.startServerProcess()
		val ui = ChoiceUi.get(project)
		val session = ui.sessionStarted()
		handler.process.onExit().thenRun { ui.sessionEnded(session) }
		return handler
	}
	override fun createInitializationOptions(): Any =
		mapOf("quoteWarnings" to project.service<ChoiceSettings>().state.quoteWarnings)

	override val lsp4jServerClass = ChoiceServer::class.java
	override val lspCustomization = object : LspCustomization() {
		override val semanticTokensCustomizer = object : LspSemanticTokensSupport() {
			override fun shouldAskServerForSemanticTokens(psiFile: PsiFile) = true
			override val tokenTypes = ChoiceColors.names
			override val tokenModifiers = listOf("declaration", "readonly", "bold", "italic")
			override fun getTextAttributesKey(tokenType: String, modifiers: List<String>) =
				ChoiceColors.key(tokenType, modifiers)
		}
	}

	override fun createLsp4jClient(handler: LspServerNotificationsHandler): Lsp4jClient =
		object : Lsp4jClient(handler) {
			// LSP4J invokes this callback through JSON-RPC reflection.
			@Suppress("unused")
			@JsonNotification("choicescript/projectsChanged")
			fun projectsChanged(projects: List<GameProject>) {
				ChoiceUi.get(project).projects = projects
			}

			// LSP4J invokes this callback through JSON-RPC reflection.
			@Suppress("unused")
			@JsonNotification("choicescript/jobEvent")
			fun jobEvent(event: JobEvent) {
				ChoiceUi.get(project).event(event)
			}
		}
}
