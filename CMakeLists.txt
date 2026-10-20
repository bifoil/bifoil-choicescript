cmake_minimum_required(VERSION 3.24)

# Build the freestanding C arena with the same wasm32 ABI as pnpm native:build.
# Usage: cmake -S . -B .cache/cmake/wasm -G Ninja
#        cmake --build .cache/cmake/wasm
# The output stays in the build tree; pnpm native:build regenerates the TypeScript embedding.
if (CMAKE_SOURCE_DIR STREQUAL CMAKE_BINARY_DIR)
	message(FATAL_ERROR "Use an out-of-source build, for example: cmake -S . -B .cache/cmake/wasm -G Ninja")
endif ()

if (NOT DEFINED CMAKE_TOOLCHAIN_FILE)
	set(CMAKE_TOOLCHAIN_FILE "${CMAKE_CURRENT_LIST_DIR}/cmake/wasm32-clang.cmake"
			CACHE FILEPATH "Toolchain for the portable environment arena")
endif ()

set(CMAKE_EXPORT_COMPILE_COMMANDS ON CACHE BOOL "Export native compiler commands for editors and analyzers")
project(BifoilChoiceScriptNative LANGUAGES C)

if (NOT CMAKE_C_COMPILER_ID MATCHES "Clang" OR CMAKE_C_SIMULATE_ID STREQUAL "MSVC")
	message(FATAL_ERROR
			"The wasm32 arena requires the Clang driver; selected '${CMAKE_C_COMPILER}'.\n"
			"In JetBrains, select a Clang toolchain for this project's CMake profile, then reset the cache and reload.\n"
			"For command-line builds, configure a fresh build with -DCMAKE_C_COMPILER=clang."
	)
endif ()
if (NOT CMAKE_C_COMPILER_TARGET MATCHES "^wasm32($|-)")
	message(FATAL_ERROR "The arena requires a wasm32 Clang target. Use cmake/wasm32-clang.cmake.")
endif ()

# Prefer the linker beside the selected Clang; allow the same override as the pnpm build.
file(REAL_PATH "${CMAKE_C_COMPILER}" _bifoil_clang)
get_filename_component(_bifoil_llvm_bin "${_bifoil_clang}" DIRECTORY)
if (NOT DEFINED BIFOIL_WASM_LD AND NOT "$ENV{BIFOIL_WASM_LD}" STREQUAL "")
	find_program(BIFOIL_WASM_LD NAMES "$ENV{BIFOIL_WASM_LD}" HINTS "${_bifoil_llvm_bin}")
else ()
	find_program(BIFOIL_WASM_LD NAMES wasm-ld HINTS "${_bifoil_llvm_bin}")
endif ()

if (NOT BIFOIL_WASM_LD)
	message(FATAL_ERROR
			"The wasm32 arena also requires wasm-ld. Provide its path with -DBIFOIL_WASM_LD=/path/to/wasm-ld\n"
			"or set the BIFOIL_WASM_LD environment variable. The linker can come from an existing LLVM or Rust toolchain."
	)
endif ()

# The original native source inventory currently contains C only. Keep it explicit
# so dependency sources, generated output and local experimental files are never built.
add_library(bifoil_environment OBJECT native/environment/environment.c)
target_compile_options(bifoil_environment PRIVATE -O3 -msimd128 -fno-builtin -nostdlib)

get_property(_bifoil_multi_config GLOBAL PROPERTY GENERATOR_IS_MULTI_CONFIG)
if (_bifoil_multi_config)
	set(_bifoil_wasm "${CMAKE_CURRENT_BINARY_DIR}/$<CONFIG>/environment.wasm")
else ()
	set(_bifoil_wasm "${CMAKE_CURRENT_BINARY_DIR}/environment.wasm")
endif ()
get_filename_component(_bifoil_output_dir "${_bifoil_wasm}" DIRECTORY)

add_custom_command(
		OUTPUT "${_bifoil_wasm}"
		COMMAND "${CMAKE_COMMAND}" -E make_directory "${_bifoil_output_dir}"
		COMMAND "${BIFOIL_WASM_LD}"
		--no-entry
		--export-memory
		--initial-memory=262144
		--max-memory=50331648
		-z stack-size=65536
		"$<TARGET_OBJECTS:bifoil_environment>"
		-o "${_bifoil_wasm}"
		DEPENDS bifoil_environment "$<TARGET_OBJECTS:bifoil_environment>" "${BIFOIL_WASM_LD}"
		COMMENT "Linking the bounded wasm32 environment arena"
		COMMAND_EXPAND_LISTS
		VERBATIM
)
add_custom_target(bifoil_environment_wasm ALL DEPENDS "${_bifoil_wasm}")
