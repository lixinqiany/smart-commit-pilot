import * as vscode from 'vscode';
import { DEFAULT_BASE_URLS, Venders } from './configuration.constants';

const API_KEY_SECRET = 'smartCommitPilot.apiKey';

export class Configurator {
	private readonly output: vscode.OutputChannel;

	constructor(private readonly context: vscode.ExtensionContext) {
		this.output = vscode.window.createOutputChannel('Smart Commit Pilot');
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
		return config.get<string>('prompt', '');
	}

	async setupPrompt(): Promise<void> {
		await vscode.commands.executeCommand('workbench.action.openSettings', 'smartCommitPilot.prompt');
	}

	private async captureVenderInfo(): Promise<{ provider: string; baseUrl: string; apiKey: string } | undefined> {
		const providerInput = await vscode.window.showQuickPick([Venders.OpenAI, Venders.Anthropic], {
			placeHolder: 'Select a provider',
		});

		// handle empty selection
		const provider = providerInput?.trim();
		if (!provider) {
			return undefined;
		}

		const baseUrlInput = await vscode.window.showInputBox({
			prompt: 'Enter the Base URL',
			// default base url of the selected provider
			value: DEFAULT_BASE_URLS[provider],
			validateInput: (value) => (value.trim() ? null : 'Base URL is required!!!'),
		});
		const baseUrl = baseUrlInput?.trim();
		if (!baseUrl) {
			return undefined;
		}

		const apiKeyInput = await vscode.window.showInputBox({
			prompt: 'Enter the API Key',
			password: true,
			validateInput: (value) => (value.trim() ? null : 'API Key is required!!!'),
		});
		const apiKey = apiKeyInput?.trim();
		if (!apiKey) {
			return undefined;
		}

		return { provider, baseUrl, apiKey };
	}

}
