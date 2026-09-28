package dev.chinay.branchlight

import com.intellij.DynamicBundle
import org.jetbrains.annotations.Nls
import org.jetbrains.annotations.NonNls
import org.jetbrains.annotations.PropertyKey

@NonNls
private const val BUNDLE = "messages.BranchlightBundle"

internal object BranchlightBundle {
	private val bundle = DynamicBundle(BranchlightBundle::class.java, BUNDLE)

	@Nls
	fun message(@PropertyKey(resourceBundle = BUNDLE) key: String): String = bundle.getMessage(key)
}
