package dev.chira.choicescripttools

import com.google.gson.JsonParser
import com.intellij.lang.Language
import com.intellij.psi.LanguageSubstitutor
import com.intellij.openapi.fileTypes.LanguageFileType
import com.intellij.openapi.project.Project
import com.intellij.openapi.vfs.VirtualFile
import com.intellij.icons.AllIcons
import javax.swing.Icon

object ChoiceLanguage : Language("ChoiceScript")
object ChoiceFileType : LanguageFileType(ChoiceLanguage) {
    override fun getName() = "ChoiceScript"
    override fun getDescription() = "ChoiceScript scene (unofficial tools)"
    override fun getDefaultExtension() = "txt"
    override fun getIcon(): Icon = AllIcons.FileTypes.Text
}
object ChoiceProjects {
    fun supports(project: Project, file: VirtualFile): Boolean {
        if (file.extension != "txt") return false
        var directory = file.parent
        while (directory != null) {
            if (directory.findChild("startup.txt") != null) return true
            val config = directory.findChild("choicescript.json")
            if (config != null) {
                return runCatching {
                    val scenes = JsonParser.parseString(String(config.contentsToByteArray(), Charsets.UTF_8)).asJsonObject.get("scenes")?.asString ?: "scenes"
                    val root = directory!!.toNioPath().resolve(scenes).normalize()
                    file.toNioPath().startsWith(root)
                }.getOrDefault(false)
            }
            if (directory.path == project.basePath) break
            directory = directory.parent
        }
        return file.fileType == ChoiceFileType
    }
}
class ChoiceSubstitutor : LanguageSubstitutor() {
    override fun getLanguage(file: VirtualFile, project: Project): Language? = if (ChoiceProjects.supports(project, file)) ChoiceLanguage else null
}
