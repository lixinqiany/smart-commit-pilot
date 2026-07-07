import * as vscode from 'vscode';
import { Configurator } from './Configurator';

// Backs a single virtual file that reads/writes the "smartCommitPilot.prompt" setting,
// so the prompt can be edited in a real multi-line text editor instead of the Settings UI
// (whose one-line input is a poor fit for a multi-line template, and whose query-based
// openSettings hangs the Settings page in Cursor: https://forum.cursor.com/t/163463).
export class PromptFileSystemProvider implements vscode.FileSystemProvider {
	static readonly scheme = 'smart-commit-pilot-prompt';
	static readonly uri = vscode.Uri.parse(`${PromptFileSystemProvider.scheme}:/commit-prompt.md`);

	private readonly changeEmitter = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
	readonly onDidChangeFile = this.changeEmitter.event;

	constructor(private readonly configurator: Configurator) {}

	watch(): vscode.Disposable {
		return new vscode.Disposable(() => {});
	}

	stat(): vscode.FileStat {
		const size = Buffer.byteLength(this.configurator.getPrompt(), 'utf8');
		return { type: vscode.FileType.File, ctime: 0, mtime: 0, size };
	}

	readDirectory(): [string, vscode.FileType][] {
		return [];
	}

	createDirectory(): void {
		throw vscode.FileSystemError.NoPermissions();
	}

	readFile(): Uint8Array {
		return Buffer.from(this.configurator.getPrompt(), 'utf8');
	}

	async writeFile(uri: vscode.Uri, content: Uint8Array): Promise<void> {
		await this.configurator.savePrompt(Buffer.from(content).toString('utf8'));
		this.changeEmitter.fire([{ type: vscode.FileChangeType.Changed, uri }]);
	}

	delete(): void {
		throw vscode.FileSystemError.NoPermissions();
	}

	rename(): void {
		throw vscode.FileSystemError.NoPermissions();
	}
}
