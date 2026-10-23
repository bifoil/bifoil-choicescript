package dev.bifoil.choicescript

import com.intellij.openapi.fileEditor.FileDocumentManager
import com.intellij.openapi.fileEditor.FileEditorManager
import com.intellij.openapi.util.io.FileUtil
import com.intellij.openapi.vfs.LocalFileSystem
import com.intellij.platform.lsp.api.LspClientManager
import com.intellij.platform.lsp.api.LspServerState
import com.intellij.testFramework.PlatformTestUtil
import com.intellij.testFramework.PsiTestUtil
import com.intellij.testFramework.fixtures.BasePlatformTestCase
import org.eclipse.lsp4j.HoverParams
import org.eclipse.lsp4j.Position
import org.eclipse.lsp4j.TextDocumentIdentifier
import java.net.URI
import java.nio.file.Files
import java.nio.file.Path

/** Exercise the IDE-owned manager, synchronization and actual custom receiver together. */
class ChoiceManagerTest : BasePlatformTestCase() {
	fun testManagerOpensBundledServerAndDeliversProjects() {
		val directory = Files.createTempDirectory("bifoil manager Ω ")
		val source = directory.resolve("scenes/startup.txt")
		Files.createDirectories(source.parent)
		Files.writeString(source, $$"*create score 1\nOriginal score: ${score}.\n*ending\n")
		val file = LocalFileSystem.getInstance().refreshAndFindFileByNioFile(source)!!
		// Native automatic synchronization intentionally ignores files outside project content.
		PsiTestUtil.addContentRoot(module, file.parent.parent)
		assertTrue("Original source was not recognized", ChoiceProjects.supports(project, file))
		val manager = LspClientManager.getInstance(project)

		try {
			FileEditorManager.getInstance(project).openFile(file, true)
			manager.ensureClientStarted(ChoiceIntegration::class.java, ChoiceDescriptor(project))
			PlatformTestUtil.waitWithEventsDispatching("IDE manager did not start the native server", {
				manager.getClients(ChoiceIntegration::class.java).any { it.state == LspServerState.Running }
			}, 20)
			val client = manager.getClients(ChoiceIntegration::class.java).single()
			assertEquals(
				source.toUri().path.lowercase(), URI(client.getDocumentIdentifier(file).uri).path.lowercase()
			)
			assertTrue(client.getDocumentVersion(FileDocumentManager.getInstance().getDocument(file)!!) >= 0)
			val queried = PlatformTestUtil.callOnBgtSynchronously({
				client.sendRequestSync(1000) { (it as ChoiceServer).projects() }
			}, 10)
			assertEquals(1, queried!!.size)
			PlatformTestUtil.waitWithEventsDispatching(
				"Native project notification did not reach the actual receiver", {
					ChoiceUi.get(project).projects.any { Path.of(it.sceneDir).normalize() == source.parent.normalize() }
				}, 10
			)

			val hover = PlatformTestUtil.callOnBgtSynchronously({
				client.sendRequestSync(1000) {
					it.textDocumentService.hover(
						HoverParams(
							TextDocumentIdentifier(source.toUri().toString()), Position(0, 9)
						)
					)
				}
			}, 10)
			assertNotNull("Manager synchronization did not make current source available", hover)
			assertTrue("number" in hover!!.contents.right.value)
		} finally {
			manager.stopClients(ChoiceIntegration::class.java)
			FileEditorManager.getInstance(project).closeFile(file)
			FileUtil.delete(directory.toFile())
		}
	}
}
