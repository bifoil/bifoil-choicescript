/* Original MIT-licensed Bifoil code. Persistent abstract environments for wasm32.
 * Keys and primitive constants are interned by the TypeScript owner. Nodes use
 * sixteen-way radix pages; zero values are absent, low four value bits are types.
 * Collection runs only at owner-provided safe points with all live roots marked.
 */
typedef unsigned int u32;
typedef unsigned long usize;

// These entry points are called by the WebAssembly host and require external linkage.
#define EXPORT(name) __attribute__((export_name(name)))
#define FAILURE 0xffffffffu
#define NODE_LIMIT 419000u
#define TYPE_UNKNOWN 8u

typedef struct {
	u32 slots[16];
	u32 size;
	u32 level;
	u32 mark;
	u32 next;
} Node;

// Retain the linker ABI symbol without using a reserved identifier in C.
extern unsigned char environment_heap_base __asm__("__heap_base");
static u32 used, free_head, free_count, allocated, epoch = 1;

static Node* nodes(void) {
	const u32 padded_address = (u32)&environment_heap_base + 15u;
	return (Node*)(padded_address & ~15u);
}

static u32 ensure(const u32 end) {
	const u32 pages = (end + 65535u) >> 16;
	const u32 current = __builtin_wasm_memory_size(0);
	return pages <= current || __builtin_wasm_memory_grow(0, pages - current) != (usize)-1;
}

static u32 node_size(const u32 root) {
	return root ? nodes()[root].size : 0;
}

static u32 allocate(const u32 level) {
	u32 id;
	if (free_head) {
		id = free_head;
		free_head = nodes()[id].next;
		free_count--;
	} else {
		if (used >= NODE_LIMIT)
			return FAILURE;
		id = used + 1;
		if (!ensure((u32)(nodes() + id + 1)))
			return FAILURE;
		used = id;
	}
	Node* const node = &nodes()[id];
	for (u32 i = 0; i < 16; i++)
		node->slots[i] = 0;
	node->size = 0;
	node->level = level;
	node->mark = 0;
	node->next = 0;
	allocated++;
	return id;
}

static u32 copy(const u32 root, const u32 level) {
	const u32 id = allocate(level);
	if (id == FAILURE)
		return id;
	if (root) {
		for (u32 i = 0; i < 16; i++)
			nodes()[id].slots[i] = nodes()[root].slots[i];
		nodes()[id].size = nodes()[root].size;
	}
	return id;
}

static u32 join_value(const u32 a, const u32 b) {
	if (a == b)
		return a;
	if (!a)
		return b ? (b & 15u) | TYPE_UNKNOWN : 0;
	if (!b)
		return (a & 15u) | TYPE_UNKNOWN;
	const u32 constant = a >> 4 == b >> 4 ? a & ~15u : 0;
	const u32 types = (a | b) & 15u;
	return types | constant;
}

EXPORT("env_reset") void reset(void) {
	used = free_head = free_count = allocated = 0;
	epoch = 1;
}

EXPORT("env_size") u32 env_size(const u32 root) {
	return node_size(root);
}

EXPORT("env_get") u32 env_get(u32 root, const u32 key) {
	if (!root)
		return 0;
	u32 level = nodes()[root].level;
	if (level < 7 && key >> (4 * (level + 1)))
		return 0;
	while (level) {
		root = nodes()[root].slots[(key >> (4 * level)) & 15u];
		if (!root)
			return 0;
		level--;
	}
	return nodes()[root].slots[key & 15u];
}

static u32 set_at(const u32 root, const u32 key, const u32 value, const u32 level) {
	const u32 slot = (key >> (4 * level)) & 15u;
	const u32 previous = root ? nodes()[root].slots[slot] : 0;
	const u32 next = level ? set_at(previous, key, value, level - 1) : value;
	if (next == FAILURE)
		return FAILURE;
	if (previous == next)
		return root;
	const u32 size_before = level ? node_size(previous) : previous != 0;
	const u32 size_after = level ? node_size(next) : next != 0;
	const u32 count = node_size(root) - size_before + size_after;
	if (!count)
		return 0;
	const u32 result = copy(root, level);
	if (result == FAILURE)
		return result;
	nodes()[result].slots[slot] = next;
	nodes()[result].size = count;
	return result;
}

