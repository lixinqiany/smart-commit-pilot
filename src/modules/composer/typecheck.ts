import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import type tsApi from 'typescript';

// Runs in a separate Node process. Load the editor's compiler and only request diagnostics.
// No project scripts, language-service plugins, build output or .tsbuildinfo writes.
const [, , library, root] = process.argv;
const ts: typeof tsApi = require(library);
const configs: string[] = JSON.parse(readFileSync(0, 'utf8'));
const diagnostics: tsApi.Diagnostic[] = [];
const projects = new Set<string>();
for (const config of configs) {
    const filename = resolve(root, config);
    const local = relative(root, filename);
    if (projects.has(filename) || local.startsWith('..') || isAbsolute(local)) { continue; }
    projects.add(filename);
    const parsed = ts.getParsedCommandLineOfConfigFile(filename, {}, {
        ...ts.sys, onUnRecoverableConfigFileDiagnostic: d => diagnostics.push(d),
    });
    if (!parsed) { continue; }
    for (const ref of parsed.projectReferences ?? []) { configs.push(ts.resolveProjectReferencePath(ref)); }
    diagnostics.push(...parsed.errors);
    if (!parsed.fileNames.length) { continue; }
    const program = ts.createProgram({ rootNames: parsed.fileNames, options: parsed.options,
        projectReferences: parsed.projectReferences });
    diagnostics.push(...ts.getPreEmitDiagnostics(program));
}
const issues = ts.sortAndDeduplicateDiagnostics(diagnostics).filter(d => d.category === ts.DiagnosticCategory.Error).map(d => {
    const file = d.file && relative(root, d.file.fileName).split('\\').join('/');
    const line = d.file && d.start !== undefined ? d.file.getLineAndCharacterOfPosition(d.start).line + 1 : undefined;
    const message = ts.flattenDiagnosticMessageText(d.messageText, ' ').split(root).join('.');
    const specifier = d.code === 2307 && /Cannot find module '([^']+)'/.exec(message)?.[1];
    const missing = file && specifier && specifier.startsWith('.') ? relative(root, resolve(root, dirname(file), specifier)).split('\\').join('/') : undefined;
    return { file, line, code: 'TS' + d.code, message, missing };
});
process.stdout.write(JSON.stringify(issues));

