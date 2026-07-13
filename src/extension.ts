// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';
import { Configurator } from './modules/configuration/Configurator';
import { PromptFileSystemProvider } from './modules/configuration/PromptFileSystemProvider';
import { AdaptorFactory } from './modules/adaptor/AdaptorFactory';
import { Venders } from './modules/configuration/configuration.constants';
import { OpenAIAdaptor } from './modules/adaptor/OpenAIAdaptor';
import { AnthropicAdaptor } from './modules/adaptor/AnthropicAdaptor';
import { GitService } from './modules/git/GitService';
import { CommitGenerator } from './modules/git/CommitGenerator';
import { BlameRunner, COPY_BLAME_HASH_COMMAND } from './modules/git/BlameRunner';

// This method is called when your extension is activated
// Your extension is activated the very first time the command is executed
export function activate(context: vscode.ExtensionContext) {

	// Use the console to output diagnostic information (console.log) and errors (console.error)
	// This line of code will only be executed once when your extension is activated
	console.log('Congratulations, your extension "smart-commit-pilot" is now active!');

	AdaptorFactory.register(Venders.OpenAI, OpenAIAdaptor);
    AdaptorFactory.register(Venders.Anthropic, AnthropicAdaptor);

	const configurator = new Configurator(context);
	const gitService = new GitService();
	const commitGenerator = new CommitGenerator(gitService, configurator);
	const blameRunner = new BlameRunner(gitService, configurator);
	blameRunner.start();

	context.subscriptions.push(
		blameRunner,
		vscode.workspace.registerFileSystemProvider(
			PromptFileSystemProvider.scheme,
			new PromptFileSystemProvider(configurator),
			{ isCaseSensitive: true }
		),
		vscode.commands.registerCommand('smart-commit-pilot.setup', () => configurator.setupVendor()),
		vscode.commands.registerCommand('smart-commit-pilot.configurePrompt', () => configurator.setupPrompt()),
		vscode.commands.registerCommand('smart-commit-pilot.selectModel', () => configurator.setupModel()),
		vscode.commands.registerCommand('smart-commit-pilot.toggleLineBlame', () => configurator.toggleLineBlame()),
		vscode.commands.registerCommand(COPY_BLAME_HASH_COMMAND, async (hash: unknown) => {
			if (typeof hash === 'string' && /^[0-9a-f]{40}$/i.test(hash)) {
				await vscode.env.clipboard.writeText(hash);
			}
		}),
		vscode.commands.registerCommand('smart-commit-pilot.generateCommitMessage', (sourceControl?: vscode.SourceControl) =>
			commitGenerator.run(sourceControl?.rootUri)
		)
	);
}

// This method is called when your extension is deactivated
export function deactivate() {}
