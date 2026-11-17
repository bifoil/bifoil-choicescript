package dev.bifoil.choicescript

import com.google.gson.Gson
import com.intellij.openapi.util.SystemInfo
import com.intellij.openapi.util.io.FileUtil
import junit.framework.TestCase
import java.io.ByteArrayOutputStream
import java.lang.reflect.InvocationTargetException
import java.net.URL
import java.net.URLClassLoader
import java.nio.file.Files
import java.nio.file.Path
import java.security.MessageDigest
import java.util.jar.JarEntry
import java.util.jar.JarOutputStream
import java.util.zip.ZipEntry
import java.util.zip.ZipOutputStream

/** Load the unchanged runtime extractor against small original JAR resources. */
class ChoiceArchiveContractsTest : TestCase() {
	private fun sha(bytes: ByteArray) = MessageDigest.getInstance("SHA-256").digest(bytes)
		.joinToString("") { "%02x".format(it) }

	private fun zip(files: Map<String, String>): ByteArray {
		val output = ByteArrayOutputStream()
		ZipOutputStream(output).use { archive ->
			for ((name, contents) in files) {
				archive.putNextEntry(ZipEntry(name))
				archive.write(contents.toByteArray())
				archive.closeEntry()
			}
		}
		return output.toByteArray()
	}

	private fun withBundle(mode: String, body: (Path, () -> Path) -> Unit) {
		val root = Files.createTempDirectory("bifoil original archive contract ")
		val platform = if (SystemInfo.isWindows) "win32" else if (SystemInfo.isMac) "darwin" else "linux"
		val arch = if (System.getProperty("os.arch") in listOf("aarch64", "arm64")) "arm64" else "x64"
		val target = "$platform-$arch"
		val executable = if (SystemInfo.isWindows) "bifoil-language-server.exe" else "bifoil-language-server"
		val node = if (SystemInfo.isWindows) "node.exe" else "node"
		val server = zip(if (mode == "traversal") mapOf("../escaped.txt" to "must stay inside archive") else mapOf(
			"nested/" to "",
			"nested/worker.cjs" to "Original worker",
			"native/$target/$executable" to "Original native executable",
			"native/$target/manifest.json" to "Original manifest",
			"native/other-target/ignored" to "Other platform"
		))
		val runtime = zip(mapOf(node to "Original runtime"))
		val manifest = Gson().toJson(mapOf(
			"server.zip" to if (mode == "checksum") "0".repeat(64) else sha(server),
			"node-$target.zip" to sha(runtime)
		)).toByteArray()
		val bundle = root.resolve("original.jar")
		JarOutputStream(Files.newOutputStream(bundle)).use { jar ->
			for ((name, bytes) in mapOf("manifest.json" to manifest, "server.zip" to server, "node-$target.zip" to runtime)) {
				if (mode == "missing-entry" && name == "server.zip") continue
				jar.putNextEntry(JarEntry("bundle/$name"))
				jar.write(bytes)
				jar.closeEntry()
			}
		}
		val original = BundledRuntime::class.java
		val loader = object : URLClassLoader(emptyArray(), original.classLoader) {
			override fun loadClass(name: String, resolve: Boolean): Class<*> {
				if (!name.startsWith(original.name)) return super.loadClass(name, resolve)
				val found = findLoadedClass(name) ?: run {
					val resource = name.replace('.', '/') + ".class"
					val bytes = checkNotNull(original.classLoader.getResourceAsStream(resource)).use { it.readBytes() }
					defineClass(name, bytes, 0, bytes.size)
				}
				if (resolve) resolveClass(found)
				return found
			}
			override fun getResource(name: String): URL? {
				if (!name.startsWith("bundle/")) return super.getResource(name)
				if (mode == "missing-manifest" && name == "bundle/manifest.json") return null
				return URL("jar:${bundle.toUri()}!/$name")
			}
		}
		try {
			val type = loader.loadClass(original.name)
			val instance = type.getField("INSTANCE").get(null)
			val directory = type.getMethod("directory", Path::class.java)
			body(root) {
				try {
					directory.invoke(instance, root.resolve("cache")) as Path
				} catch (error: InvocationTargetException) {
					throw error.targetException
				}
			}
		} finally {
			loader.close()
			assertTrue("Owned archive resources remained open", FileUtil.delete(root.toFile()))
		}
	}

	fun testJarExtractionKeepsOnlyHostArtifactsAndClosesResourceHandles() {
		withBundle("valid") { _, extract ->
			val result = extract()
			assertEquals("verified", Files.readString(result.resolve("ready")))
			assertEquals("Original native executable", Files.readString(Path.of(BundledRuntime.languageServer(result))))
			assertEquals("Original runtime", Files.readString(Path.of(BundledRuntime.node(result))))
			assertFalse(Files.exists(result.resolve("server/native/other-target")))
			assertEquals(result, extract())
		}
	}

	fun testMalformedResourcesCannotWriteReadyOrEscapeTheirCache() {
		for ((mode, expected) in listOf(
			"checksum" to "checksum mismatch",
			"traversal" to "Invalid runtime archive path",
			"missing-entry" to "Missing packaged resource",
			"missing-manifest" to "Missing packaged resource"
		)) {
			withBundle(mode) { root, extract ->
				try {
					extract()
					fail("Invalid archive was accepted: $mode")
				} catch (error: IllegalStateException) {
					assertTrue(error.message.orEmpty().contains(expected))
				}
				Files.walk(root).use { paths -> assertFalse(paths.anyMatch { it.fileName.toString() == "ready" }) }
				assertFalse(Files.exists(root.resolve("escaped.txt")))
			}
		}
	}
}
