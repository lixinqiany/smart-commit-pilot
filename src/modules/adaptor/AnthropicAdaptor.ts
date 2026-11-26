import Anthropic from '@anthropic-ai/sdk';
import { MessageStream } from '@anthropic-ai/sdk/lib/MessageStream';
import type { Message, MessageCreateParamsNonStreaming, MessageParam, TextBlock } from '@anthropic-ai/sdk/resources/messages';
import { BaseAdaptor, OnModelProgress } from './BaseAdaptor';
import { Venders } from '../configuration/configuration.constants';
import { MessageCreationRequest, MessageContentList, MessageRole } from './unified-protocols/request';
import { MessageCreationResponse, Usage } from './unified-protocols/response';

export class AnthropicAdaptor extends BaseAdaptor<MessageCreateParamsNonStreaming, Message> {
    readonly #client: Anthropic;

    constructor(baseURL: string, apiKey: string, provider: Venders) {
        super(baseURL, apiKey, provider);
        this.#client = new Anthropic({ apiKey, baseURL });
    }

    protected toAdaptorSpecifiedRequest(request: MessageCreationRequest): MessageCreateParamsNonStreaming {
        const messages: MessageParam[] = request.messages.map((item) => ({
            role: item.role === MessageRole.USER ? 'user' : 'assistant',
            content:
                typeof item.content === 'string'
                    ? item.content
                    : item.content.map((part) => ({ type: 'text' as const, text: part.text,
                        ...(part.cacheBreakpoint ? { cache_control: { type: 'ephemeral' as const } } : {}) })),
        }));

        return {
            model: request.model,
            messages,
            system: request.system,
            max_tokens: request.max_output_tokens,
        };
    }

    protected sendBuffered(request: MessageCreateParamsNonStreaming, signal?: AbortSignal): Promise<Message> {
        return this.#client.messages.create(request, { signal });
    }

    protected async sendStream(request: MessageCreateParamsNonStreaming, signal: AbortSignal | undefined,
        onText: (delta: string) => void, onProgress: OnModelProgress): Promise<Message> {
        const { data, response } = await this.#client.messages.create({ ...request, stream: true }, { signal }).withResponse();
        const contentType = response.headers.get('content-type');
        if (contentType?.includes('application/json')) {
            onProgress('buffered');
            return await response.json() as Message;
        }
        if (contentType?.includes('text/event-stream')) { onProgress('connected'); }
        const stream = MessageStream.fromReadableStream(data.toReadableStream());
        stream.on('text', onText);
        return stream.finalMessage();
    }

    protected toUnifiedResponse(response: Message): MessageCreationResponse {
        const content: MessageContentList = response.content
            .filter((block): block is TextBlock => block.type === 'text')
            .map((block) => ({ type: 'text' as const, text: block.text }));

        const usage: Usage | null = response.usage ? {
            input_tokens: response.usage.input_tokens,
            input_tokens_details: {
                cache_creation: response.usage.cache_creation,
                cache_creation_input_tokens: response.usage.cache_creation_input_tokens,
                cache_read_input_tokens: response.usage.cache_read_input_tokens,
            },
            output_tokens: response.usage.output_tokens,
            output_tokens_details: {
                thinking_tokens: response.usage.output_tokens_details?.thinking_tokens ?? 0,
            },
        } : null;

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
