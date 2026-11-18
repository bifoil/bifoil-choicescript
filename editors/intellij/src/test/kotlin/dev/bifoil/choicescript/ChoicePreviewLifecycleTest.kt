package dev.bifoil.choicescript

import com.intellij.openapi.Disposable
import com.intellij.openapi.util.Disposer
import com.intellij.openapi.wm.ToolWindow
import com.intellij.testFramework.fixtures.BasePlatformTestCase
import com.intellij.ui.content.ContentFactory
import com.intellij.util.ui.UIUtil
import java.awt.BorderLayout
import java.lang.reflect.Proxy
import javax.swing.JButton
import javax.swing.JComponent
import javax.swing.JPanel

/** Real IDE content/disposal behavior with an owned Swing surface at the browser boundary. */
class ChoicePreviewLifecycleTest : BasePlatformTestCase() {
	fun testPreviewTabsPreserveOtherGamesAndRetireOnlyTheirOwnedPages() {
		val contents = ContentFactory.getInstance().createContentManager(false, project)
		Disposer.register(testRootDisposable, contents)
		var shows = 0
		val window = Proxy.newProxyInstance(
			ToolWindow::class.java.classLoader, arrayOf(ToolWindow::class.java)
		) { proxy, method, args ->
			when (method.name) {
				"getContentManager" -> contents
				"show" -> { shows++; null }
				"toString" -> "Owned preview test window"
				"hashCode" -> System.identityHashCode(proxy)
				"equals" -> proxy === args?.firstOrNull()
				else -> error("Unexpected preview host call: ${method.name}")
			}
		} as ToolWindow
		var available = false
		var embedded = false
		val opened = mutableListOf<String>()
		val disposed = mutableListOf<String>()
		val ui = object : ChoiceUi(project) {
			override fun toolWindow(): ToolWindow? = if (available) window else null
			override fun previewPage(url: String): Pair<JComponent, Disposable>? {
				if (!embedded) return null
				val lifetime = Disposer.newDisposable("Owned preview $url")
				Disposer.register(lifetime, Disposable { disposed.add(url) })
				return JPanel() to lifetime
			}
			override fun openInBrowser(url: String) { opened.add(url) }
		}
		assertNotNull(ui.console.component)
		try {
			ui.preview(JobResult("no-url", "first"))
			ui.preview(JobResult("no-window", "first", "http://127.0.0.1:1/no-window"))
			assertEquals(0, contents.contentCount)
			assertTrue(opened.isEmpty())
			available = true
			ui.preview(JobResult("fallback", "first", "http://127.0.0.1:1/fallback"))
			assertEquals(listOf("http://127.0.0.1:1/fallback"), opened)
			assertEquals(0, contents.contentCount)

			embedded = true
			val first = "http://127.0.0.1:1/first"
			val other = "http://127.0.0.1:1/other"
			val replacement = "http://127.0.0.1:1/replacement"
			ui.preview(JobResult("first-job", "first", first))
			val firstTab = checkNotNull(contents.selectedContent)
			val panel = firstTab.component as JPanel
			((panel.layout as BorderLayout).getLayoutComponent(BorderLayout.NORTH) as JButton).doClick()
			assertEquals(first, opened.last())
			ui.preview(JobResult("other-job", "other", other))
			val otherTab = checkNotNull(contents.selectedContent)
			assertEquals(2, contents.contentCount)
			ui.preview(JobResult("replacement-job", "first", replacement))
			val replacementTab = checkNotNull(contents.selectedContent)
			assertEquals(listOf(first), disposed)
			assertEquals(2, contents.contentCount)
			assertTrue(contents.contents.contains(otherTab))
			assertFalse(contents.contents.contains(firstTab))
			assertEquals(3, shows)

			ui.event(JobEvent("replacement-job", "first", "stale"))
			UIUtil.dispatchAllInvocationEvents()
			assertEquals(BifoilBundle.message("preview.source.changed.title"), replacementTab.displayName)
			ui.event(JobEvent("replacement-job", "first", "completed", exitCode = null))
			UIUtil.dispatchAllInvocationEvents()
			assertEquals(listOf(first, replacement), disposed)
			assertEquals(1, contents.contentCount)
			assertSame(otherTab, contents.getContent(0))

			// A queued exit must not clear a replacement session's tabs.
			val retired = ui.sessionStarted()
			ui.sessionEnded(retired)
			val current = ui.sessionStarted()
			UIUtil.dispatchAllInvocationEvents()
			assertEquals(1, contents.contentCount)
			ui.sessionEnded(current)
			UIUtil.dispatchAllInvocationEvents()
			assertEquals(0, contents.contentCount)
			assertEquals(listOf(first, replacement, other), disposed)
		} finally {
			Disposer.dispose(ui)
		}
	}
}
