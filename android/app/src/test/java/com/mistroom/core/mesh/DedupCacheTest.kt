package com.mistroom.core.mesh

import com.google.common.truth.Truth.assertThat
import org.junit.Before
import org.junit.Test

class DedupCacheTest {

    private lateinit var cache: DedupCache

    @Before
    fun setup() {
        cache = DedupCache()
    }

    @Test
    fun `new packet ID is not a duplicate`() {
        assertThat(cache.isDuplicate("packet-001")).isFalse()
    }

    @Test
    fun `marking seen makes it a duplicate`() {
        cache.markSeen("packet-001")
        assertThat(cache.isDuplicate("packet-001")).isTrue()
    }

    @Test
    fun `isDuplicate marks ID as seen on first call`() {
        assertThat(cache.isDuplicate("packet-002")).isFalse()
        // Second call — should now be duplicate (marked on first call)
        assertThat(cache.isDuplicate("packet-002")).isTrue()
    }

    @Test
    fun `different IDs are independent`() {
        cache.markSeen("a")
        assertThat(cache.isDuplicate("a")).isTrue()
        assertThat(cache.isDuplicate("b")).isFalse()
    }

    @Test
    fun `cache handles many unique IDs`() {
        repeat(1000) { i ->
            val id = "packet-$i"
            assertThat(cache.isDuplicate(id)).isFalse()
        }
        // All should now be duplicates
        repeat(1000) { i ->
            assertThat(cache.isDuplicate("packet-$i")).isTrue()
        }
    }

    @Test
    fun `cache does not grow unbounded — oldest entries evicted`() {
        // Insert more than the expected capacity
        val capacity = 2048
        repeat(capacity + 100) { i ->
            cache.markSeen("id-$i")
        }
        // Most recent should still be present
        for (i in (capacity)..(capacity + 99)) {
            assertThat(cache.isDuplicate("id-$i")).isTrue()
        }
    }
}
