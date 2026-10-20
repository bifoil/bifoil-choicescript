# Clang's bare wasm32 target needs neither a host executable nor a WASI sysroot.
set(CMAKE_SYSTEM_NAME Generic)
set(CMAKE_SYSTEM_PROCESSOR wasm32)
set(CMAKE_C_COMPILER_TARGET wasm32)
set(CMAKE_TRY_COMPILE_TARGET_TYPE STATIC_LIBRARY)

# Respect an explicit compiler or CC; BIFOIL_CLANG matches scripts/build-native.mjs.
if (NOT DEFINED CMAKE_C_COMPILER)
	if (NOT "$ENV{BIFOIL_CLANG}" STREQUAL "")
		set(CMAKE_C_COMPILER "$ENV{BIFOIL_CLANG}" CACHE FILEPATH "Path to Clang")
	elseif ("$ENV{CC}" STREQUAL "")
		find_program(CMAKE_C_COMPILER NAMES clang REQUIRED)
	endif ()
endif ()
