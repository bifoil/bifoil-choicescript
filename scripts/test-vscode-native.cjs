const {runTests}=require('@vscode/test-electron');
const path=require('node:path');
runTests({vscodeExecutablePath:process.env.BRANCHLIGHT_VSCODE_EXECUTABLE,version:'1.109.0',extensionDevelopmentPath:path.resolve(process.env.BRANCHLIGHT_EXTENSION_PATH || 'editors/vscode'),extensionTestsPath:path.resolve('editors/vscode/test/smoke.cjs'),launchArgs:[path.resolve('fixtures/dialogue'),'--disable-extensions','--skip-welcome','--skip-release-notes','--no-sandbox']}).catch(error=>{console.error(error);process.exitCode=1;});
