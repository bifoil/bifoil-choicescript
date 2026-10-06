package dev.bifoil.choicescript

import com.intellij.DynamicBundle
import org.jetbrains.annotations.Nls
import org.jetbrains.annotations.NonNls
import org.jetbrains.annotations.PropertyKey

@NonNls
private const val BUNDLE = "messages.BifoilBundle"

internal object BifoilBundle {
	private val bundle = DynamicBundle(BifoilBundle::class.java, BUNDLE)

	@Nls
	fun message(@PropertyKey(resourceBundle = BUNDLE) key: String): String = bundle.getMessage(key)
}
