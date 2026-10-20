/* Exercise the original arena algorithm on a low-address native heap. Only the
 * wasm memory/export ABI is supplied by this host shim; environment.c is included
 * unchanged. The ordinary TypeScript suite separately tests the shipped wasm. */
#include <assert.h>
#include <stdint.h>
#include <stdio.h>

__asm__(".bss\n.balign 16\n.globl __heap_base\n__heap_base:\n.zero 50331648\n.text");
static unsigned long pages;
static int refuse_growth;
static unsigned long memory_size(int index) {
	assert(index == 0);
	return pages;
}
static unsigned long memory_grow(int index, unsigned long count);
#define __attribute__(attribute)
#define __builtin_wasm_memory_size memory_size
#define __builtin_wasm_memory_grow memory_grow
#include "../environment.c"
#undef __attribute__

static unsigned long memory_grow(int index, unsigned long count) {
	assert(index == 0);
	const unsigned long maximum = ((uintptr_t)&environment_heap_base + 50331648u) >> 16;
	if (refuse_growth || pages + count > maximum)
		return (unsigned long)-1;
	const unsigned long before = pages;
	pages += count;
	return before;
}
static void fresh(void) {
	assert((uintptr_t)&environment_heap_base < UINT32_MAX - 50331648u);
	pages = ((uintptr_t)&environment_heap_base + 262144u) >> 16;
	refuse_growth = 0;
	reset();
}
static void snapshots_and_entries(void) {
	fresh();
	assert(env_size(0) == 0 && env_get(0, 12) == 0);
	assert(env_equal(0, 0) && env_join(0, 0) == 0);
	u32 root = 0;
	const u32 keys[] = {1, 16, 65536, 0xffffffffu, 0x12345678};
	for (u32 i = 0; i < 5; i++) {
		const u32 old = root;
		root = env_set(root, keys[i], (i + 1) * 16 + 2);
		assert(root != FAILURE && env_size(root) == i + 1);
		assert(env_get(old, keys[i]) == 0);
		assert(env_get(root, keys[i]) == (i + 1) * 16 + 2);
		assert(env_set(root, keys[i], (i + 1) * 16 + 2) == root);
	}
	assert(env_get(env_set(0, 1, 18), 0xffffffffu) == 0);
	const u32 saved = root;
	for (u32 i = 0; i < 5; i++) {
		root = env_set(root, keys[i], 0);
		assert(env_size(root) == 4 - i);
		assert(env_get(saved, keys[i]) == (i + 1) * 16 + 2);
	}
	assert(root == 0 && env_set(0, 99, 0) == 0);
	const u32* entries = (const u32*)(uintptr_t)env_entries(saved);
	for (u32 i = 0; i < 5; i++) {
		assert(entries[2 * i + 1] == env_get(saved, entries[2 * i]));
		if (i) assert(entries[2 * i] > entries[2 * i - 2]);
	}
	assert(env_equal(saved, saved));
	assert(!env_equal(saved, 0));
}
static void joins_and_collection(void) {
	fresh();
	const u32 left = env_set(env_set(0, 1, 18), 65536, 36);
	const u32 right = env_set(env_set(0, 1, 34), 16, 49);
	const u32 joined = env_join(left, right);
	assert(env_get(joined, 1) == 2);
	assert(env_get(joined, 16) == 9);
	assert(env_get(joined, 65536) == 12);
	assert(env_equal(joined, env_join(right, left)));
	assert(env_equal(joined, env_join(joined, left)));
	assert(env_join(left, left) == left);
	assert(!env_equal(left, right));
	assert(env_size(joined) == 3);
	const u32 same = env_set(env_set(0, 65536, 36), 1, 18);
	assert(env_equal(left, same));
	assert(env_equal(left, env_join(same, left)));
	assert(env_get(env_join(env_set(0, 1, 18), env_set(0, 1, 20)), 1) == 22);
	for (u32 i = 0; i < 90000; i++) assert(env_set(0, 1, 18) != FAILURE);
	assert(collect_needed());
	const u32 before = committed_nodes();
	collect_begin();
	mark(left);
	mark(same);
	mark(joined);
	mark(joined);
	mark(0);
	collect_end();
	assert(!collect_needed());
	assert(env_equal(left, same));
	assert(env_get(env_set(0, 2, 50), 2) == 50);
	assert(committed_nodes() == before);
	epoch = 0xffffffffu;
	collect_begin();
	mark(joined);
	collect_end();
	assert(epoch == 1 && env_size(joined) == 3);
}
static void capacity_failures_are_explicit(void) {
	fresh();
	pages = 0;
	refuse_growth = 1;
	assert(env_set(0, 1, 18) == FAILURE);
	fresh();
	const u32 root = env_set(0, 1, 18);
	used = NODE_LIMIT;
	assert(env_set(0, 1, 18) == FAILURE);
	assert(env_set(root, 65536, 18) == FAILURE);
	assert(env_join(root, 0) == FAILURE);
	fresh();
	const u32 entries_root = env_set(0, 1, 18);
	pages = 0;
	refuse_growth = 1;
	assert(env_entries(entries_root) == FAILURE);
}
int main(void) {
	snapshots_and_entries();
	joins_and_collection();
	capacity_failures_are_explicit();
	puts("Native arena snapshots, joins, collection and bounded failures passed.");
	return 0;
}
