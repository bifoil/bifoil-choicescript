package dev.bifoil.choicescript

import junit.framework.TestCase

/** Job ordering and event admission are checked independently of editor rendering. */
class ChoiceCoverageContractsTest : TestCase() {
	fun testOnlyCurrentSuccessfulCoverageCanPopulateTheStore() {
		val store = CoverageStore()
		assertFalse(store.update(JobEvent("missing", "game", "coverage", coverage = mapOf("scene" to listOf(1)))))
		assertFalse(store.invalidate("missing"))
		assertTrue(store.update(JobEvent("active", "game", "started")))
		assertFalse(store.update(JobEvent("older", "game", "coverage", coverage = mapOf("scene" to listOf(2)))))
		assertFalse(store.update(JobEvent("active", "game", "output")))
		assertFalse(store.update(JobEvent("active", "game", "coverage")))
		val counts = mutableListOf(1L, 0L, 3L)
		assertTrue(store.update(JobEvent("active", "game", "coverage", coverage = mapOf("SCENE" to counts))))
		counts[0] = 99
		assertEquals(listOf(1L, 0L, 3L), store.counts("game", "scene"))
		assertFalse(store.update(JobEvent("active", "game", "completed", exitCode = 0)))
		assertEquals(listOf(1L, 0L, 3L), store.counts("game", "SCENE"))
		assertTrue(store.update(JobEvent("active", "game", "completed", exitCode = 1)))
		assertTrue(store.counts("game", "scene").isEmpty())
		assertFalse(store.update(JobEvent("active", "game", "coverage", coverage = mapOf("scene" to listOf(8)))))
	}

	fun testStaleAndRestartedJobsCannotReviveRetiredCounts() {
		val store = CoverageStore()
		for (event in listOf(
			JobEvent("old", "game", "started", stale = true),
			JobEvent("old", "game", "stale"),
			JobEvent("old", "game", "output", stale = true)
		)) {
			assertTrue(store.update(event))
			assertFalse(store.update(JobEvent("old", "game", "coverage", coverage = mapOf("scene" to listOf(7)))))
		}
		assertTrue(store.update(JobEvent("new", "game", "started")))
		assertTrue(store.update(JobEvent("new", "game", "coverage", coverage = mapOf("scene" to listOf(4)))))
		assertFalse(store.update(JobEvent("old", "game", "stale")))
		assertEquals(listOf(4L), store.counts("game", "scene"))
		store.retain(setOf("game"))
		assertEquals(listOf(4L), store.counts("game", "scene"))
		store.retain(emptySet())
		assertTrue(store.counts("game", "scene").isEmpty())
	}

	fun testValidatorsExposeTheSameBoundaryResultsToCheckAndClose() {
		val seeds = RandomTestInput.seedValidator(2)
		for (valid in listOf("0", "-9007199254740991", "9007199254740990")) {
			assertTrue(seeds.checkInput(valid))
			assertTrue(seeds.canClose(valid))
			assertNull(seeds.getErrorText(valid))
		}
		for (invalid in listOf("", "x", "9007199254740991")) {
			assertFalse(seeds.checkInput(invalid))
			assertFalse(seeds.canClose(invalid))
			assertNotNull(seeds.getErrorText(invalid))
		}
		val iterations = RandomTestInput.iterationsValidator
		for (value in listOf("1", "10000000", "0", "10000001", "invalid")) {
			val valid = value == "1" || value == "10000000"
			assertEquals(valid, iterations.checkInput(value))
			assertEquals(valid, iterations.canClose(value))
			assertEquals(!valid, iterations.getErrorText(value) != null)
		}
	}
}
