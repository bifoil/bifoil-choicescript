package dev.bifoil.choicescript

import com.intellij.openapi.util.io.FileUtil
import com.intellij.platform.eel.fs.EelFiles
import junit.framework.TestCase
import java.nio.file.Files
import java.nio.file.Path

/** Extract actual packaged resources into an isolated cache, independent of previous IDE runs. */
class ChoiceRuntimeTest : TestCase() {
	fun testFreshExtractionWritesReadyOnlyAfterCompleteHostResources() {
		val cache = Files.createTempDirectory("bifoil runtime cache Ω ")
		try {
			val root = BundledRuntime.directory(cache)
			assertTrue(root.startsWith(cache))
			assertEquals("verified", EelFiles.readString(root.resolve("ready")))
			val node = Path.of(BundledRuntime.node(root))
			val native = Path.of(BundledRuntime.languageServer(root))
			assertTrue(Files.size(node) > 1_000_000)
			assertTrue(Files.size(native) > 1_000_000)
			assertTrue(Files.isRegularFile(root.resolve("server/tool-broker.cjs")))
			val modified = Files.getLastModifiedTime(node)
			assertEquals(root, BundledRuntime.directory(cache))
			assertEquals("A ready cache was extracted twice", modified, Files.getLastModifiedTime(node))
		} finally {
			assertTrue("Owned isolated cache was not released", FileUtil.delete(cache.toFile()))
		}
	}
}