EXPORT("env_set") u32 env_set(u32 root, const u32 key, const u32 value) {
	if (!value && !env_get(root, key))
		return root;
	u32 level = root ? nodes()[root].level : 0;
	u32 required = 0;
	for (u32 rest = key >> 4; rest; rest >>= 4)
		required++;
	while (root && level < required) {
		const u32 next = allocate(++level);
		if (next == FAILURE)
			return FAILURE;
		nodes()[next].slots[0] = root;
		nodes()[next].size = node_size(root);
		root = next;
	}
	if (level < required)
		level = required;
	return set_at(root, key, value, level);
}

static u32 child(const u32 root, const u32 slot, const u32 level) {
	if (!root)
		return 0;
	return nodes()[root].level < level ? (slot ? 0 : root) : nodes()[root].slots[slot];
}

static u32 join_at(const u32 a, const u32 b, const u32 level) {
	if (a == b)
		return a;
	u32 result = 0, values[16], size = 0, same_a = a && nodes()[a].level == level,
		same_b = b && nodes()[b].level == level;
	for (u32 i = 0; i < 16; i++) {
		const u32 x = child(a, i, level), y = child(b, i, level);
		const u32 value = level ? join_at(x, y, level - 1) : join_value(x, y);
		if (value == FAILURE)
			return FAILURE;
		values[i] = value;
		size += level ? node_size(value) : value != 0;
		if (value != x)
			same_a = 0;
		if (value != y)
			same_b = 0;
	}
	if (same_a)
		return a;
	if (same_b)
		return b;
	if (!size)
		return 0;
	result = allocate(level);
	if (result == FAILURE)
		return result;
	for (u32 i = 0; i < 16; i++)
		nodes()[result].slots[i] = values[i];
	nodes()[result].size = size;
	return result;
}

EXPORT("env_join") u32 env_join(const u32 a, const u32 b) {
	u32 level = a ? nodes()[a].level : 0;
	if (b && nodes()[b].level > level)
		level = nodes()[b].level;
	return join_at(a, b, level);
}

static u32 equal_at(const u32 a, const u32 b, const u32 level) {
	if (a == b)
		return 1;
	if (node_size(a) != node_size(b))
		return 0;
	for (u32 i = 0; i < 16; i++) {
		const u32 x = child(a, i, level), y = child(b, i, level);
		if (level ? !equal_at(x, y, level - 1) : x != y)
			return 0;
	}
	return 1;
}

EXPORT("env_equal") u32 env_equal(const u32 a, const u32 b) {
	u32 level = a ? nodes()[a].level : 0;
	if (b && nodes()[b].level > level)
		level = nodes()[b].level;
	return equal_at(a, b, level);
}

static u32 write_entries(const u32 root, const u32 prefix, u32* const output, u32 at) {
	if (!root)
		return at;
	const Node* const node = &nodes()[root];
	for (u32 i = 0; i < 16; i++) {
		const u32 value = node->slots[i];
		if (!value)
			continue;
		const u32 key = prefix | (i << (4 * node->level));
		if (node->level)
			at = write_entries(value, key, output, at);
		else {
			output[at++] = key;
			output[at++] = value;
		}
	}
	return at;
}

EXPORT("env_entries") u32 env_entries(const u32 root) {
	u32* const output = (u32*)(nodes() + used + 1);
	if (!ensure((u32)output + node_size(root) * 8u))
		return FAILURE;
	write_entries(root, 0, output, 0);
	return (u32)output;
}

EXPORT("env_collect_needed") u32 collect_needed(void) {
	return allocated >= 65536u || (used + 16384u >= NODE_LIMIT && free_count < 16384u);
}

EXPORT("env_collect_begin") void collect_begin(void) {
	if (!++epoch) {
		for (u32 i = 1; i <= used; i++)
			nodes()[i].mark = 0;
		epoch = 1;
	}
}

EXPORT("env_mark") void mark(const u32 root) {
	if (!root || nodes()[root].mark == epoch)
		return;
	nodes()[root].mark = epoch;
	if (nodes()[root].level)
		for (u32 i = 0; i < 16; i++)
			mark(nodes()[root].slots[i]);
}

EXPORT("env_collect_end") void collect_end(void) {
	free_head = free_count = 0;
	for (u32 i = 1; i <= used; i++)
		if (nodes()[i].mark != epoch) {
			nodes()[i].next = free_head;
			free_head = i;
			free_count++;
		}
	allocated = 0;
}

EXPORT("env_committed_nodes") u32 committed_nodes(void) {
	return used;
}
