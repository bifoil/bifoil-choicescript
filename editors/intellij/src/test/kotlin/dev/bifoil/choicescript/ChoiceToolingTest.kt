package dev.bifoil.choicescript

import org.junit.Assert.*
import org.junit.Test

class ChoiceToolingTest {
	@Test
	fun seedsPreserveSafeIntegersBeyondThe32BitRange() {
		for (value in listOf(
			-RandomTestInput.MAX_SEED,
			-2_147_483_649L,
			0L,
			2_147_483_648L,
			RandomTestInput.MAX_SEED
		)) {
			assertEquals(value, RandomTestInput.seed(value.toString()))
		}

		for (value in listOf("", " ", "1.5", "1e3", "Infinity", "NaN", "9007199254740992", "-9007199254740992")) {
			assertNull(value, RandomTestInput.seed(value))
		}

		assertEquals(1, RandomTestInput.iterations("1"))
		assertEquals(10_000_000, RandomTestInput.iterations("10000000"))

		for (value in listOf("0", "10000001", "-1", "1.5", "", "1e3")) assertNull(RandomTestInput.iterations(value))
	}

	@Test
	fun seedRangesCannotOverflowAcrossIterations() {
		assertTrue(RandomTestInput.validRange(RandomTestInput.MAX_SEED, 1))
		assertFalse(RandomTestInput.validRange(RandomTestInput.MAX_SEED, 2))
		assertTrue(RandomTestInput.validRange(RandomTestInput.MAX_SEED - 1, 2))
		assertTrue(RandomTestInput.seedValidator(2).canClose((RandomTestInput.MAX_SEED - 1).toString()))
		assertFalse(RandomTestInput.seedValidator(2).canClose(RandomTestInput.MAX_SEED.toString()))
		assertFalse(RandomTestInput.iterationsValidator.canClose("0"))
	}

	@Test
	fun coverageRemainsScopedAndLateResultsCannotRestoreStaleHighlights() {
		val store = CoverageStore()

		fun start(project: String, job: String, stale: Boolean = false) =
			store.update(JobEvent(projectId = project, jobId = job, kind = "started", stale = stale))

		fun cover(project: String, job: String, vararg counts: Long) = store.update(
			JobEvent(
				projectId = project,
				jobId = job,
				kind = "coverage",
				coverage = mapOf("startup" to counts.toList())
			)
		)
		start("one", "old")
		cover("one", "old", 1, 0, 2)
		start("two", "other")
		cover("two", "other", 0, 3)

		assertEquals(listOf(1L, 0L, 2L), store.counts("one", "STARTUP"))
		assertEquals(listOf(0L, 3L), store.counts("two", "startup"))

		start("one", "new")
		cover("one", "new", 4)
		store.update(JobEvent(projectId = "one", jobId = "old", kind = "stale"))
		cover("one", "old", 99)

		assertEquals(listOf(4L), store.counts("one", "startup"))

		assertTrue(store.invalidate("one"))
		assertFalse(store.invalidate("one"))
		assertFalse(store.invalidate("unknown"))
		cover("one", "new", 99)

		assertTrue(store.counts("one", "startup").isEmpty())
		assertEquals(listOf(0L, 3L), store.counts("two", "startup"))

		start("one", "stale-start", true)
		cover("one", "stale-start", 99)

		assertTrue(store.counts("one", "startup").isEmpty())

		store.update(JobEvent(projectId = "two", jobId = "other", kind = "completed", exitCode = 130))

		assertTrue(store.counts("two", "startup").isEmpty())

		store.retain(emptySet())
		cover("one", "stale-start", 99)

		assertTrue(store.counts("one", "startup").isEmpty())
	}

	@Test
	fun cancelledPreparationIsHandledWithoutHidingRealFailures() {
		fun rpc(message: String, code: Int = -32603) =
			org.eclipse.lsp4j.jsonrpc.ResponseErrorException(
				org.eclipse.lsp4j.jsonrpc.messages.ResponseError(code, message, null)
			)

		val cancelled = rpc("Operation cancelled.", -32800)

		assertTrue(GameToolCancellation.isCancellation(java.util.concurrent.ExecutionException(cancelled)))
		assertTrue(GameToolCancellation.isCancellation(java.util.concurrent.CancellationException()))
		assertFalse(GameToolCancellation.isCancellation(rpc("Runtime checksum mismatch")))
		assertFalse(GameToolCancellation.isCancellation(rpc("Operation cancelled.")))
		assertFalse(GameToolCancellation.isCancellation(IllegalStateException("Operation cancelled.")))
	}
}
