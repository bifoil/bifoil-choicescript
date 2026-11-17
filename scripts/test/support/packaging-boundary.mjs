/** Replace only external build/provision/editor boundaries in an isolated child. */
import { registerHooks } from "node:module";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";
const mode = process.env.BIFOIL_PACKAGE_CONTRACT;
const virtual = (source) => ({ url: "data:text/javascript," + encodeURIComponent(source), shortCircuit: true });
registerHooks({
  resolve(specifier, context, next) {
    const parent = context.parentURL?.startsWith("file:") ? basename(fileURLToPath(context.parentURL)) : "";
    const packaging = ["package-all.mjs", "package-vscode.mjs", "package-intellij.mjs"];
    if (packaging.includes(parent) && specifier === "./runtime.mjs")
      return virtual(`
      export async function provision(target) {
        if(process.env.BIFOIL_PACKAGE_CONTRACT==='provision-failure') throw new Error('Original provisioning failure');
        return 'prepared-runtime';
      }
    `);
    if (packaging.includes(parent) && specifier === "./native-artifact.mjs")
      return virtual(`
      import {mkdir,writeFile} from 'node:fs/promises';
      export async function stageNativeArtifacts(destination,targets) {
        await mkdir(destination+'/native/'+targets[0],{recursive:true});
        await writeFile(destination+'/native/'+targets[0]+'/original.txt','Original native artifact');
      }
    `);
    if (parent === "package-vscode.mjs" && specifier === "@vscode/vsce")
      return virtual(`
      import {writeFile} from 'node:fs/promises';
      export async function createVSIX(options) {
        await writeFile('vsix-options.json',JSON.stringify(options));
        await writeFile(options.packagePath,'Original VSIX boundary bytes');
      }
    `);
    if (["test-bundle.mjs", "test-vscode.mjs"].includes(parent) && specifier === "./installed-extension.mjs")
      return virtual(`export async function installedExtension(){return '/original extracted extension';}`);
    if (parent === "test-vscode.mjs" && specifier === "@vscode/test-electron")
      return virtual(`
      import {mkdir,writeFile} from 'node:fs/promises';
      export async function runTests(options) {
        await writeFile('editor-options.json',JSON.stringify(options));
        if(process.env.BIFOIL_PACKAGE_CONTRACT==='editor-failure') throw new Error('Original editor failure');
        const reports=options.extensionTestsEnv.BIFOIL_CHOICESCRIPT_TEST_REPORTS;
        await mkdir(reports,{recursive:true});
        await writeFile(reports+'/workflows.json',JSON.stringify({editor:'original test editor'}));
      }
    `);
    if (
      ["package-all.mjs", "build-native.mjs", "test-bundle.mjs"].includes(parent) &&
      specifier === "node:child_process"
    )
      return virtual(`
        import {writeFileSync,mkdirSync} from 'node:fs';
        export function execFileSync(executable,args,options) {
          writeFileSync('child-call.json',JSON.stringify({executable,args,options}));
          if(process.env.BIFOIL_PACKAGE_CONTRACT==='child-failure') throw new Error('Original child failure');
          if(args[0]==='scripts/package-vscode.mjs') {
            mkdirSync('dist/packages',{recursive:true});
            writeFileSync('dist/packages/bifoil-choicescript-'+args[1]+'.vsix','Original '+args[1]);
          }
          const output=args.indexOf('-o');
          if(output>=0) writeFileSync(args[output+1],Buffer.from([0,97,115,109]));
          return Buffer.alloc(0);
        }
      `);
    return next(specifier, context);
  },
});
