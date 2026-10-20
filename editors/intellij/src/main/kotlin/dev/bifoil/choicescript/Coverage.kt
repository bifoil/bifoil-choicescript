package dev.bifoil.choicescript

import com.intellij.openapi.Disposable
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.components.Service
import com.intellij.openapi.editor.Editor
import com.intellij.openapi.editor.EditorFactory
import com.intellij.openapi.editor.event.DocumentEvent
import com.intellij.openapi.editor.event.DocumentListener
import com.intellij.openapi.editor.event.EditorFactoryEvent
import com.intellij.openapi.editor.event.EditorFactoryListener
import com.intellij.openapi.editor.markup.HighlighterLayer
import com.intellij.openapi.editor.markup.RangeHighlighter
import com.intellij.openapi.fileEditor.FileDocumentManager
import com.intellij.openapi.project.Project
import com.intellij.openapi.vfs.StandardFileSystems
import java.awt.Point
import java.nio.file.Path

/**
 * Latest-job coverage state mirrored from the shared TypeScript store.
 * Not thread-safe: [ChoiceCoverage] confines mutations to the EDT. Late events from an
 * older job cannot revive decorations after a new start or source invalidation.
 */
internal class CoverageStore {
	private data class Result(val jobId: String, var stale: Boolean, var coverage: Map<String, List<Long>> = emptyMap())

	private val results = mutableMapOf<String, Result>()

	/**
	 * Accept an event for the current job and report whether decorations need refreshing; incoming counts are copied.
	 */
	fun update(event: JobEvent): Boolean {
		if (event.kind == "started") {
			results[event.projectId] = Result(event.jobId, event.stale)
			return true
		}

		val result = results[event.projectId] ?: return false
		if (result.jobId != event.jobId) return false

		if (event.kind == "stale" || event.stale || (event.kind == "completed" && event.exitCode != 0)) {
			invalidate(event.projectId)
			return true
		}

		if (event.kind != "coverage" || event.coverage == null || result.stale) return false

		result.coverage = event.coverage.mapKeys { it.key.lowercase() }.mapValues { it.value.toList() }
		return true
	}

	/** Mark the source stale, returning whether any visible coverage could have changed. */
	fun invalidate(projectId: String): Boolean {
		val result = results[projectId] ?: return false
		val changed = result.coverage.isNotEmpty()
		result.stale = true
		result.coverage = emptyMap()
		return changed
	}

	fun retain(projectIds: Set<String>) {
		results.keys.retainAll(projectIds)
	}

	fun counts(projectId: String, scene: String): List<Long> =
		results[projectId]?.coverage?.get(scene.lowercase()).orEmpty()
}

/**
 * Own project coverage and its editor highlighters. Notification entry points marshal to
 * the EDT and disposal removes owned markers. Project discovery must reach projectsChanged
 * before scene counts can be associated with files; native transport is part of the contract.
 */
@Service(Service.Level.PROJECT)
class ChoiceCoverage(private val project: Project) : Disposable, EditorFactoryListener {
	private var disposed = false
	private val results = CoverageStore()
	private var games = emptyList<GameProject>()
	private val highlights = mutableMapOf<Editor, List<RangeHighlighter>>()
	private val factory = EditorFactory.getInstance()

	init {
		factory.addEditorFactoryListener(this, this)
		factory.eventMulticaster.addVisibleAreaListener({ event ->
			val editor = event.editor
			if (editor.project == project) onEdt { if (!editor.isDisposed) render(editor) }
		}, this)
		factory.eventMulticaster.addDocumentListener(object : DocumentListener {
			override fun documentChanged(event: DocumentEvent) {
				val file = FileDocumentManager.getInstance().getFile(event.document) ?: return
				if (file.fileSystem.protocol != StandardFileSystems.FILE_PROTOCOL) return

				val filePath = file.toNioPath()
				onEdt {
					val game = gameFor(filePath)
					val changed = game?.let { results.invalidate(it.id) } ?: false

					if (game == null && games.any {
							filePath.startsWith(Path.of(it.assetDir))
						}) {
						request(project, { server ->
							server.assetChanged(mapOf("uri" to filePath.toUri().toString()))
							java.util.concurrent.CompletableFuture.completedFuture(Unit)
						})
					}

					if (changed) refresh()
				}
			}
		}, this)
	}

	/**
	 * Schedule state/UI work only while this service and its project remain live.
	 */
	private fun onEdt(action: () -> Unit) {
		val app = ApplicationManager.getApplication()

		if (app.isDispatchThread) {
			if (!disposed && !project.isDisposed) action()
		} else app.invokeLater { if (!disposed && !project.isDisposed) action() }
	}

	fun projectsChanged(projects: List<GameProject>) = onEdt {
		games = projects
		results.retain(projects.map { it.id }.toSet())
		refresh()
	}

	fun sessionEnded() = onEdt {
		results.retain(emptySet())
		refresh()
	}

	fun event(event: JobEvent) = onEdt {
		if (results.update(event)) refresh()
	}

	private fun gameFor(file: Path) =
		games.firstOrNull { file.normalize().startsWith(Path.of(it.sceneDir).normalize()) }

	private fun refresh() {
		for (editor in factory.allEditors) if (editor.project == project && !editor.isDisposed) render(editor)
	}

	/**
	 * Replace this editor's owned markers from current line counts.
	 * Keep complete coverage in the store while bounding EDT marker work to visible
	 * visual rows. Sampling visual positions also skips collapsed logical line ranges.
	 */
	private fun render(editor: Editor) {
		highlights.remove(editor)?.forEach { it.dispose() }

		val file = FileDocumentManager.getInstance().getFile(editor.document) ?: return

		if (file.fileSystem.protocol != StandardFileSystems.FILE_PROTOCOL) return

		if (!file.name.endsWith(".txt", ignoreCase = true)) return

		val filePath = file.toNioPath()
		val game = gameFor(filePath) ?: return

		val relative = Path.of(game.sceneDir).normalize().relativize(filePath.normalize()).toString().replace('\\', '/')
		val counts = results.counts(game.id, relative.dropLast(4))
		// No coverage means no viewport or layout work, including for hidden editors.
		if (counts.isEmpty()) return
		val visible = editor.scrollingModel.visibleArea
		val height = editor.lineHeight.coerceAtLeast(1)
		val rows = mutableSetOf<Int>()
		if (visible.height > 0 && counts.isNotEmpty()) {
			val bottom = visible.y + visible.height + height
			for (y in (visible.y - height).coerceAtLeast(0)..bottom step height) {
				val line = editor.xyToLogicalPosition(Point(visible.x, y)).line
				if (line < counts.size && line < editor.document.lineCount && counts[line] > 0) rows.add(line)
			}
		}
		highlights[editor] = rows.map { line ->
			editor.markupModel.addLineHighlighter(ChoiceColors.coverage, line, HighlighterLayer.ADDITIONAL_SYNTAX)
				.apply { errorStripeTooltip = BifoilBundle.message("coverage.line.executions", counts[line]) }
		}
	}

	override fun editorCreated(event: EditorFactoryEvent) {
		val editor = event.editor

		if (editor.project == project) ApplicationManager.getApplication().invokeLater {
			if (!disposed && !project.isDisposed && !editor.isDisposed) render(editor)
		}
	}

	override fun editorReleased(event: EditorFactoryEvent) {
		highlights.remove(event.editor)?.forEach { it.dispose() }
	}

	override fun dispose() {
		disposed = true
		highlights.values.flatten().forEach { it.dispose() }
		highlights.clear()
	}
}
