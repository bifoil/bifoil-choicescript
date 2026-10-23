package dev.bifoil.choicescript

import com.google.gson.Gson
import com.intellij.openapi.command.WriteCommandAction
import com.intellij.openapi.fileEditor.FileDocumentManager
import com.intellij.openapi.fileEditor.FileEditorManager
import com.intellij.openapi.util.io.FileUtil
import com.intellij.openapi.vfs.LocalFileSystem
import com.intellij.platform.lsp.api.LspClient
import com.intellij.platform.lsp.api.LspClientManager
import com.intellij.platform.lsp.api.LspServerState
import com.intellij.testFramework.PlatformTestUtil
import com.intellij.testFramework.PsiTestUtil
import com.intellij.testFramework.fixtures.BasePlatformTestCase
import org.eclipse.lsp4j.HoverParams
import org.eclipse.lsp4j.Position
import org.eclipse.lsp4j.SemanticTokensParams
import org.eclipse.lsp4j.TextDocumentIdentifier
import org.eclipse.lsp4j.services.LanguageServer
import java.lang.management.ManagementFactory
import java.nio.file.Files
import java.nio.file.Path
import java.util.concurrent.CompletableFuture
import java.util.concurrent.atomic.AtomicLong

/** Original disposable scale fixture, exercised through the IDE-owned client and document synchronizer. */
class ChoiceScaleTest : BasePlatformTestCase() {
	fun testTwentyMillionWordsThroughNativeManager() {
		val directory = Files.createTempDirectory("bifoil native scale Ω ")
		val scenes = Files.createDirectories(directory.resolve("scenes"))
		val startup = scenes.resolve("startup.txt")
		Files.newBufferedWriter(startup).use { writer ->
			writer.append("*create score 1\n*create flag true\n*create implicit_control_flow true\n*scene_list\n  startup\n")
			for (chapter in 1..20) writer.append("  chapter$chapter\n")
			writer.append("*finish\n")
		}
		val narrative = "one two three four five six seven eight nine ten ".repeat(10).trimEnd()
		for (chapter in 1..20) Files.newBufferedWriter(scenes.resolve("chapter$chapter.txt")).use { writer ->
			var row = 0
			while (row < 10000) {
				if (row % 500 == 0) {
					writer.append("\"$narrative\n*if flag\n  $narrative\"\n*else\n  $narrative\"\n")
					row += 3
				} else {
					writer.append(narrative).append('\n')
					row++
				}
			}
			writer.append("*gosub increment\n*finish\n*label increment\n*set score +1\n*return\n")
		}
		val root = LocalFileSystem.getInstance().refreshAndFindFileByNioFile(directory)!!
		root.refresh(false, true)
		PsiTestUtil.addContentRoot(module, root)
		val startupFile = LocalFileSystem.getInstance().refreshAndFindFileByNioFile(startup)!!
		val manager = LspClientManager.getInstance(project)
		val editors = FileEditorManager.getInstance(project)
		val timings = linkedMapOf<String, Double>()
		val editPhases = mutableListOf<Map<String, Any>>()
		val requestPhases = mutableListOf<Map<String, Any>>()
		var activeEdit: String? = null
		var words = 0
		var narrativeSpans = 0

		fun <T> timed(name: String, operation: () -> T): T {
			val started = System.nanoTime()
			val result = operation()
			val elapsed = (System.nanoTime() - started) / 1_000_000.0
			timings[name] = elapsed
			assertTrue("$name exceeded the 1000 ms interaction deadline: $elapsed", elapsed < 1000)
			return result
		}

		fun <T> request(client: LspClient, operation: (LanguageServer) -> CompletableFuture<T>): T? {
			val phase = activeEdit
			val began = System.nanoTime()
			val epochMs = System.currentTimeMillis()
			val sent = AtomicLong()
			val received = AtomicLong()
			val result = PlatformTestUtil.callOnBgtSynchronously({
				client.sendRequestSync(1000) { server ->
					sent.set(System.nanoTime())
					operation(server).whenComplete { _, _ -> received.set(System.nanoTime()) }
				}
			}, 10)
			if (phase != null) requestPhases.add(
				mapOf(
					"type" to phase,
					"epochMs" to epochMs,
					"sendDelayMs" to (sent.get() - began) / 1_000_000.0,
					"wireMs" to (received.get() - sent.get()) / 1_000_000.0,
					"afterResponseMs" to (System.nanoTime() - received.get()) / 1_000_000.0
				)
			)
			return result
		}

		try {
			editors.openFile(startupFile, true)
			manager.ensureClientStarted(ChoiceIntegration::class.java, ChoiceDescriptor(project))
			PlatformTestUtil.waitWithEventsDispatching("Scale client did not start", {
				manager.getClients(ChoiceIntegration::class.java).any { it.state == LspServerState.Running }
			}, 20)
			val client = manager.getClients(ChoiceIntegration::class.java).single()
			PlatformTestUtil.waitWithEventsDispatching("Scale project notification was not delivered", {
				ChoiceUi.get(project).projects.any { Path.of(it.sceneDir) == scenes }
			}, 10)
			val startupID = TextDocumentIdentifier(startup.toUri().toString())
			timed("initial-hover") {
				assertTrue(
					"number" in request(client) {
						it.textDocumentService.hover(
							HoverParams(
								startupID, Position(0, 9)
							)
						)
					}!!.contents.right.value
				)
			}
			for (source in Files.list(scenes).use { it.sorted().toList() }) {
				val file = LocalFileSystem.getInstance().refreshAndFindFileByNioFile(source)!!
				val id = TextDocumentIdentifier(source.toUri().toString())
				val tokens = timed("open-and-highlight-${source.fileName}") {
					editors.openFile(file, true)
					request(client) { it.textDocumentService.semanticTokensFull(SemanticTokensParams(id)) }!!
				}
				assertFalse("Empty scale highlighting", tokens.data.isEmpty())
				for (index in tokens.data.indices step 5) if (ChoiceColors.names[tokens.data[index + 3]] in listOf(
						"narrative", "dialogue"
					)
				) narrativeSpans++
				words += timed("word-count-${source.fileName}") {
					request(client) { (it as ChoiceServer).wordCount(mapOf("uri" to source.toUri().toString())) }!!
				}
			}
			assertEquals(20000000, words)
			assertEquals(200000, narrativeSpans)
			editors.openFile(startupFile, true)
			val document = FileDocumentManager.getInstance().getDocument(startupFile)!!
			var previous = "1"
			for ((value, type) in listOf(
				"\"Original native edit\"" to "string", "true" to "boolean", "37" to "number"
			)) {
				activeEdit = type
				timed("typing-to-current-hover-$type") {
					val beforeGC = ManagementFactory.getGarbageCollectorMXBeans().sumOf { it.collectionTime }
					val started = System.nanoTime()
					WriteCommandAction.runWriteCommandAction(project) {
						document.replaceString(14, 14 + previous.length, value)
					}
					val writeMs = (System.nanoTime() - started) / 1_000_000.0
					val requested = System.nanoTime()
					val hover =
						request(client) { it.textDocumentService.hover(HoverParams(startupID, Position(0, 9))) }!!
					editPhases += mapOf(
						"type" to type,
						"writeMs" to writeMs,
						"requestMs" to (System.nanoTime() - requested) / 1_000_000.0,
						"gcMs" to ManagementFactory.getGarbageCollectorMXBeans().sumOf { it.collectionTime } - beforeGC)
					assertTrue("Stale scale type after edit", "Type: `$type`" in hover.contents.right.value)
					previous = value
				}
			}
		} finally {
			println(
				"Native scale metrics: " + Gson().toJson(
					mapOf(
						"words" to words,
						"narrativeSpans" to narrativeSpans,
						"timingsMs" to timings,
						"editPhases" to editPhases,
						"requestPhases" to requestPhases
					)
				)
			)
			val processes = ProcessHandle.current().descendants().use { handles ->
				handles.filter { handle ->
					val command = handle.info().command().orElse("").replace('\\', '/')
					command.endsWith("/runtime/lsp.exe") || command.endsWith("/runtime/lsp")
				}.toList()
			}
			editors.openFiles.forEach(editors::closeFile)
			manager.stopClients(ChoiceIntegration::class.java)
			try {
				PlatformTestUtil.waitWithEventsDispatching(
					"Scale runtime did not exit", { processes.none { it.isAlive } }, 10
				)
			} finally {
				processes.filter { it.isAlive }.forEach { it.destroyForcibly() }
				FileUtil.delete(directory.toFile())
			}
		}
	}
}
