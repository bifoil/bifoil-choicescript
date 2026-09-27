// CommonJS entry point for Windows launchers; use the same isolated packaged tests.
import("./test-vscode.mjs").catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
