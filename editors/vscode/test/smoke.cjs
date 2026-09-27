const vscode = require('vscode');
const assert = require('node:assert/strict');
exports.run = async () => {
  const extension = vscode.extensions.getExtension('chira-independent.choicescript-tools-unofficial');
  assert(extension); await extension.activate();
  const folder = vscode.workspace.workspaceFolders[0].uri;
  const uri = vscode.Uri.joinPath(folder, 'scenes', 'startup.txt');
  const document = await vscode.workspace.openTextDocument(uri); await vscode.window.showTextDocument(document);
  for (let i=0; i<100 && document.languageId !== 'choicescript'; i++) await new Promise(r => setTimeout(r,100));
  assert.equal(document.languageId,'choicescript');
  const config = vscode.workspace.getConfiguration('workbench'); const previous = config.inspect('colorTheme')?.workspaceValue;
  try {
    for (const theme of ['Default Dark Modern', 'Default Light Modern']) {
      await config.update('colorTheme',theme,vscode.ConfigurationTarget.Workspace);
      let tokens;
      for (let i=0;i<100;i++) { tokens=await vscode.commands.executeCommand('vscode.provideDocumentSemanticTokens',uri); if(tokens?.data.length)break; await new Promise(r=>setTimeout(r,100)); }
      assert(tokens?.data.length);
      const legend = await vscode.commands.executeCommand('vscode.provideDocumentSemanticTokensLegend',uri);
      assert(legend); let line=0,column=0; const spans=[];
      for(let i=0;i<tokens.data.length;i+=5){ column=tokens.data[i]===0?column+tokens.data[i+1]:tokens.data[i+1]; line+=tokens.data[i]; spans.push({line,start:column,end:column+tokens.data[i+2],kind:legend.tokenTypes[tokens.data[i+3]]}); }
      const at=(line,column)=>spans.find(s=>s.line===line&&column>=s.start&&column<s.end)?.kind;
      assert.equal(at(4,10),'dialogue'); assert.equal(at(5,15),'string'); assert.equal(at(6,4),'dialogue'); assert.equal(at(8,4),'dialogue'); assert.equal(at(9,0),'narrative');
      assert(!vscode.languages.getDiagnostics(uri).some(d=>String(d.code).startsWith('quote-')));
    }
  } finally { await config.update('colorTheme',previous,vscode.ConfigurationTarget.Workspace); }
  const definitions=await vscode.commands.executeCommand('vscode.executeDefinitionProvider',uri,new vscode.Position(5,5)); assert(definitions?.length);
  const completion=await vscode.commands.executeCommand('vscode.executeCompletionItemProvider',uri,new vscode.Position(5,5)); assert(completion.items.some(i=>i.label==='gender'));
  const rename=await vscode.commands.executeCommand('vscode.executeDocumentRenameProvider',uri,new vscode.Position(5,5),'identity'); assert(rename.entries().some(([,edits])=>edits.length===2));
  const notes=await vscode.workspace.openTextDocument(vscode.Uri.joinPath(folder,'notes.txt')); assert.equal(notes.languageId,'plaintext');
};
