import * as assert from 'assert';

// You can import and use all API from the 'vscode' module
// as well as import your extension to test it
import * as vscode from 'vscode';
import { parseLineBlame } from '../modules/git/GitService';
// import * as myExtension from '../../extension';

suite('Extension Test Suite', () => {
	vscode.window.showInformationMessage('Start all tests.');

	test('Sample test', () => {
		assert.strictEqual(-1, [1, 2, 3].indexOf(5));
		assert.strictEqual(-1, [1, 2, 3].indexOf(0));
	});

	test('Parses committed line blame', () => {
		const blame = parseLineBlame([
			'235dfd3abbd0ae8e587813fbfe66e347f62292d6 15 16 1',
			'author lixinqiany',
			'author-mail <developer@example.com>',
			'author-time 1783243015',
			'author-tz +0800',
			'summary Add current line blame',
			'filename package.json',
			'\t  "keywords": [',
		].join('\n'), { name: 'lixinqiany', email: 'developer@example.com' });

		assert.ok(blame);
		assert.strictEqual(blame.hash, '235dfd3abbd0ae8e587813fbfe66e347f62292d6');
		assert.strictEqual(blame.author, 'lixinqiany');
		assert.strictEqual(blame.summary, 'Add current line blame');
		assert.strictEqual(blame.isUncommitted, false);
		assert.strictEqual(blame.isCurrentUser, true);
		assert.strictEqual(blame.authoredAt.getTime(), 1783243015 * 1000);
	});

	test('Parses uncommitted line blame', () => {
		const blame = parseLineBlame([
			'0000000000000000000000000000000000000000 16 16 1',
			'author External file (--contents)',
			'author-mail <external.file>',
			'author-time 1783913287',
			'author-tz +0800',
			'summary Version of package.json from standard input',
			'filename package.json',
			'\t  "keywords_changed": [',
		].join('\n'));

		assert.ok(blame);
		assert.strictEqual(blame.isUncommitted, true);
		assert.strictEqual(blame.isCurrentUser, true);
	});

	test('Rejects invalid line blame output', () => {
		assert.strictEqual(parseLineBlame('fatal: no such path'), undefined);
	});
});
