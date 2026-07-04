export enum MessageRole {
    USER = "user",
    ASSISTANT = "assistant"
}

export interface TextContent {
    type: "text";
    text: string;
}

export type MessageContent = TextContent;
export type MessageContentList = Array<MessageContent>;

export namespace MessageInputItem {
    export interface Message {
        role: MessageRole;
        content: string | MessageContentList;
    }
}

export type MessageInputItem = 
    | MessageInputItem.Message
export type MessageInput = Array<MessageInputItem>

export interface MessageCreationRequest {
    model: string;
    messages: MessageInput;
    /* @description system prompt */
    system?: string;
    /* 
    @description The maximum number of tokens to generate response before stopping.
    Note: this is required for anthropic API, but optional for OpenAI API. 
    */
    max_output_tokens: number;
}