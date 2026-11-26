import * as assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as vscode from 'vscode';
import { formatRelativeTime } from '../modules/git/formatRelativeTime';

suite('Interface language', () => {
    const extension = vscode.extensions.getExtension('michael-yu.smart-commit-pilot')!;
    const catalog = (file: string): Record<string, string> =>
        JSON.parse(readFileSync(join(extension.extensionPath, file), 'utf8'));

    test('Both Chinese catalogs cover the same messages and preserve substitution arguments', () => {
        const placeholders = (text: string) => (text.match(/\{\d+\}/g) ?? []).sort();
        const simplified = catalog('l10n/bundle.l10n.zh-cn.json');
        const traditional = catalog('l10n/bundle.l10n.zh-tw.json');
        assert.deepEqual(Object.keys(traditional).sort(), Object.keys(simplified).sort());
        for (const messages of [simplified, traditional]) {
            for (const [key, translation] of Object.entries(messages)) {
                assert.ok(translation.trim(), key);
                assert.deepEqual(placeholders(translation), placeholders(key), key);
            }
        }
        const english = Object.keys(catalog('package.nls.json')).sort();
        for (const locale of ['zh-cn', 'zh-tw']) {
            assert.deepEqual(Object.keys(catalog('package.nls.' + locale + '.json')).sort(), english);
        }
    });

    test('Commands, runtime messages, and relative time follow the VS Code display language', () => {
        const locale = vscode.env.language.toLowerCase();
        const language = locale === 'zh-cn' || locale === 'zh-tw' ? locale : 'en';
        const menu = catalog(language === 'en' ? 'package.nls.json' : 'package.nls.' + language + '.json');
        const command = extension.packageJSON.contributes.commands.find(
            (c: { command: string }) => c.command === 'smart-commit-pilot.generateCommitMessage');
        assert.equal(command.title.value ?? command.title, menu['commands.generateCommitMessage']);
        const message = 'Select a provider';
        const expected = language === 'en' ? message : catalog('l10n/bundle.l10n.' + language + '.json')[message];
        assert.equal(vscode.l10n.t(message), expected);
        assert.equal(formatRelativeTime(new Date(Date.now() - 120_000)),
            new Intl.RelativeTimeFormat(language, { numeric: 'auto' }).format(-2, 'minute'));
    });
});
