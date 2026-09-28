package dev.chinay.branchlight

import com.google.gson.JsonParser
import com.intellij.openapi.application.PathManager
import com.intellij.openapi.util.SystemInfo
import java.nio.file.Files
import java.nio.file.Path
import java.security.MessageDigest
import java.util.zip.ZipInputStream

object BundledRuntime {
    private fun digest(bytes: ByteArray) = MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }
    private fun resource(name: String) = checkNotNull(javaClass.getResourceAsStream("/bundle/$name")) { "Missing packaged resource $name. Run pnpm package:intellij before building the plugin." }.use { it.readBytes() }
    @Synchronized fun directory(): Path {
        val manifestBytes = resource("manifest.json")
        val manifest = JsonParser.parseString(manifestBytes.toString(Charsets.UTF_8)).asJsonObject
        val platform = if (SystemInfo.isWindows) "win32" else if (SystemInfo.isMac) "darwin" else "linux"
        val arch = if (System.getProperty("os.arch") in listOf("aarch64", "arm64")) "arm64" else "x64"
        val target = Path.of(PathManager.getSystemPath(), "branchlight", digest(manifestBytes).take(20), "$platform-$arch")
        if (Files.exists(target.resolve("ready"))) return target
        Files.createDirectories(target)
        for ((name, folder) in listOf("server.zip" to "server", "node-$platform-$arch.zip" to "runtime")) {
            val bytes = resource(name)
            check(digest(bytes) == manifest.get(name).asString) { "Packaged runtime checksum mismatch: $name" }
            val output = target.resolve(folder)
            Files.createDirectories(output)
            ZipInputStream(bytes.inputStream()).use { zip ->
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
