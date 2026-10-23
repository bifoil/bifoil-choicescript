package dev.bifoil.choicescript

import com.intellij.openapi.editor.colors.EditorColorsManager
import com.intellij.openapi.util.io.FileUtil
import com.intellij.openapi.vfs.LocalFileSystem
import com.intellij.psi.PsiManager
import com.intellij.testFramework.fixtures.BasePlatformTestCase
import com.intellij.ui.ColorUtil
import org.eclipse.lsp4j.*
import org.eclipse.lsp4j.jsonrpc.Launcher
import org.eclipse.lsp4j.services.LanguageClient
import java.awt.Font
import java.nio.file.Files
import java.nio.file.Path
import java.util.concurrent.CompletableFuture
import java.util.concurrent.ExecutionException
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit

/** Exercises native file detection and the packaged runtime through the real LSP transport. */
class ChoiceIntegrationTest : BasePlatformTestCase() {
	// The globalScheme property is read-only against the 2026.1 baseline.
	@Suppress("UsePropertyAccessSyntax")
	fun testThemeDerivedSemanticColors() {
		val manager = EditorColorsManager.getInstance()
		val original = manager.globalScheme

		try {
			for (dark in listOf(false, true)) {
				val scheme = manager.allSchemes.firstOrNull {
					ColorUtil.isDark(it.defaultBackground) == dark
				}

				assertNotNull("Missing " + (if (dark) "dark" else "light") + " color scheme", scheme)

				manager.setGlobalScheme(scheme!!)

				for (name in ChoiceColors.names) {
					val key = ChoiceColors.keys.getValue(name)
					val attributes = scheme.getAttributes(key)

					assertNotNull("Missing semantic attributes for $name", attributes)

					val fallback = key.fallbackAttributeKey

					assertNotNull("Missing theme fallback for $name", fallback)
					assertEquals(scheme.getAttributes(fallback!!).foregroundColor, attributes.foregroundColor)
				}

				val base = scheme.getAttributes(ChoiceColors.keys.getValue("dialogue"))
				val styled = scheme.getAttributes(ChoiceColors.key("dialogue", listOf("bold", "italic"))!!)

				assertEquals(base.foregroundColor, styled.foregroundColor)
				assertEquals(Font.BOLD or Font.ITALIC, styled.fontType and 3)
			}
		} finally {
			manager.setGlobalScheme(original)
		}
	}

	fun testPlainProseUsesIdenticalFallbackWithoutRedundantSemanticMarkers() {
		val lexer = ChoiceLexer()
		val text = "Original ordinary prose."
		lexer.start(text, 0, text.length, 0)
		assertEquals(ChoiceColors.tokens.getValue("narrative"), lexer.tokenType)
		assertEquals(
			listOf(ChoiceColors.keys.getValue("narrative")),
			ChoiceHighlighter().getTokenHighlights(lexer.tokenType!!).toList()
		)
		assertNull(ChoiceColors.semanticKey("narrative", emptyList()))
		assertNotNull(ChoiceColors.semanticKey("narrative", listOf("bold")))
		assertNotNull(ChoiceColors.semanticKey("narrative", listOf("italic")))
		assertNotNull(ChoiceColors.semanticKey("dialogue", emptyList()))
	}

