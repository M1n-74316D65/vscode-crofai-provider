import * as vscode from 'vscode';
import type { CancellationToken, LanguageModelChatInformation } from 'vscode';
import { tryit } from 'radash';
import {
  CrofAIModelsResponseSchema,
  type CrofAIModelsResponse,
  DEFAULT_CONTEXT_LENGTH,
  DEFAULT_MAX_OUTPUT_TOKENS,
  type ReasoningEffort,
} from './types.js';

export const BASE_URL = 'https://crof.ai/v1';

const VISION_MODEL_PATTERNS = ['kimi', 'gemma', 'qwen'];

const REASONING_EFFORTS: ReasoningEffort[] = ['none', 'low', 'medium', 'high'];
const REASONING_EFFORT_LABELS: Record<ReasoningEffort, string> = {
  none: 'No Thinking',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
};

/** Schema placed on each reasoning-capable model. The group:'navigation' property
 *  makes VS Code render the effort picker as a button directly in the model picker. */
const REASONING_CONFIGURATION_SCHEMA = {
  properties: {
    reasoningEffort: {
      type: 'string',
      enum: REASONING_EFFORTS,
      enumItemLabels: REASONING_EFFORTS.map((e) => REASONING_EFFORT_LABELS[e]),
      default: 'medium',
      group: 'navigation',
      description: 'Reasoning effort level (controls thinking tokens)',
    },
  },
} as const;

function isVisionModel(modelId: string): boolean {
  const id = modelId.toLowerCase();
  return VISION_MODEL_PATTERNS.some((pattern) => id.includes(pattern));
}

/** Format per-token price string (e.g. "0.00000035") → "$0.35/M" */
function formatPricePerM(priceStr: string): string {
  const perToken = parseFloat(priceStr);
  if (isNaN(perToken) || perToken === 0) return 'Free';
  const perM = perToken * 1_000_000;
  return `$${perM % 1 === 0 ? perM.toFixed(0) : perM.toPrecision(3)}/M`;
}

/** Returns pricing badge: "Free" | "↑$0.35 ↓$1.70" */
function formatPricingBadge(pricing: { prompt: string; completion: string } | undefined): string {
  if (!pricing) return '';
  const inp = parseFloat(pricing.prompt);
  const out = parseFloat(pricing.completion);
  if (inp === 0 && out === 0) return 'Free';
  return `↑${formatPricePerM(pricing.prompt)} ↓${formatPricePerM(pricing.completion)}`;
}

function getModelFamily(modelId: string): string {
  const id = modelId.toLowerCase();
  if (id.startsWith('glm-')) return 'glm';
  if (id.startsWith('kimi')) return 'kimi';
  if (id.startsWith('deepseek')) return 'deepseek';
  if (id.startsWith('qwen')) return 'qwen';
  if (id.startsWith('gemma')) return 'gemma';
  if (id.startsWith('minimax')) return 'minimax';
  return 'crofai';
}

/** Backwards-compat: strip #low/#medium/#high suffix from model IDs
 *  that may still be persisted from the old 4-variant approach. */
export function getEffortFromModelId(modelId: string): {
  baseModelId: string;
  effort: ReasoningEffort | undefined;
} {
  for (const effort of REASONING_EFFORTS) {
    const suffix = `#${effort}`;
    if (effort !== 'none' && modelId.endsWith(suffix)) {
      return {
        baseModelId: modelId.slice(0, -suffix.length),
        effort,
      };
    }
  }
  return { baseModelId: modelId, effort: undefined };
}

export class CrofAIModelsService {
  constructor(private readonly userAgent: string) {}

  async ensureApiKey(secrets: vscode.SecretStorage, silent: boolean): Promise<string | undefined> {
    let apiKey = await secrets.get('crofai.apiKey');
    if (!apiKey && !silent) {
      const entered = await vscode.window.showInputBox({
        title: 'CrofAI API Key',
        prompt: 'Enter your CrofAI API key',
        ignoreFocusOut: true,
        password: true,
      });
      if (entered && entered.trim()) {
        apiKey = entered.trim();
        await secrets.store('crofai.apiKey', apiKey);
      }
    }
    return apiKey;
  }

