import type { MessageRole, MessageContentList } from "./request";

export interface OpenAICacheDetails {
    cached_tokens: number;
}

interface AnthropicCacheCreationDetails {
    ephemeral_1h_input_tokens: number;
    ephemeral_5m_input_tokens: number;
}
export interface AnthropicCacheDetails {
    cache_creation: AnthropicCacheCreationDetails | null;
    cache_creation_input_tokens: number | null;
    cache_read_input_tokens: number | null;
}


export interface Usage {
    input_tokens: number;
    input_tokens_details: OpenAICacheDetails | AnthropicCacheDetails;
    output_tokens: number;
    output_tokens_details: {
      thinking_tokens: number;
    }
}

export interface MessageCreationResponse {
    id: string;
    model: string;
    role: MessageRole.ASSISTANT;
    content: MessageContentList;
    usage: Usage | null;
}
