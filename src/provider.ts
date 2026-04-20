import * as vscode from 'vscode';
import type { CancellationToken, LanguageModelChatInformation } from 'vscode';
import {
  BASE_URL,
  CrofAIModelsService,
  getModelMaxOutputTokens,
  getEffortFromModelId,
} from './models.js';
import { getModelTemperature, getModelReasoningEffort } from './config.js';
import type { ReasoningEffort } from './types.js';
import { logInfo, logWarn, logRequestStart, logRequestEnd, logRequestError } from './logger.js';

const MAX_RETRIES = 3;
const RETRY_BASE_DELAY_MS = 500;
const RETRY_JITTER_FACTOR = 0.2;
const STREAM_TIMEOUT_MS = 60_000;

const VALID_REASONING_EFFORTS = new Set<string>(['none', 'low', 'medium', 'high']);

interface ChunkData {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: Array<{
    index: number;
    delta: {
      role?: string;
      content?: string | null;
      reasoning_content?: string | null;
      tool_calls?: Array<{
        index: number;
        id?: string;
        type: 'function';
        function: {
          name?: string;
          arguments?: string;
        };
      }>;
    };
    finish_reason: string | null;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
}

function isAbortError(error: unknown): boolean {
  if (error instanceof Error) {
    return (
      error.name === 'AbortError' ||
      error.message.includes('aborted') ||
      error.message.includes('abort')
    );
  }
  return false;
}

function resolveErrorMessage(error: unknown): string {
  if (!(error instanceof Error)) {
    return 'Failed to get response from CrofAI. Please try again.';
  }
  const msg = error.message;
  if (msg.includes('401')) {
    return 'Invalid CrofAI API key. Please run "CrofAI: Manage Provider" to update it.';
  }
  if (msg.includes('403')) {
    return 'Access denied. Please check your CrofAI API key permissions.';
  }
  if (msg.includes('429')) {
    return 'Rate limit exceeded. Please wait before retrying.';
  }
  if (/API error 5\d\d/.test(msg)) {
    return `CrofAI server error: ${msg}`;
  }
  return `CrofAI error: ${msg}`;
}

function buildOpenAIMessages(messages: readonly vscode.LanguageModelChatRequestMessage[]): Array<{
  role: string;
  content: string | Array<unknown>;
  name?: string;
  tool_call_id?: string;
  tool_calls?: unknown[];
}> {
  const result: Array<{
    role: string;
    content: string | Array<unknown>;
    name?: string;
    tool_call_id?: string;
    tool_calls?: unknown[];
  }> = [];

  for (const msg of messages) {
    const role = msg.role === 1 ? 'user' : msg.role === 2 ? 'assistant' : 'system';

    for (const part of msg.content) {
      if (part instanceof vscode.LanguageModelTextPart) {
        result.push({ role, content: part.value, name: msg.name });
      } else if (part instanceof vscode.LanguageModelDataPart) {
        if (part.mimeType.startsWith('image/')) {
          result.push({
            role,
            content: [
              { type: 'text', text: '' },
              {
                type: 'image_url',
                image_url: {
                  url: `data:${part.mimeType};base64,${Buffer.from(part.data).toString('base64')}`,
                },
              },
            ],
            name: msg.name,
          });
        }
      } else if (part instanceof vscode.LanguageModelToolCallPart) {
        result.push({
          role: 'assistant',
          content: '',
          tool_calls: [
            {
              id: part.callId,
              type: 'function',
              function: {
                name: part.name,
                arguments:
                  typeof part.input === 'string' ? part.input : JSON.stringify(part.input ?? {}),
              },
            },
          ],
        });
      } else if (part instanceof vscode.LanguageModelToolResultPart) {
        let toolContent: string;
        if (typeof part.content === 'string') {
          toolContent = part.content;
        } else if (Array.isArray(part.content)) {
          toolContent = part.content
            .map((c) => (c instanceof vscode.LanguageModelTextPart ? c.value : JSON.stringify(c)))
            .join('');
        } else {
          toolContent = JSON.stringify(part.content);
        }
        result.push({
          role: 'tool',
          content: toolContent,
          tool_call_id: part.callId,
        });
      }
    }
  }

  return result;
}

export class CrofAIChatModelProvider implements vscode.LanguageModelChatProvider<LanguageModelChatInformation> {
  private readonly _onDidChangeModelInfo = new vscode.EventEmitter<void>();
  readonly onDidChangeLanguageModelChatInformation = this._onDidChangeModelInfo.event;

