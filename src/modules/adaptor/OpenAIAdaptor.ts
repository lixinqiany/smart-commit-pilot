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

export class OpenAIAdaptor extends BaseAdaptor {
    readonly #client: OpenAI;

    constructor(baseURL: string, apiKey: string, provider: Venders) {
        super(baseURL, apiKey, provider);
        this.#client = new OpenAI({ apiKey, baseURL });
    }

    protected toAdaptorSpecifiedRequest(request: MessageCreationRequest): ResponseCreateParamsNonStreaming {
        const input: ResponseInput = request.messages.map((item) => ({
            role: item.role === MessageRole.USER ? 'user' : 'assistant',
            content:
                typeof item.content === 'string'
                    ? item.content
                    : item.content.map((part) => ({ type: 'input_text' as const, text: part.text })),
        }));

        return {
            model: request.model,
            input,
            instructions: request.system,
            max_output_tokens: request.max_output_tokens,
        };
    }

    protected async send(request: ResponseCreateParamsNonStreaming): Promise<OpenAIResponse> {
        return this.#client.responses.create(request);
    }

    protected toUnifiedResponse(response: OpenAIResponse): MessageCreationResponse {
        let usage: Usage | null = null;
        if (!response.usage) {
            usage = null;
        } else {
            usage = {
                input_tokens: response.usage.input_tokens,
                input_tokens_details: {
                    cached_tokens: response.usage.input_tokens_details.cached_tokens,
                },
                output_tokens: response.usage.output_tokens,
                output_tokens_details: {
                    thinking_tokens: response.usage.output_tokens_details.reasoning_tokens,
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
