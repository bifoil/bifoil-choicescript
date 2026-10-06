package dev.bifoil.choicescript

import com.google.gson.JsonParser
import com.intellij.icons.AllIcons.FileTypes
import com.intellij.lang.Language
import com.intellij.openapi.fileTypes.LanguageFileType
import com.intellij.openapi.project.Project
import com.intellij.openapi.vfs.VirtualFile
import com.intellij.psi.LanguageSubstitutor
import java.nio.file.Files
import java.nio.file.Path
import javax.swing.Icon

/**
 * Stable native language identity used by substitution, PSI, templates, and highlighting.
 */
object ChoiceLanguage : Language("ChoiceScript") {
	private fun readResolve(): Any = ChoiceLanguage
}

/**
 * Scene file type for explicit selection and project-aware substitution.
 * Its txt extension is not permission to associate every plain-text file globally.
 */
object ChoiceFileType : LanguageFileType(ChoiceLanguage) {
	override fun getName() = "ChoiceScript"

	override fun getDescription() = "ChoiceScript scene (unofficial tools)"

	override fun getDefaultExtension() = "txt"

	override fun getIcon(): Icon = FileTypes.Text
}

/**
 * Lightweight native recognition needed before a server connection exists.
 * Walks ancestors for startup/configuration and respects explicit ChoiceFileType selection.
 * This gate is not the authoritative server project inventory or its full config validator.
 */
object ChoiceProjects {
	/**
	 * Return whether this local text file should use ChoiceScript services; malformed configuration fails recognition.
	 */
	fun supports(project: Project, file: VirtualFile): Boolean {
		if (!file.extension.equals("txt", ignoreCase = true)) return false

		var directory = file.parent

		while (directory != null) {
			if (directory.findChild("startup.txt")?.isDirectory == false) return true

			val config = directory.findChild("choicescript.json")

			if (config != null) {
				return runCatching {
					val settings = JsonParser.parseString(
						String(config.contentsToByteArray(), Charsets.UTF_8)
					).asJsonObject

					val configuredScenes = settings.get("scenes")
					check(
						configuredScenes == null || (configuredScenes.isJsonPrimitive && configuredScenes.asJsonPrimitive.isString)
					) { "Scenes must be a relative directory." }

					val scenes = Path.of(configuredScenes?.asString ?: "scenes")
					check(!scenes.isAbsolute) { "Scenes must be a relative directory." }

					val root = directory.toNioPath().resolve(scenes).normalize()
					Files.isRegularFile(root.resolve("startup.txt")) && file.toNioPath().startsWith(root)
				}.getOrDefault(false)
			}

			if (directory.path == project.basePath) break
			directory = directory.parent
		}

		return file.fileType == ChoiceFileType
	}
}

/**
 * Substitute ChoiceScript only for recognized scene files instead of globally registering all .txt files.
 */
class ChoiceSubstitutor : LanguageSubstitutor() {
	override fun getLanguage(file: VirtualFile, project: Project): Language? =
		if (ChoiceProjects.supports(project, file)) ChoiceLanguage else null
}