  constructor(
    private readonly secrets: vscode.SecretStorage,
    private readonly userAgent: string,
    private readonly modelsService: CrofAIModelsService
  ) {}

  fireModelChange(): void {
    this._onDidChangeModelInfo.fire();
  }

  dispose(): void {
    this._onDidChangeModelInfo.dispose();
  }

  async provideLanguageModelChatInformation(
    options: vscode.PrepareLanguageModelChatModelOptions,
    token: CancellationToken
  ): Promise<LanguageModelChatInformation[]> {
    return this.modelsService.prepareLanguageModelChatInformation(this.secrets, options, token);
  }

  async provideLanguageModelChatResponse(
    model: LanguageModelChatInformation,
    messages: readonly vscode.LanguageModelChatRequestMessage[],
    options: vscode.ProvideLanguageModelChatResponseOptions,
    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
    token: CancellationToken
  ): Promise<void> {
    const apiKey = await this.secrets.get('crofai.apiKey');
    if (!apiKey) {
      throw new Error(
        'CrofAI API key not configured. Please run "CrofAI: Manage Provider" to add your API key.'
      );
    }

    const { baseModelId, effort: suffixEffort } = getEffortFromModelId(model.id);
    // Priority: VS Code model config picker → old suffix → stored setting → model default
    const configEffortRaw = options.modelConfiguration?.reasoningEffort;
    const configEffort =
      typeof configEffortRaw === 'string' && VALID_REASONING_EFFORTS.has(configEffortRaw)
        ? (configEffortRaw as ReasoningEffort)
        : undefined;
    const selectedEffort = configEffort ?? suffixEffort ?? getModelReasoningEffort(baseModelId);
    const shouldShowThinking = selectedEffort !== 'none';
    const openaiMessages = buildOpenAIMessages(messages);
    const temperature = getModelTemperature(baseModelId);

    const requestBody: Record<string, unknown> = {
      model: baseModelId,
      messages: openaiMessages,
      stream: true,
      stream_options: { include_usage: true },
      max_tokens: getModelMaxOutputTokens(baseModelId),
    };

    if (temperature !== undefined) {
      requestBody.temperature = temperature;
    }
    if (selectedEffort) {
      requestBody.reasoning_effort = selectedEffort;
    }
    if (options.tools && options.tools.length > 0) {
      requestBody.tools = options.tools.map((tool) => ({
        type: 'function',
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.inputSchema ?? { type: 'object', properties: {}, required: [] },
        },
      }));
    }

    logRequestStart(baseModelId, openaiMessages.length);

    let retries = 0;
    let lastError: unknown;

    while (retries <= MAX_RETRIES) {
      if (token.isCancellationRequested) {
        return;
      }

      if (retries > 0) {
        const base = RETRY_BASE_DELAY_MS * 2 ** (retries - 1);
        const jitter = base * RETRY_JITTER_FACTOR * (Math.random() * 2 - 1);
        const delay = Math.round(base + jitter);
        logInfo(`[Retry] attempt=${retries} delay=${delay}ms model=${baseModelId}`);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }

      const abortController = new AbortController();
      const cancelDisposable = token.onCancellationRequested(() => abortController.abort());
      const timeoutId = setTimeout(
        () => abortController.abort(new Error('Request timeout')),
        STREAM_TIMEOUT_MS
      );
      const startMs = Date.now();
      let ttfMs: number | undefined;
      let gotContent = false;

      try {
        const response = await fetch(`${BASE_URL}/chat/completions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${apiKey}`,
            'User-Agent': this.userAgent,
          },
          body: JSON.stringify(requestBody),
          signal: abortController.signal,
        });

        if (!response.ok) {
          const errorText = await response.text();
          throw new Error(`API error ${response.status}: ${errorText}`);
        }

