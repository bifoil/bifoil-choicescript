package dev.bifoil.choicescript

import com.intellij.openapi.ui.InputValidatorEx

/** JSON numbers must remain exact in the shared JavaScript runtime. */
internal object RandomTestInput {
	const val MAX_SEED = 9_007_199_254_740_991L
	const val MAX_ITERATIONS = 10_000_000

	fun seed(text: String): Long? =
		text.takeIf { it.matches(Regex("-?[0-9]+")) }?.toLongOrNull()?.takeIf { it in -MAX_SEED..MAX_SEED }

	fun iterations(text: String): Int? =
		text.takeIf { it.matches(Regex("[0-9]+")) }?.toIntOrNull()?.takeIf { it in 1..MAX_ITERATIONS }

	/**
	 * Check the last seeded iteration after seed/count have individually been validated.
	 * This helper alone does not validate either operand's range.
	 */
	fun validRange(seed: Long, iterations: Int) = seed <= MAX_SEED - (iterations - 1L)

	fun seedValidator(iterations: Int) = object : InputValidatorEx {
		override fun getErrorText(inputString: String): String? = seed(inputString).let { seed ->
			if (seed == null) BifoilBundle.message("randomtest.seed.error")
			else if (!validRange(seed, iterations)) BifoilBundle.message("randomtest.seed.range.error") else null
		}

		override fun checkInput(inputString: String) = getErrorText(inputString) == null

		override fun canClose(inputString: String) = checkInput(inputString)
	}

	val iterationsValidator = object : InputValidatorEx {
		override fun getErrorText(inputString: String): String? =
			if (iterations(inputString) == null) BifoilBundle.message("randomtest.iterations.error") else null

		override fun checkInput(inputString: String) = getErrorText(inputString) == null

		override fun canClose(inputString: String) = checkInput(inputString)
	}
}
