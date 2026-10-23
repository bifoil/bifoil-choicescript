package dev.bifoil.choicescript

import com.intellij.openapi.command.WriteCommandAction
import com.intellij.openapi.components.service
import com.intellij.openapi.editor.EditorFactory
import com.intellij.openapi.editor.ex.EditorEx
import com.intellij.openapi.fileEditor.FileDocumentManager
import com.intellij.openapi.util.io.FileUtil
import com.intellij.openapi.vfs.LocalFileSystem
import com.intellij.testFramework.fixtures.BasePlatformTestCase
import java.awt.Dimension
import java.nio.file.Files

/** Verify actual viewport markers, including folded rows and stale native results. */
class ChoiceCoverageTest : BasePlatformTestCase() {
	fun testCoverageUsesVisibleLogicalRowsAndCannotRestoreStaleMarkers() {
		val directory = Files.createTempDirectory("bifoil coverage viewport Ω ")
		val scenes = Files.createDirectories(directory.resolve("scenes"))
		val source = scenes.resolve("startup.txt")
		Files.writeString(source, (0 until 200).joinToString("\n") { "Original row $it." })
		val file = LocalFileSystem.getInstance().refreshAndFindFileByNioFile(source)!!
		val document = FileDocumentManager.getInstance().getDocument(file)!!
		val coverage = project.service<ChoiceCoverage>()
		val editor = EditorFactory.getInstance().createEditor(document, project, ChoiceFileType, false) as EditorEx
		try {
			editor.component.setSize(500, 300)
			editor.scrollPane.setSize(500, 300)
			editor.scrollPane.doLayout()
			editor.scrollPane.viewport.extentSize = Dimension(500, 240)
			editor.foldingModel.runBatchFoldingOperation {
				editor.foldingModel.addFoldRegion(
					document.getLineStartOffset(5), document.getLineStartOffset(180), "…"
				)!!.isExpanded = false
			}
			val game = GameProject(
				id = "original",
				root = directory.toString(),
				sceneDir = scenes.toString(),
				assetDir = directory.toString()
			)
			coverage.projectsChanged(listOf(game))
			coverage.event(JobEvent("first", game.id, "started"))
			coverage.event(JobEvent("first", game.id, "coverage", coverage = mapOf("STARTUP" to List(200) { 1L })))
			val markers = editor.markupModel.allHighlighters.filter { it.textAttributesKey == ChoiceColors.coverage }
			assertTrue("No native coverage markers", markers.isNotEmpty())
			assertTrue("Allocated markers outside the viewport", markers.size < 30)
			for (marker in markers) {
				val row = document.getLineNumber(marker.startOffset)
				assertTrue("Folded rows received markers: $row", row !in 6..<180)
				assertNotNull(marker.errorStripeTooltip)
			}
			WriteCommandAction.runWriteCommandAction(project) { document.insertString(0, "Changed ") }
			assertTrue(editor.markupModel.allHighlighters.none { it.textAttributesKey == ChoiceColors.coverage })
			coverage.event(JobEvent("first", game.id, "coverage", coverage = mapOf("startup" to List(200) { 99L })))
			assertTrue(
				"Late coverage revived stale markers",
				editor.markupModel.allHighlighters.none { it.textAttributesKey == ChoiceColors.coverage })
			coverage.sessionEnded()
			coverage.projectsChanged(emptyList())
		} finally {
			EditorFactory.getInstance().releaseEditor(editor)
			FileUtil.delete(directory.toFile())
		}
	}
}