        if (!response.body) {
          throw new Error('No response body');
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let promptTokens: number | undefined;
        let completionTokens: number | undefined;
        let totalTokens: number | undefined;

        const toolCallBuffer = new Map<number, { id: string; name: string; arguments: string }>();

        while (true) {
          if (token.isCancellationRequested) {
            return;
          }

          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';

          for (const line of lines) {
            if (!line.startsWith('data: ')) continue;
            if (line === 'data: [DONE]') continue;

            const data = line.slice(6);
            if (!data) continue;

            try {
              const chunk: ChunkData = JSON.parse(data);

              if (chunk.usage) {
                promptTokens = chunk.usage.prompt_tokens;
                completionTokens = chunk.usage.completion_tokens;
                totalTokens = chunk.usage.total_tokens;
              }

              const choice = chunk.choices?.[0];
              if (!choice) continue;

              const delta = choice.delta;

              if (delta?.reasoning_content && shouldShowThinking) {
                if (ttfMs === undefined) ttfMs = Date.now() - startMs;
                gotContent = true;
                const thinkingPart = new vscode.LanguageModelThinkingPart(delta.reasoning_content);
                progress.report(thinkingPart as unknown as vscode.LanguageModelResponsePart);
              }

              if (delta?.content) {
                if (ttfMs === undefined) ttfMs = Date.now() - startMs;
                gotContent = true;
                progress.report(new vscode.LanguageModelTextPart(delta.content));
              }

              if (delta?.tool_calls) {
                for (const toolCall of delta.tool_calls) {
                  const idx = toolCall.index;
                  if (toolCall.id && toolCall.function?.name !== undefined) {
                    toolCallBuffer.set(idx, {
                      id: toolCall.id,
                      name: toolCall.function.name,
                      arguments: toolCall.function.arguments || '',
                    });
                  } else if (toolCall.function?.arguments) {
                    const existing = toolCallBuffer.get(idx);
                    if (existing) {
                      existing.arguments += toolCall.function.arguments;
                    }
                  }
                }
              }

              if (choice.finish_reason === 'tool_calls') {
                gotContent = true;
                for (const [, tc] of toolCallBuffer) {
                  let args: object = {};
                  try {
                    args = JSON.parse(tc.arguments || '{}');
                  } catch {
                    // Keep empty object
                  }
                  progress.report(new vscode.LanguageModelToolCallPart(tc.id, tc.name, args));
                }
                toolCallBuffer.clear();
              }
            } catch (parseErr) {
              logWarn(
                `[Streaming] Invalid JSON chunk skipped: ${parseErr instanceof Error ? parseErr.message : 'parse error'}`
              );
            }
          }
        }

        // Emit any remaining buffered tool calls
        for (const [, tc] of toolCallBuffer) {
          let args: object = {};
          try {
            args = JSON.parse(tc.arguments || '{}');
          } catch {
            // Keep empty object
          }
          gotContent = true;
          progress.report(new vscode.LanguageModelToolCallPart(tc.id, tc.name, args));
        }

        logRequestEnd({
          model: baseModelId,
          ttfms: ttfMs ?? Date.now() - startMs,
          promptTokens,
          completionTokens,
          totalTokens,
          retries,
        });

        // Retry on empty stream (transient server issue)
        if (!gotContent && retries < MAX_RETRIES) {
          logInfo(`[EmptyStream] retrying model=${baseModelId}`);
          retries++;
          continue;
        }

        return;
      } catch (error) {
        if (isAbortError(error)) {
          // User cancelled — not an error
          return;
        }

        lastError = error;
        logRequestError(baseModelId, error);

        // Don't retry auth errors
        const msg = error instanceof Error ? error.message : '';
        if (msg.includes('401') || msg.includes('403')) {
          break;
        }

        retries++;
      } finally {
        clearTimeout(timeoutId);
        cancelDisposable.dispose();
      }
    }

    throw new Error(resolveErrorMessage(lastError));
  }

  async provideTokenCount(
    _model: LanguageModelChatInformation,
    text: string | vscode.LanguageModelChatRequestMessage,
    _token: CancellationToken
  ): Promise<number> {
    if (typeof text === 'string') {
      return Math.ceil(text.length / 4);
    }
    let content = '';
    for (const part of text.content) {
      if (part instanceof vscode.LanguageModelTextPart) {
        content += part.value;
      }
    }
    return Math.ceil(content.length / 4);
  }
}