	fun testPackagedDialogueAndProjectDetection() {
		val text =
			"*create gender \"male\"\n*create implicit_control_flow true\nShe said \"This is the end,\n*if gender = \"male\"\n    William.\"\n*else\n    Belle.\"\nShe walked away."
		val directory = Files.createTempDirectory("bifoil-choicescript native Ω ")
		Files.createDirectories(directory.resolve("scenes"))
		Files.writeString(directory.resolve("scenes/startup.txt"), text)
		Files.writeString(directory.resolve("notes.txt"), "Unrelated notes")

		val file = LocalFileSystem.getInstance().refreshAndFindFileByNioFile(directory.resolve("scenes/startup.txt"))!!
		val notes = LocalFileSystem.getInstance().refreshAndFindFileByNioFile(directory.resolve("notes.txt"))!!
		assertTrue(ChoiceProjects.supports(project, file))
		assertFalse(ChoiceProjects.supports(project, notes))
		assertEquals(ChoiceLanguage, PsiManager.getInstance(project).findFile(file)!!.language)

		val runtime = BundledRuntime.directory()
		val executable = Path.of(BundledRuntime.languageServer(runtime))
		assertTrue("Host native executable was not extracted", Files.isRegularFile(executable))
		assertFalse(
			"Native executable was extracted twice",
			Files.exists(runtime.resolve("server/native/win32-x64/bifoil-language-server.exe"))
		)
		assertTrue(
			"Native executable path exceeds the existing Node launch path",
			executable.toString().length <= BundledRuntime.node(runtime).length
		)
		val process = ChoiceDescriptor(project).startServerProcess().process
		val diagnostics = LinkedBlockingQueue<PublishDiagnosticsParams>()
		val client = object : LanguageClient {
			override fun telemetryEvent(value: Any?) {}

			override fun publishDiagnostics(value: PublishDiagnosticsParams) {
				diagnostics.add(value)
			}

			override fun showMessage(value: MessageParams) {}

			override fun logMessage(value: MessageParams) {}

			override fun showMessageRequest(value: ShowMessageRequestParams) =
				CompletableFuture.completedFuture<MessageActionItem>(null)

			override fun registerCapability(value: RegistrationParams) = CompletableFuture.completedFuture<Void>(null)

			override fun refreshSemanticTokens() = CompletableFuture.completedFuture<Void>(null)
		}

		val launcher =
			Launcher.Builder<ChoiceServer>().setLocalService(client).setRemoteInterface(ChoiceServer::class.java)
				.setInput(process.inputStream).setOutput(process.outputStream).create()
		val listening = launcher.startListening()

		try {
			val server = launcher.remoteProxy
			val root = file.parent.parent.toNioPath().toUri().toString()
			val uri = file.toNioPath().toUri().toString()
			val params = InitializeParams().apply {
				capabilities = ClientCapabilities()
				workspaceFolders = listOf(WorkspaceFolder(root, "game"))
			}

			val init = server.initialize(params).get(15, TimeUnit.SECONDS)

			assertEquals(ChoiceColors.names, init.capabilities.semanticTokensProvider.legend.tokenTypes)

			server.initialized(InitializedParams())
			server.textDocumentService.didOpen(
				DidOpenTextDocumentParams(
					TextDocumentItem(
						uri, "choicescript", 1, text
					)
				)
			)

			val published = diagnostics.poll(15, TimeUnit.SECONDS)

			assertNotNull("No diagnostics publication from packaged server", published)
			assertTrue(published.diagnostics.isEmpty())

			val data = server.textDocumentService.semanticTokensFull(SemanticTokensParams(TextDocumentIdentifier(uri)))
				.get(15, TimeUnit.SECONDS).data
			val spans = mutableListOf<Triple<Int, IntRange, String>>()
			var line = 0
			var column = 0

			for (i in data.indices step 5) {
				column = if (data[i] == 0) column + data[i + 1] else data[i + 1]
				line += data[i]
				spans.add(Triple(line, column until column + data[i + 2], ChoiceColors.names[data[i + 3]]))
			}

			fun kind(line: Int, col: Int) = spans.first { it.first == line && col in it.second }.third

			assertEquals("dialogue", kind(2, 10))
			assertEquals("string", kind(3, 15))
			assertEquals("dialogue", kind(4, 4))
			assertEquals("dialogue", kind(6, 4))
			assertEquals("narrative", kind(7, 0))

			val games = server.projects().get(10, TimeUnit.SECONDS)

			assertEquals(1, games.size)

			val completion =
				server.textDocumentService.completion(CompletionParams(TextDocumentIdentifier(uri), Position(3, 5)))
					.get(10, TimeUnit.SECONDS)
			assertTrue((completion.left ?: completion.right.items).any { it.label == "gender" })

			val rename =
				server.textDocumentService.rename(RenameParams(TextDocumentIdentifier(uri), Position(3, 5), "identity"))
					.get(10, TimeUnit.SECONDS)
			assertEquals(2, rename.changes[uri]!!.size)

			try {
				server.job(
					mapOf(
						"protocolVersion" to 1,
						"operation" to "run",
						"projectId" to games.single().id,
						"trusted" to false
					)
				).get(10, TimeUnit.SECONDS)
				fail("Untrusted execution must be refused")
			} catch (error: ExecutionException) {
				assertTrue("Trust" in error.cause.toString())
			}

			assertTrue(
				server.textDocumentService.semanticTokensFull(SemanticTokensParams(TextDocumentIdentifier(uri)))
					.get(10, TimeUnit.SECONDS).data.isNotEmpty()
			)
			server.shutdown().get(5, TimeUnit.SECONDS)
			server.exit()
		} finally {
			listening.cancel(true)
			process.destroyForcibly()
			FileUtil.delete(directory.toFile())
		}
	}

	fun testConfiguredScenesRequireStartupAndSupportUppercaseExtension() {
		val directory = Files.createTempDirectory("bifoil detection ")

		try {
			Files.createDirectories(directory.resolve("chapters"))
			Files.writeString(directory.resolve("choicescript.json"), """{"scenes":"chapters"}""")

			val scenePath = directory.resolve("chapters/CHAPTER.TXT")
			Files.writeString(scenePath, "Original scene.")

			val scene = LocalFileSystem.getInstance().refreshAndFindFileByNioFile(scenePath)!!

			assertFalse(ChoiceProjects.supports(project, scene))

			Files.writeString(directory.resolve("chapters/startup.txt"), "*ending")
			LocalFileSystem.getInstance().refreshAndFindFileByNioFile(directory.resolve("chapters/startup.txt"))

			assertTrue(ChoiceProjects.supports(project, scene))

			Files.delete(directory.resolve("chapters/startup.txt"))
			scene.parent.refresh(false, true)
			Files.writeString(directory.resolve("choicescript.json"), """{"scenes":7}""")
			LocalFileSystem.getInstance().refreshAndFindFileByNioFile(directory.resolve("choicescript.json"))
				?.refresh(false, false)
			assertFalse(ChoiceProjects.supports(project, scene))
		} finally {
			FileUtil.delete(directory.toFile())
		}
	}
}
