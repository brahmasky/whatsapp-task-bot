/**
 * Shared Claude Agent Loop
 *
 * Handles the mechanical parts of an agentic tool-use loop:
 * API calls, token accumulation, tool result building, and iteration control.
 *
 * Each task agent provides its own tools, system prompt, and executeTool function.
 * The loop is otherwise identical across portfolio, market, and research agents.
 *
 * @param {object} opts
 * @param {string} opts.model             - Claude model ID
 * @param {string} opts.system            - System prompt
 * @param {object[]} opts.messages        - Initial messages array (mutated in place)
 * @param {object[]} opts.tools           - Tool definitions for Claude
 * @param {number} opts.maxIterations     - Safety limit before throwing
 * @param {number} opts.maxTokens         - Max tokens per API call
 * @param {Function} opts.executeTool     - async (name, input) => result  — throw on error
 * @param {Function} [opts.onToolCall]    - (name, input) => void  — called before each tool
 * @param {Function} [opts.onTurnText]    - (text, iteration) => void  — text blocks in tool-use turns
 * @returns {Promise<{text, usage: {inputTokens, outputTokens}, toolCalls}>}
 * @throws {Error} on missing API key or max iterations exceeded
 */

import Anthropic from '@anthropic-ai/sdk';
import config from '../config/index.js';
import logger from '../utils/logger.js';

export async function runAgentLoop({
  model,
  system,
  messages,
  tools,
  maxIterations,
  maxTokens,
  executeTool,
  onToolCall = null,
  onTurnText = null,
}) {
  if (!config.claude?.apiKey) {
    throw new Error('ANTHROPIC_API_KEY not configured');
  }

  const client = new Anthropic({ apiKey: config.claude.apiKey });

  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let toolCallCount = 0;

  for (let i = 0; i < maxIterations; i++) {
    const response = await client.messages.create({
      model,
      max_tokens: maxTokens,
      system,
      tools,
      messages,
    });

    totalInputTokens += response.usage?.input_tokens || 0;
    totalOutputTokens += response.usage?.output_tokens || 0;

    if (response.stop_reason === 'end_turn') {
      const text = response.content
        .filter(b => b.type === 'text')
        .map(b => b.text)
        .join('\n');

      return {
        text,
        usage: { inputTokens: totalInputTokens, outputTokens: totalOutputTokens },
        toolCalls: toolCallCount,
      };
    }

    if (response.stop_reason === 'tool_use') {
      const assistantContent = response.content;

      // Notify caller of any text in this tool-use turn (e.g. scratchpad logging)
      const textBlock = assistantContent.find(b => b.type === 'text');
      if (textBlock && onTurnText) {
        onTurnText(textBlock.text, i + 1);
      }

      messages.push({ role: 'assistant', content: assistantContent });

      const toolResults = [];

      for (const block of assistantContent) {
        if (block.type !== 'tool_use') continue;

        toolCallCount++;
        if (onToolCall) onToolCall(block.name, block.input);

        try {
          const result = await executeTool(block.name, block.input);
          toolResults.push({
            type: 'tool_result',
            tool_use_id: block.id,
            content: JSON.stringify(result),
          });
        } catch (err) {
          logger.error(`Tool ${block.name} failed: ${err.message}`);
          toolResults.push({
            type: 'tool_result',
            tool_use_id: block.id,
            content: JSON.stringify({ error: err.message }),
            is_error: true,
          });
        }
      }

      messages.push({ role: 'user', content: toolResults });
    }
  }

  throw new Error(`Agent exceeded maximum iterations (${maxIterations})`);
}
