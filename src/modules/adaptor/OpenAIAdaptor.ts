import OpenAI from 'openai';
import { l10n } from 'vscode';
import type {
    Response as OpenAIResponse,
    ResponseCreateParamsNonStreaming,
    ResponseInput,
    ResponseOutputMessage,
    ResponseOutputText,
} from 'openai/resources/responses/responses';
import { BaseAdaptor, ModelResponseError, OnModelProgress } from './BaseAdaptor';
import { Venders } from '../configuration/configuration.constants';
import { MessageCreationRequest, MessageContentList, MessageRole } from './unified-protocols/request';
import { MessageCreationResponse, Usage } from './unified-protocols/response';

function supportsExplicitPromptCaching(model: string): boolean {
    const version = /^(?:openai\/)?gpt-(\d+)(?:\.(\d+))?(?:-|$)/.exec(model);
    if (!version) {
        return false;
    }
    const major = Number(version[1]);
    const minor = Number(version[2] ?? 0);
    return major > 5 || (major === 5 && minor >= 6);
}

function readUsage(usage: OpenAIResponse['usage']): Usage | null {
    if (!usage) { return null; }
    return {
        input_tokens: usage.input_tokens,
        input_tokens_details: {
            cached_tokens: usage.input_tokens_details?.cached_tokens ?? null,
            cache_write_tokens: usage.input_tokens_details?.cache_write_tokens ?? null,
        },
        output_tokens: usage.output_tokens,
        output_tokens_details: {
            thinking_tokens: usage.output_tokens_details?.reasoning_tokens ?? null,
        },
    };
}

export class OpenAIAdaptor extends BaseAdaptor<ResponseCreateParamsNonStreaming, OpenAIResponse> {
    readonly #client: OpenAI;

    constructor(baseURL: string, apiKey: string, provider: Venders) {
        super(baseURL, apiKey, provider);
        this.#client = new OpenAI({ apiKey, baseURL });
    }

    protected toAdaptorSpecifiedRequest(request: MessageCreationRequest): ResponseCreateParamsNonStreaming {
        const explicit = supportsExplicitPromptCaching(request.model);
        const reuse = request.messages.some(m => Array.isArray(m.content) && m.content.some(part => part.cacheBreakpoint));
        const input: ResponseInput = request.messages.map((item) => ({
            role: item.role === MessageRole.USER ? 'user' : 'assistant',
            content:
                typeof item.content === 'string'
                    ? item.content
                    : item.content.map((part) => ({ type: 'input_text' as const, text: part.text,
                        ...(explicit && part.cacheBreakpoint ? { prompt_cache_breakpoint: { mode: 'explicit' as const } } : {}) })),
        }));

        const body: ResponseCreateParamsNonStreaming = {
            model: request.model,
            input,
            instructions: request.system,
            max_output_tokens: request.max_output_tokens,
        };
        if (explicit && (request.avoidCacheWrites || reuse)) {
            // Only the stable snapshot is marked during a multi-round plan.
            body.prompt_cache_options = { mode: 'explicit' };
        }
        return body;
    }

    protected sendBuffered(request: ResponseCreateParamsNonStreaming, signal?: AbortSignal): Promise<OpenAIResponse> {
        return this.#client.responses.create(request, { signal });
    }

    protected async sendStream(request: ResponseCreateParamsNonStreaming, signal: AbortSignal | undefined,
        onText: (delta: string) => void, onProgress: OnModelProgress): Promise<OpenAIResponse> {
        const { data, response } = await this.#client.responses.create({ ...request, stream: true }, { signal }).withResponse();
        const contentType = response.headers.get('content-type');
        if (contentType?.includes('application/json')) {
            onProgress('buffered');
            return await response.json() as OpenAIResponse;
        }
        if (contentType?.includes('text/event-stream')) { onProgress('connected'); }
        for await (const event of data) {
            if (event.type === 'response.output_text.delta') { onText(event.delta); }
            if (event.type === 'response.completed') { return event.response; }
            if (event.type === 'response.failed' || event.type === 'response.incomplete') {
                throw new ModelResponseError(event.response.error?.message || l10n.t('The model response was interrupted.'), readUsage(event.response.usage));
            }
            if (event.type === 'error') { throw new Error(event.message); }
        }
        throw new Error(l10n.t('The model response was interrupted.'));
    }

    protected toUnifiedResponse(response: OpenAIResponse): MessageCreationResponse {
        const content: MessageContentList = response.output
            .filter((item): item is ResponseOutputMessage => item.type === 'message')
            .flatMap((item) => item.content)
            .filter((part): part is ResponseOutputText => part.type === 'output_text')
            .map((part) => ({ type: 'text' as const, text: part.text }));

        return {
            id: response.id,
            model: response.model,
            role: MessageRole.ASSISTANT,
            content,
            usage: readUsage(response.usage),
        };
    }

    async listModels(): Promise<string[]> {
        const models: string[] = [];
        for await (const model of this.#client.models.list()) {
            models.push(model.id);
        }
        return models;
    }
}
