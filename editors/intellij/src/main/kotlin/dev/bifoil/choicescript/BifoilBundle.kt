package dev.bifoil.choicescript

import com.intellij.DynamicBundle
import org.jetbrains.annotations.Nls
import org.jetbrains.annotations.NonNls
import org.jetbrains.annotations.PropertyKey

@NonNls
private const val BUNDLE = "messages.BifoilBundle"

/** Localized adapter messages; keep UI labels and live-template descriptions in the resource bundle. */
internal object BifoilBundle {
	private val bundle = DynamicBundle(BifoilBundle::class.java, BUNDLE)

	@Nls
	fun message(@PropertyKey(resourceBundle = BUNDLE) key: String, vararg params: Any): String =
		bundle.getMessage(key, *params)
}
