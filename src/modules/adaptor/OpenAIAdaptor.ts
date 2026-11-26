import OpenAI from 'openai';
import type {
    Response as OpenAIResponse,
    ResponseCreateParamsNonStreaming,
    ResponseInput,
    ResponseOutputMessage,
    ResponseOutputText,
} from 'openai/resources/responses/responses';
import { BaseAdaptor } from './BaseAdaptor';
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

export class OpenAIAdaptor extends BaseAdaptor {
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

    protected async send(request: ResponseCreateParamsNonStreaming, signal?: AbortSignal): Promise<OpenAIResponse> {
        return this.#client.responses.create(request, { signal });
    }

    protected toUnifiedResponse(response: OpenAIResponse): MessageCreationResponse {
        let usage: Usage | null = null;
        if (!response.usage) {
            usage = null;
        } else {
            usage = {
                input_tokens: response.usage.input_tokens,
                input_tokens_details: {
                    cached_tokens: response.usage.input_tokens_details?.cached_tokens ?? null,
                    cache_write_tokens: response.usage.input_tokens_details?.cache_write_tokens ?? null,
                },
                output_tokens: response.usage.output_tokens,
                output_tokens_details: {
                    thinking_tokens: response.usage.output_tokens_details?.reasoning_tokens ?? null,
                },
            };
        }

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
            usage,
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
