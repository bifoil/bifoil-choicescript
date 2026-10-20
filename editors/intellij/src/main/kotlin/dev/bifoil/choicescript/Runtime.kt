package dev.bifoil.choicescript

import com.google.gson.JsonParser
import com.intellij.openapi.application.PathManager
import com.intellij.openapi.util.SystemInfo
import java.io.FilterInputStream
import java.io.InputStream
import java.io.OutputStream
import java.net.URI
import java.nio.file.Files
import java.nio.file.Path
import java.security.DigestInputStream
import java.security.MessageDigest
import java.util.jar.JarFile
import java.util.zip.ZipInputStream

/**
 * Extract the packaged server and current host's Node runtime into the IDE system cache.
 * Archive hashes come from the bundle manifest; the manifest digest namespaces the cache.
 * A ready marker avoids repeat extraction, so this is not per-launch verification of
 * every extracted file. The plugin does not download a replacement runtime at startup.
 */
object BundledRuntime {
	private fun digest(bytes: ByteArray) =
		MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }

	/**
	 * Open a bundled resource as a stream. The returned stream owns its JarFile handle;
	 * closing it must close both. Avoid classloader whole-archive direct-buffer allocation.
	 */
	private fun resource(name: String): InputStream {
		val url = checkNotNull(javaClass.getResource("/bundle/$name")) {
			"Missing packaged resource $name. Run pnpm package:intellij before building the plugin."
		}

		if (url.protocol == "file") return Files.newInputStream(Path.of(url.toURI()))
		if (url.protocol != "jar") return url.openStream()

		// Read directly from the JAR: the IDE classloader otherwise materializes the entire archive in a direct buffer.
		val separator = url.file.lastIndexOf("!/")
		check(separator >= 0) { "Invalid packaged resource URL" }

		val archive = JarFile(Path.of(URI(url.file.substring(0, separator))).toFile())
		return try {
			val entry = checkNotNull(archive.getJarEntry("bundle/$name")) { "Missing packaged resource $name" }
			object : FilterInputStream(archive.getInputStream(entry)) {
				override fun close() = archive.use { super.close() }
			}
		} catch (error: Throwable) {
			archive.close()
			throw error
		}
	}

	private fun verify(name: String, expected: String) {
		val hash = MessageDigest.getInstance("SHA-256")
		resource(name).use { input ->
			DigestInputStream(input, hash).use { it.copyTo(OutputStream.nullOutputStream()) }
		}

		check(hash.digest().joinToString("") { "%02x".format(it) } == expected) {
			"Packaged runtime checksum mismatch: $name"
		}
	}

	/**
	 * Return a ready host bundle, or verify/extract one under the manifest-specific cache.
	 * The cache root can be supplied by a host or isolated verification fixture.
	 * Reject archive entries outside their destination. The ready marker is written only
	 * after both archives extract; an interrupted attempt must not be treated as ready.
	 */
	@Synchronized
	fun directory(cacheRoot: Path = Path.of(PathManager.getSystemPath())): Path {
		val manifestBytes = resource("manifest.json").use { it.readBytes() }
		val manifest = JsonParser.parseString(manifestBytes.toString(Charsets.UTF_8)).asJsonObject
		val platform = if (SystemInfo.isWindows) "win32" else if (SystemInfo.isMac) "darwin" else "linux"
		val arch = if (System.getProperty("os.arch") in listOf("aarch64", "arm64")) "arm64" else "x64"
		val target = Path.of(
			cacheRoot.toString(), "bifoil-choicescript", digest("native-layout-2".toByteArray() + manifestBytes).take(20), "$platform-$arch"
		)

		if (Files.exists(target.resolve("ready"))) return target

		Files.createDirectories(target)

		for ((name, folder) in listOf("server.zip" to "server", "node-$platform-$arch.zip" to "runtime")) {
			verify(name, manifest.get(name).asString)

			val output = target.resolve(folder)
			Files.createDirectories(output)
			ZipInputStream(resource(name)).use { zip ->
				var entry = zip.nextEntry

				while (entry != null) {
					var file = output.resolve(entry.name).normalize()
					check(file.startsWith(output)) { "Invalid runtime archive path" }

					if (name == "server.zip" && entry.name.startsWith("native/")) {
						val host = "native/$platform-$arch/"
						if (!entry.name.startsWith(host)) {
							entry = zip.nextEntry
							continue
						}
						val executable = if (SystemInfo.isWindows) "bifoil-language-server.exe" else "bifoil-language-server"
						// Keep the executable as short as the bundled Node path. Windows
						// CreateProcess can reject a valid NIO path beyond 260 characters.
						if (entry.name == host + executable) file = Path.of(languageServer(target))
					}

					if (entry.isDirectory) Files.createDirectories(file) else {
						Files.createDirectories(file.parent)
						Files.newOutputStream(file).use { zip.copyTo(it) }
					}

					entry = zip.nextEntry
				}
			}
		}

		if (!SystemInfo.isWindows) {
			check(target.resolve("runtime/node").toFile().setExecutable(true))
			check(Path.of(languageServer(target)).toFile().setExecutable(true))
		}
		Files.writeString(target.resolve("ready"), "verified")

		return target
	}

	/**
	 * Resolve the platform-specific executable inside a prepared bundle; this does not provision or verify it.
	 */
	fun languageServer(root: Path): String =
		root.resolve(if (SystemInfo.isWindows) "runtime/lsp.exe" else "runtime/lsp").toString()

	fun node(root: Path) = root.resolve(if (SystemInfo.isWindows) "runtime/node.exe" else "runtime/node").toString()
}
