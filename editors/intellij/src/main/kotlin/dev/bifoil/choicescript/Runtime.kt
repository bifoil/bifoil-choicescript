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

object BundledRuntime {
	private fun digest(bytes: ByteArray) =
		MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }

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

	@Synchronized
	fun directory(): Path {
		val manifestBytes = resource("manifest.json").use { it.readBytes() }
		val manifest = JsonParser.parseString(manifestBytes.toString(Charsets.UTF_8)).asJsonObject
		val platform = if (SystemInfo.isWindows) "win32" else if (SystemInfo.isMac) "darwin" else "linux"
		val arch = if (System.getProperty("os.arch") in listOf("aarch64", "arm64")) "arm64" else "x64"
		val target = Path.of(
			PathManager.getSystemPath(), "bifoil-choicescript", digest(manifestBytes).take(20), "$platform-$arch"
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
					val file = output.resolve(entry.name).normalize()
					check(file.startsWith(output)) { "Invalid runtime archive path" }
					if (entry.isDirectory) Files.createDirectories(file) else {
						Files.createDirectories(file.parent)
						Files.newOutputStream(file).use { zip.copyTo(it) }
					}
					entry = zip.nextEntry
				}
			}
		}
		if (!SystemInfo.isWindows) check(target.resolve("runtime/node").toFile().setExecutable(true))
		Files.writeString(target.resolve("ready"), "verified")
		return target
	}

	fun node(root: Path) = root.resolve(if (SystemInfo.isWindows) "runtime/node.exe" else "runtime/node").toString()
}
