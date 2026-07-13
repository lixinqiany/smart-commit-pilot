import * as vscode from 'vscode';
import { DEFAULT_BASE_URLS, DEFAULT_COMMIT_PROMPT, Venders } from './configuration.constants';
import { AdaptorFactory } from '../adaptor/AdaptorFactory';
import { PromptFileSystemProvider } from './PromptFileSystemProvider';

const API_KEY_SECRET = 'smartCommitPilot.apiKey';

export class Configurator {
	private readonly output: vscode.OutputChannel;

	constructor(private readonly context: vscode.ExtensionContext) {
		this.output = vscode.window.createOutputChannel('Smart Commit Pilot');
	}

	log(message: string): void {
		this.output.appendLine(message);
	}

	async setupVendor(): Promise<void> {
		const venderInfo = await this.captureVenderInfo();
		if (!venderInfo) {
			return;
		}
		const { provider, baseUrl, apiKey } = venderInfo;

		const config = vscode.workspace.getConfiguration('smartCommitPilot');
		// write to the user-level settings.json for all projects on the PC
		await config.update('provider', provider, vscode.ConfigurationTarget.Global);
		await config.update('baseUrl', baseUrl, vscode.ConfigurationTarget.Global);

		await this.context.secrets.store(API_KEY_SECRET, apiKey);

		await this.setupModel();
	}

	async getBaseURLandSecrets(): Promise<{ provider: string; baseUrl: string; apiKey: string } | undefined> {
		const config = vscode.workspace.getConfiguration('smartCommitPilot');
		const provider = config.get<string>('provider');
		const baseUrl = config.get<string>('baseUrl');
		const apiKey = await this.context.secrets.get(API_KEY_SECRET);

		if (!provider || !baseUrl || !apiKey) {
			return undefined;
		}

		return { provider, baseUrl, apiKey };
	}

	getPrompt(): string {
		const config = vscode.workspace.getConfiguration('smartCommitPilot');
		const prompt = config.get<string>('prompt', '');
		return prompt.trim() || DEFAULT_COMMIT_PROMPT;
	}

	async setupPrompt(): Promise<void> {
		const doc = await vscode.workspace.openTextDocument(PromptFileSystemProvider.uri);
		await vscode.window.showTextDocument(doc, { preview: false });
	}

	async savePrompt(prompt: string): Promise<void> {
		const config = vscode.workspace.getConfiguration('smartCommitPilot');
		await config.update('prompt', prompt.trim(), vscode.ConfigurationTarget.Global);
	}

	getModel(): string {
		const config = vscode.workspace.getConfiguration('smartCommitPilot');
		return config.get<string>('model', '');
	}

	isLineBlameEnabled(): boolean {
		const config = vscode.workspace.getConfiguration('smartCommitPilot');
		return config.get<boolean>('blame.enabled', true);
	}

	isLineBlameAvatarEnabled(): boolean {
		const config = vscode.workspace.getConfiguration('smartCommitPilot');
		return config.get<boolean>('blame.avatars', true);
	}

	async toggleLineBlame(): Promise<void> {
		const config = vscode.workspace.getConfiguration('smartCommitPilot');
		await config.update('blame.enabled', !this.isLineBlameEnabled(), vscode.ConfigurationTarget.Workspace);
	}

	async setupModel(): Promise<void> {
		const venderInfo = await this.getBaseURLandSecrets();
		if (!venderInfo) {
			vscode.window.showErrorMessage('Smart Commit Pilot: please setup the provider first.');
			return;
		}
		const { provider, baseUrl, apiKey } = venderInfo;

		let models: string[];
		try {
			models = await vscode.window.withProgress(
				{ location: vscode.ProgressLocation.Notification, title: 'Fetching available models...' },
				async () => {
					const adaptor = AdaptorFactory.create(provider as Venders, baseUrl, apiKey);
					return adaptor.listModels();
				}
			);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			vscode.window.showErrorMessage(`Smart Commit Pilot: failed to fetch models. ${message}`);
			return;
		}

		if (models.length === 0) {
			vscode.window.showWarningMessage('Smart Commit Pilot: no models available for the configured provider.');
			return;
		}

		const model = await vscode.window.showQuickPick(models, { placeHolder: 'Select a model' });
		if (!model) {
			return;
		}

		const config = vscode.workspace.getConfiguration('smartCommitPilot');
		await config.update('model', model, vscode.ConfigurationTarget.Global);
	}

	private async captureVenderInfo(): Promise<{ provider: string; baseUrl: string; apiKey: string } | undefined> {
		const config = vscode.workspace.getConfiguration('smartCommitPilot');
		const currentProvider = config.get<string>('provider');
		const currentBaseUrl = config.get<string>('baseUrl');
		const currentApiKey = await this.context.secrets.get(API_KEY_SECRET);

		// put the already-configured provider first so it's pre-highlighted in the list
		const providerOptions = [Venders.OpenAI, Venders.Anthropic].sort((a, b) =>
			a === currentProvider ? -1 : b === currentProvider ? 1 : 0
		);
		const providerInput = await vscode.window.showQuickPick(providerOptions, {
			placeHolder: 'Select a provider',
		});

		// handle empty selection
		const provider = providerInput?.trim();
		if (!provider) {
			return undefined;
		}

		const baseUrlInput = await vscode.window.showInputBox({
			prompt: 'Enter the Base URL',
			// reuse the previously configured base url for this provider, otherwise fall back to its default
			value: provider === currentProvider && currentBaseUrl ? currentBaseUrl : DEFAULT_BASE_URLS[provider],
			validateInput: (value) => (value.trim() ? null : 'Base URL is required!!!'),
		});
		const baseUrl = baseUrlInput?.trim();
		if (!baseUrl) {
			return undefined;
		}

		const apiKeyInput = await vscode.window.showInputBox({
			prompt: currentApiKey ? 'Enter the API Key (leave blank to keep the existing one)' : 'Enter the API Key',
			password: true,
			validateInput: (value) => (value.trim() || currentApiKey ? null : 'API Key is required!!!'),
		});
		// undefined means the user cancelled, as opposed to submitting an empty string to keep the existing key
		if (apiKeyInput === undefined) {
			return undefined;
		}
		const apiKey = apiKeyInput.trim() || currentApiKey;
		if (!apiKey) {
			return undefined;
		}

		return { provider, baseUrl, apiKey };
	}

}