  async fetchModels(apiKey: string): Promise<CrofAIModelsResponse> {
    try {
      const response = await fetch(`${BASE_URL}/models`, {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'User-Agent': this.userAgent,
        },
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.error('[CrofAI Provider] Failed to fetch CrofAI models', {
          status: response.status,
          statusText: response.statusText,
          detail: errorText,
        });
        vscode.window.showInformationMessage(
          `Failed to fetch models from CrofAI (${response.status}): ${response.statusText || 'Network error'}. Please check your API key.`
        );
        throw new Error(
          `Failed to fetch CrofAI models: ${response.status}${response.statusText ? ` ${response.statusText}` : ''}`
        );
      }

      const rawData = await response.json();
      const [err, data] = tryit(() => CrofAIModelsResponseSchema.parse(rawData))();
      if (err) {
        console.error('[CrofAI Provider] Model data validation failed:', err);
        vscode.window.showInformationMessage(
          'Failed to parse model data from CrofAI API. The API format may have changed.'
        );
        throw new Error(
          `Invalid API response: ${err instanceof Error ? err.message : 'Unknown error'}`
        );
      }

      if (!data?.data || data.data.length === 0) {
        throw new Error('No models available');
      }

      return data;
    } catch (error) {
      if (error instanceof Error) {
        throw error;
      }
      throw new Error('Unknown error fetching models');
    }
  }

  async prepareLanguageModelChatInformation(
    secrets: vscode.SecretStorage,
    options: vscode.PrepareLanguageModelChatModelOptions,
    _token: CancellationToken
  ): Promise<LanguageModelChatInformation[]> {
    const apiKey = await this.ensureApiKey(secrets, options.silent);
    if (!apiKey) {
      return [];
    }

    let models: CrofAIModelsResponse;
    try {
      models = await this.fetchModels(apiKey);
    } catch (error) {
      console.error('[CrofAI Provider] Failed to prepare model information:', error);
      if (!options.silent) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        vscode.window.showInformationMessage(`Unable to load CrofAI models: ${errorMessage}`);
      }
      return [];
    }

    const result: LanguageModelChatInformation[] = [];

    for (const model of models.data) {
      const modelName = model.name || model.id;
      const contextLength = model.context_length || DEFAULT_CONTEXT_LENGTH;
      const maxTokens = model.max_completion_tokens || DEFAULT_MAX_OUTPUT_TOKENS;
      const supportsVision = isVisionModel(model.id);
      const supportsThinking = model.custom_reasoning === true || model.reasoning_effort === true;
      const family = getModelFamily(model.id);
      const pricingBadge = formatPricingBadge(model.pricing);
      const isFree = pricingBadge === 'Free';

      const detailParts = ['CrofAI'];
      if (isFree) detailParts.push('Free');
      if (model.quantization) detailParts.push(model.quantization);

      const tooltipParts: string[] = [modelName];
      if (pricingBadge) tooltipParts.push(pricingBadge);
      if (supportsThinking) tooltipParts.push('Reasoning');
      if (supportsVision) tooltipParts.push('Vision');
      if (model.quantization) tooltipParts.push(model.quantization);
      if (model.speed !== undefined) tooltipParts.push(`Speed ${model.speed}`);

      result.push({
        id: model.id,
        name: modelName,
        tooltip: tooltipParts.join(' • '),
        family,
        detail: detailParts.join(' • '),
        version: '1.0.0',
        maxInputTokens: contextLength,
        maxOutputTokens: maxTokens,
        capabilities: {
          toolCalling: true,
          imageInput: supportsVision,
        },
        isUserSelectable: true,
        category: { label: 'CrofAI', order: 2 },
        ...(supportsThinking ? { configurationSchema: REASONING_CONFIGURATION_SCHEMA } : {}),
      } satisfies LanguageModelChatInformation);
    }

    return result;
  }
}
