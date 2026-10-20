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

/**
 * Project defaults mirrored from the shared protocol. Long is used for seeds, but only
 * JavaScript's safe-integer range is valid; [RandomTestInput] enforces that boundary.
 */
data class RandomTestOptions(val iterations: Int = 1000, val seed: Long = 0)

/**
 * Server-discovered game. [id] is opaque; directory fields are absolute server-host paths,
 * not file URIs. A project descriptor does not mean background analysis is complete.
 */
data class GameProject(
	val id: String = "",
	val root: String = "",
	val sceneDir: String = "",
	val assetDir: String = "",
	val name: String = "",
	val randomtest: RandomTestOptions? = null
)

/**
 * Start acknowledgement, not a test-success result. [output] is a saved log path.
 * Tests/export complete through [JobEvent]; preview supplies [url].
 */
data class JobResult(
	val jobId: String = "", val projectId: String = "", val url: String? = null, val output: String? = null
)

/**
 * Subset of the shared job notification used by this adapter.
 * [line] and coverage indices are zero-based. Events may arrive before the start response.
 * A stale result belongs to its captured source; completed exitCode 0 succeeds, 130 cancels.
 */
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

/**
 * Custom methods carried by the native LSP4J connection. Keep parameter shapes aligned
 * with packages/protocol, including array payloads and optional fields. These methods
 * operate on the local server process, not a separately authenticated network service.
 */
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

/**
 * Native file-open entry point. Only supported scene files should cause the project-wide client to start.
 */
class ChoiceIntegration : LspIntegrationProvider {
	override fun fileOpened(
		project: Project, file: VirtualFile, clientStarter: LspIntegrationProvider.LspClientStarter
	) {
		if (ChoiceProjects.supports(project, file)) clientStarter.ensureClientStarted(ChoiceDescriptor(project))
	}
}

/**
 * One native LSP session per project. The platform owns process startup; this descriptor
 * supplies the verified bundle, semantic legend, initialization settings, and notifications.
 * Use supported lifecycle hooks rather than overriding GeneralCommandLine.createProcess.
 */
class ChoiceDescriptor(project: Project) : ProjectWideLspClientDescriptor(project, "Bifoil ChoiceScript (Unofficial)") {
	override fun isSupportedFile(file: VirtualFile) = ChoiceProjects.supports(project, file)

	override fun getLanguageId(file: VirtualFile) = "choicescript"

	override fun createCommandLine(): GeneralCommandLine {
		val root = BundledRuntime.directory()
		val server = root.resolve("server")
		val native = System.getenv("BIFOIL_CHOICESCRIPT_NATIVE_SERVER")?.takeIf { it.isNotBlank() }
			?: BundledRuntime.languageServer(root)
		check(java.nio.file.Files.isRegularFile(java.nio.file.Path.of(native))) {
			"The native language server is missing; rebuild or reinstall Bifoil ChoiceScript."
		}
		return GeneralCommandLine(
			native, "--stdio", "--bundle-root", server.toString(), "--node", BundledRuntime.node(root)
		)
	}

	/**
	 * Bind process exit to this UI session's generation, so a late exit from a retired
	 * server cannot dismiss progress or previews belonging to its replacement.
	 */
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
				ChoiceColors.semanticKey(tokenType, modifiers)
		}
	}

	/** Use a public receiver and object parameters for reflective LSP4J dispatch. */
	override fun createLsp4jClient(handler: LspServerNotificationsHandler): Lsp4jClient =
		ChoiceLanguageClient(project, handler)
}

/** Versioned discovery replacement; a root array would be positional JSON-RPC parameters. */
data class ProjectsChangedParams(val protocolVersion: Int = 1, val projects: List<GameProject> = emptyList())

/** Shared custom notification signatures used by the real native LSP4J receiver. */
interface ChoiceClientNotifications {
	@JsonNotification("choicescript/projectsChanged")
	fun projectsChanged(params: ProjectsChangedParams)

	@JsonNotification("choicescript/jobEvent")
	fun jobEvent(event: JobEvent)
}

/** Public named receiver lets LSP4J invoke callbacks without anonymous-class access failures. */
class ChoiceLanguageClient(private val project: Project, handler: LspServerNotificationsHandler) :
	Lsp4jClient(handler), ChoiceClientNotifications {
	override fun projectsChanged(params: ProjectsChangedParams) {
		if (params.protocolVersion != 1) return
		ChoiceUi.get(project).projects = params.projects
	}

	override fun jobEvent(event: JobEvent) {
		ChoiceUi.get(project).event(event)
	}
}
