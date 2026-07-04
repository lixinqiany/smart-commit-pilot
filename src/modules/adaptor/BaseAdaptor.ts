import { Venders } from '../configuration/configuration.constants';
import { MessageCreationRequest } from './unified-protocols/request';
import { MessageCreationResponse } from './unified-protocols/response';

export abstract class BaseAdaptor {
    readonly #baseURL: string;
    readonly #apiKey: string;
    readonly #provider: Venders;

    constructor(baseURL: string, apiKey: string, provider: Venders) {
        this.#baseURL = baseURL;
        this.#apiKey = apiKey;
        this.#provider = provider;
    }

    async createMessage(body: MessageCreationRequest): Promise<MessageCreationResponse> {
        const sdkRequest = this.toAdaptorSpecifiedRequest(body);
        const sdkResponse = await this.send(sdkRequest);
        return this.toUnifiedResponse(sdkResponse);
    }

    /**
     * @description 将统一协议的请求体转换为当前厂商 SDK 所需的原生请求格式。
     */
    protected abstract toAdaptorSpecifiedRequest(request: MessageCreationRequest): unknown;

    /**
     * @description 使用厂商原生请求体发起真实的 API 调用。
     */
    protected abstract send(request: unknown): Promise<unknown>;

    /**
     * @description 将厂商原生响应体转换为统一协议的响应格式。
     */
    protected abstract toUnifiedResponse(response: unknown): MessageCreationResponse;

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