package dev.chira.branchlight

import com.intellij.execution.configurations.GeneralCommandLine
import com.intellij.openapi.components.service
import com.intellij.openapi.project.Project
import com.intellij.openapi.vfs.VirtualFile
import com.intellij.platform.lsp.api.*
import com.intellij.platform.lsp.api.customization.*
import com.intellij.psi.PsiFile
import org.eclipse.lsp4j.jsonrpc.services.JsonNotification
import org.eclipse.lsp4j.jsonrpc.services.JsonRequest
import java.util.concurrent.CompletableFuture

data class RandomTestOptions(val iterations: Int = 1000, val seed: Int = 0)
data class GameProject(val id: String = "", val root: String = "", val sceneDir: String = "", val assetDir: String = "", val name: String = "", val randomtest: RandomTestOptions? = null)
data class JobResult(val jobId: String = "", val projectId: String = "", val url: String? = null, val output: String? = null)
data class JobEvent(val jobId: String = "", val projectId: String = "", val kind: String = "", val message: String? = null, val uri: String? = null, val line: Int? = null, val url: String? = null, val exitCode: Int? = null, val coverage: Map<String, List<Int>>? = null)
interface ChoiceServer : Lsp4jServer {
    @JsonRequest("choicescript/projects") fun projects(): CompletableFuture<List<GameProject>>
    @JsonRequest("choicescript/job") fun job(request: Map<String, Any>): CompletableFuture<JobResult>
    @JsonRequest("choicescript/wordCount") fun wordCount(request: Map<String, String>): CompletableFuture<Int>
}
class ChoiceIntegration : LspIntegrationProvider {
    override fun fileOpened(project: Project, file: VirtualFile, clientStarter: LspIntegrationProvider.LspClientStarter) {
        if (ChoiceProjects.supports(project, file)) clientStarter.ensureClientStarted(ChoiceDescriptor(project))
    }
}
class ChoiceDescriptor(project: Project) : ProjectWideLspClientDescriptor(project, "Branchlight (Unofficial)") {
    override fun isSupportedFile(file: VirtualFile) = ChoiceProjects.supports(project, file)
    override fun getLanguageId(file: VirtualFile) = "choicescript"
    override fun createCommandLine(): GeneralCommandLine {
        val root = BundledRuntime.directory()
        val server = root.resolve("server")
        return GeneralCommandLine(BundledRuntime.node(root), server.resolve("server.cjs").toString(), "--stdio", "--bundle-root", server.toString())
    }
    override fun createInitializationOptions(): Any = mapOf("quoteWarnings" to project.service<ChoiceSettings>().state.quoteWarnings)
    override val lsp4jServerClass = ChoiceServer::class.java
    override val lspCustomization = object : LspCustomization() {
        override val semanticTokensCustomizer = object : LspSemanticTokensSupport() {
            override fun shouldAskServerForSemanticTokens(psiFile: PsiFile) = true
            override val tokenTypes = ChoiceColors.names
            override val tokenModifiers = listOf("declaration", "readonly", "bold", "italic")
            override fun getTextAttributesKey(tokenType: String, modifiers: List<String>) = ChoiceColors.key(tokenType, modifiers)
        }
    }
    override fun createLsp4jClient(handler: LspServerNotificationsHandler): Lsp4jClient = object : Lsp4jClient(handler) {
        @JsonNotification("choicescript/projectsChanged") fun projectsChanged(projects: List<GameProject>) { ChoiceUi.get(project).projects = projects }
        @JsonNotification("choicescript/jobEvent") fun jobEvent(event: JobEvent) { ChoiceUi.get(project).event(event) }
    }
}
