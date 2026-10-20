/**
 * Pluggable chat/LLM backend. Used for KG extraction, index descriptions and
 * the optional LLM router.
 */
export type ChatMessage = {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface ChatModel {
  /** Single completion; returns the assistant text. */
  complete(messages: ChatMessage[]): Promise<string>
  /**
   * Completion constrained to a JSON object string (when the backend supports
   * it). Optional: implementations may omit it.
   */
  completeJson?(messages: ChatMessage[]): Promise<string>
}
