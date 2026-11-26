import { Venders } from '../configuration/configuration.constants';
import { MessageCreationRequest } from './unified-protocols/request';
import { MessageCreationResponse, Usage } from './unified-protocols/response';

function rejectsStreaming(err: unknown): boolean {
    if (!(err instanceof Error) || !('status' in err) || ![400, 422, 501].includes(Number(err.status))) { return false; }
    const unsupported = /unsupported|not supported|does not support|unknown (?:parameter|field)|not permitted/i;
    return /\bstream(?:ing)?\b/i.test(err.message) && unsupported.test(err.message);
}

export type ModelProgress = 'connected' | 'buffered';
export type OnModelProgress = (event: ModelProgress) => void;

export class ModelResponseError extends Error {
    constructor(message: string, readonly usage: Usage | null) {
        super(message);
        this.name = 'ModelResponseError';
    }
}

export abstract class BaseAdaptor<NativeRequest = unknown, NativeResponse = unknown> {
    readonly #baseURL: string;
    readonly #apiKey: string;
    readonly #provider: Venders;

    constructor(baseURL: string, apiKey: string, provider: Venders) {
        this.#baseURL = baseURL;
        this.#apiKey = apiKey;
        this.#provider = provider;
    }

    async createMessage(body: MessageCreationRequest, signal?: AbortSignal, onText?: (delta: string) => void,
        onProgress?: OnModelProgress): Promise<MessageCreationResponse> {
        const request = this.toAdaptorSpecifiedRequest(body);
        signal?.throwIfAborted();
        const report: OnModelProgress = event => {
            if (!signal?.aborted) { onProgress?.(event); }
        };
        let receivedText = false;
        let response: NativeResponse;
        try {
            response = await this.sendStream(request, signal, delta => {
                receivedText = true;
                if (!signal?.aborted) { onText?.(delta); }
            }, report);
        } catch (err) {
            // Only retry an explicit rejection of streaming before any output.
            if (receivedText || signal?.aborted || !rejectsStreaming(err)) { throw err; }
            report('buffered');
            response = await this.sendBuffered(request, signal);
        }
        const result = this.toUnifiedResponse(response);
        if (signal?.aborted) {
            const reason: unknown = signal.reason;
            throw new ModelResponseError(reason instanceof Error ? reason.message : String(reason), result.usage);
        }
        return result;
    }

    protected abstract toAdaptorSpecifiedRequest(request: MessageCreationRequest): NativeRequest;
    protected abstract sendStream(request: NativeRequest, signal: AbortSignal | undefined, onText: (delta: string) => void, onProgress: OnModelProgress): Promise<NativeResponse>;
    protected abstract sendBuffered(request: NativeRequest, signal?: AbortSignal): Promise<NativeResponse>;
    protected abstract toUnifiedResponse(response: NativeResponse): MessageCreationResponse;

    /**
     * @description 获取当前厂商可用的模型列表。
     */
    abstract listModels(): Promise<string[]>;

    public get baseURL(): string {
        return this.#baseURL;
    }

    public get apiKey(): string {
        return this.#apiKey;
    }

    public get provider(): Venders {
        return this.#provider;
    }
}
