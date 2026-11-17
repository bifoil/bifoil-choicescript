package dev.bifoil.choicescript

import com.intellij.openapi.editor.EditorFactory
import com.intellij.openapi.editor.ex.EditorEx
import com.intellij.openapi.fileEditor.FileDocumentManager
import com.intellij.openapi.util.Disposer
import com.intellij.openapi.util.io.FileUtil
import com.intellij.openapi.vfs.LocalFileSystem
import com.intellij.testFramework.fixtures.BasePlatformTestCase
import com.intellij.util.ui.UIUtil
import java.awt.Dimension
import java.nio.file.Files
import java.util.concurrent.CompletableFuture
import java.util.concurrent.TimeUnit

/** Viewport and asynchronous lifecycle boundaries retain only current, owned decorations. */
class ChoiceCoverageBoundaryTest : BasePlatformTestCase() {
	fun testCoverageBoundsShortResultsHiddenEditorsAndLateEvents() {
		val directory = Files.createTempDirectory("bifoil coverage boundaries Ω ")
		val scenes = Files.createDirectories(directory.resolve("scenes"))
		val factory = EditorFactory.getInstance()
		val coverage = ChoiceCoverage(project)
		val editors = mutableListOf<EditorEx>()

		fun editor(name: String): EditorEx {
			val source = scenes.resolve(name)
			Files.writeString(source, "First original line.\nSecond original line.\nThird original line.")
			val file = LocalFileSystem.getInstance().refreshAndFindFileByNioFile(source)!!
			val document = FileDocumentManager.getInstance().getDocument(file)!!
			val result = factory.createEditor(document, project, ChoiceFileType, false) as EditorEx
			result.component.setSize(500, 300)
			result.scrollPane.setSize(500, 300)
			result.scrollPane.doLayout()
			result.scrollPane.viewport.extentSize = Dimension(500, 240)
			editors.add(result)
			return result
		}

		fun rows(editor: EditorEx): List<Int> = editor.markupModel.allHighlighters
			.filter { it.textAttributesKey == ChoiceColors.coverage }
			.map { editor.document.getLineNumber(it.startOffset) }.sorted()

		fun counts(id: String, values: List<Long>) {
			coverage.event(JobEvent(id, "original", "started"))
			coverage.event(JobEvent(id, "original", "coverage", coverage = mapOf("startup" to values)))
		}

		try {
			val scene = editor("startup.txt")
			val unrelated = editor("notes.md")
			coverage.projectsChanged(listOf(GameProject(
				id = "original", root = directory.toString(), sceneDir = scenes.toString(), assetDir = directory.toString()
			)))
			counts("partial", listOf(1, 0, 2))
			assertEquals(listOf(0, 2), rows(scene))
			assertTrue(rows(unrelated).isEmpty())
			counts("short", listOf(1))
			assertEquals(listOf(0), rows(scene))
			counts("long", List(30) { 1L })
			assertEquals(listOf(0, 1, 2), rows(scene))
			counts("zero", List(3) { 0L })
			assertTrue(rows(scene).isEmpty())
			scene.scrollPane.viewport.extentSize = Dimension(500, 0)
			counts("hidden", List(3) { 1L })
			assertTrue(rows(scene).isEmpty())
			scene.scrollPane.viewport.extentSize = Dimension(500, 240)
			CompletableFuture.runAsync { counts("background", listOf(1, 0, 1)) }.get(5, TimeUnit.SECONDS)
			UIUtil.dispatchAllInvocationEvents()
			assertEquals(listOf(0, 2), rows(scene))

			val closing = editor("closing.txt")
			factory.releaseEditor(closing)
			editors.remove(closing)
			UIUtil.dispatchAllInvocationEvents()
			assertTrue(closing.isDisposed)

			CompletableFuture.runAsync { counts("late", List(3) { 9L }) }.get(5, TimeUnit.SECONDS)
			Disposer.dispose(coverage)
			UIUtil.dispatchAllInvocationEvents()
			assertTrue(rows(scene).isEmpty())
			coverage.projectsChanged(emptyList())
			counts("disposed", List(3) { 7L })
			assertTrue(rows(scene).isEmpty())
		} finally {
			if (!Disposer.isDisposed(coverage)) Disposer.dispose(coverage)
			for (editor in editors) factory.releaseEditor(editor)
			FileUtil.delete(directory.toFile())
		}
	}
}
