// src/models/action.ts

import { Action, Tool, ExecutionContext, InputSchema } from '../types/action.types';
import {
  LLMProvider,
  Message,
  LLMParameters,
  LLMStreamHandler,
  ToolDefinition,
  LLMResponse,
} from '../types/llm.types';

/**
 * Special tool that allows LLM to write values to context
 */
class WriteContextTool implements Tool<any, any> {
  name = 'write_context';
  description =
    'Write a value to the workflow context. Use this to store intermediate results or outputs.';
  input_schema = {
    type: 'object',
    properties: {
      key: {
        type: 'string',
        description: 'The key to store the value under',
      },
      value: {
        type: 'string',
        description: 'The value to store (must be JSON stringified if object/array)',
      },
    },
    required: ['key', 'value'],
  } as InputSchema;

  async execute(context: ExecutionContext, params: unknown): Promise<unknown> {
    const { key, value } = params as { key: string; value: string };
    try {
      // Try to parse the value as JSON
      const parsedValue = JSON.parse(value);
      context.variables.set(key, parsedValue);
    } catch {
      // If parsing fails, store as string
      context.variables.set(key, value);
    }
    return { success: true, key, value };
  }
}

function createReturnTool(outputSchema: unknown): Tool<any, any> {
  return {
    name: 'return_output',
    description:
      'Return the final output of this action. Use this to return a value matching the required output schema.',
    input_schema: {
      type: 'object',
      properties: {
        value: outputSchema || {
          // Default to accepting any JSON value
          type: ['string', 'number', 'boolean', 'object', 'null'],
          description: 'The output value',
        },
      } as unknown,
      required: ['value'],
    } as InputSchema,

    async execute(context: ExecutionContext, params: unknown): Promise<unknown> {
      const { value } = params as { value: unknown };
      context.variables.set('__action_output', value);
      return { returned: value };
    },
  };
}

export class ActionImpl implements Action {
  private readonly maxRounds: number = 10; // Default max rounds
  private writeContextTool: WriteContextTool;

  constructor(
    public type: 'prompt', // Only support prompt type
    public name: string,
    public description: string,
    public tools: Tool<any, any>[],
    private llmProvider: LLMProvider,
    private llmConfig?: LLMParameters,
    config?: { maxRounds?: number }
  ) {
    this.writeContextTool = new WriteContextTool();
    this.tools = [...tools, this.writeContextTool];
    if (config?.maxRounds) {
      this.maxRounds = config.maxRounds;
    }
  }

  private async executeSingleRound(
    messages: Message[],
    params: LLMParameters,
    toolMap: Map<string, Tool<any, any>>,
    context: ExecutionContext
  ): Promise<{
    response: LLMResponse | null;
    hasToolUse: boolean;
    roundMessages: Message[];
  }> {
    const roundMessages: Message[] = [];
    let hasToolUse = false;
    let response: LLMResponse | null = null;

    // Buffer to collect into roundMessages
    let assistantTextMessage = '';
    let toolUseMessage: Message | null = null;
    let toolResultMessage: Message | null = null;

    // Track tool execution promise
    let toolExecutionPromise: Promise<void> | null = null;

    const handler: LLMStreamHandler = {
      onContent: (content) => {
        if (content.trim()) {
          assistantTextMessage += content;
        }
      },
      onToolUse: async (toolCall) => {
        console.log('Tool Call:', toolCall.name, toolCall.input);
        hasToolUse = true;

        const tool = toolMap.get(toolCall.name);
        if (!tool) {
          throw new Error(`Tool not found: ${toolCall.name}`);
        }

        toolUseMessage = {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: toolCall.id,
              name: tool.name,
              input: toolCall.input,
            },
          ],
        };

        // Store the promise of tool execution
        toolExecutionPromise = (async () => {
          try {
            // beforeToolUse
            context.__skip = false;
            if (context.callback && context.callback.hooks.beforeToolUse) {
              let modified_input = await context.callback.hooks.beforeToolUse(
                tool,
                context,
                toolCall.input
              );
              if (modified_input) {
                toolCall.input = modified_input;
              }
            }
            if (context.__skip || context.__abort) {
              toolResultMessage = {
                role: 'user',
                content: [
                  {
                    type: 'tool_result',
                    tool_use_id: toolCall.id,
                    content: 'skip',
                  },
                ],
              };
              return;
            }
            // Execute the tool
            let result = await tool.execute(context, toolCall.input);
            // afterToolUse
            if (context.callback && context.callback.hooks.afterToolUse) {
              let modified_result = await context.callback.hooks.afterToolUse(
                tool,
                context,
                result
              );
              if (modified_result) {
                result = modified_result;
              }
            }
            const resultMessage: Message = {
              role: 'user',
              content: [
                result.image && result.image.type
                  ? {
                      type: 'tool_result',
                      tool_use_id: toolCall.id,
                      content: result.text
                        ? [
                            { type: 'image', source: result.image },
                            { type: 'text', text: result.text },
                          ]
                        : [{ type: 'image', source: result.image }],
                    }
                  : {
                      type: 'tool_result',
                      tool_use_id: toolCall.id,
                      content: [{ type: 'text', text: JSON.stringify(result) }],
                    },
              ],
            };
            toolResultMessage = resultMessage;
            console.log('Tool Result:', result);
          } catch (err) {
            const errorMessage = err instanceof Error ? err.message : 'Unknown error occurred';
            const errorResult: Message = {
              role: 'user',
              content: [
                {
                  type: 'tool_result',
                  tool_use_id: toolCall.id,
                  content: [{ type: 'text', text: `Error: ${errorMessage}` }],
                  is_error: true,
                },
              ],
            };
            toolResultMessage = errorResult;
            console.error('Tool Error:', err);
          }
        })();
      },
      onComplete: (llmResponse) => {
        response = llmResponse;
      },
      onError: (error) => {
        console.error('Stream Error:', error);
      },
    };

    this.handleHistoryImageMessages(messages);

    // Wait for stream to complete
    await this.llmProvider.generateStream(messages, params, handler);

    // Wait for tool execution to complete if it was started
    if (toolExecutionPromise) {
      await toolExecutionPromise;
    }

    if (context.__abort) {
      throw new Error('Abort');
    }

    // Add messages in the correct order after everything is complete
    if (assistantTextMessage) {
      roundMessages.push({ role: 'assistant', content: assistantTextMessage });
    }
    if (toolUseMessage) {
      roundMessages.push(toolUseMessage);
    }
    if (toolResultMessage) {
      roundMessages.push(toolResultMessage);
    }

    return { response, hasToolUse, roundMessages };
  }

  private handleHistoryImageMessages(messages: Message[]) {
    // Remove all images of the historical tool call results, except for the last one.
    let last_user = true;
    for (let i = messages.length - 1; i >= 0; i--) {
      const message = messages[i];
      if (message.role === 'user') {
        if (last_user) {
          last_user = false;
          continue;
        }
        if (message.content instanceof Array) {
          let content = message.content as any[];
          for (let j = 0; j < content.length; j++) {
            if (content[j].type === 'tool_result' && content[j].content instanceof Array) {
              let tool_content = content[j].content as any[];
              if (tool_content.length > 0) {
                for (let k = tool_content.length - 1; k >= 0; k--) {
                  if (tool_content[k].type === 'image') {
                    tool_content.splice(k, 1);
                  }
                }
              } else if (tool_content[0].type === 'image') {
                tool_content = [{ type: 'text', text: 'ok' }];
              }
            }
          }
        }
      }
    }
  }

  async execute(
    input: unknown,
    context: ExecutionContext,
    outputSchema?: unknown
  ): Promise<unknown> {
    // Create return tool with output schema
    const returnTool = createReturnTool(outputSchema);

    // Create tool map combining context tools, action tools, and return tool
    const toolMap = new Map<string, Tool<any, any>>();
    this.tools.forEach((tool) => toolMap.set(tool.name, tool));
    context.tools?.forEach((tool) => toolMap.set(tool.name, tool));
    toolMap.set(returnTool.name, returnTool);

    // Prepare initial messages
    const messages: Message[] = [
      { role: 'system', content: this.formatSystemPrompt() },
      { role: 'user', content: this.formatUserPrompt(context, input) },
    ];

    console.log('Starting LLM conversation...');
    console.log('Initial messages:', messages);
    console.log('Output schema:', outputSchema);

    // Configure tool parameters
    const params: LLMParameters = {
      ...this.llmConfig,
      tools: Array.from(toolMap.values()).map((tool) => ({
        name: tool.name,
        description: tool.description,
        input_schema: tool.input_schema,
      })) as ToolDefinition[],
    };

    let roundCount = 0;
    let lastResponse: LLMResponse | null = null;

    while (roundCount < this.maxRounds) {
      roundCount++;
      console.log(`Starting round ${roundCount} of ${this.maxRounds}`);

      console.log('Current conversation status:', JSON.stringify(messages, null, 2));
      const { response, hasToolUse, roundMessages } = await this.executeSingleRound(
        messages,
        params,
        toolMap,
        context
      );

      lastResponse = response;

      // Add round messages to conversation history
      messages.push(...roundMessages);

      // Check termination conditions
      if (!hasToolUse && response) {
        // LLM sent a message without using tools - request explicit return
        console.log('No tool use detected, requesting explicit return');
        console.log('Response:', response);
        const returnOnlyParams = {
          ...params,
          tools: [
            {
              name: returnTool.name,
              description: returnTool.description,
              input_schema: returnTool.input_schema,
            },
          ],
        } as LLMParameters;

        messages.push({
          role: 'user',
          content:
            'Please process the above information and return a final result using the return_output tool.',
        });

        const { roundMessages: finalRoundMessages } = await this.executeSingleRound(
          messages,
          returnOnlyParams,
          new Map([[returnTool.name, returnTool]]),
          context
        );
        messages.push(...finalRoundMessages);
        break;
      }

      if (response?.toolCalls.some((call) => call.name === 'return_output')) {
        console.log('Task completed with return_output tool');
        break;
      }

      // If this is the last round, force an explicit return
      if (roundCount === this.maxRounds) {
        console.log('Max rounds reached, requesting explicit return');
        const returnOnlyParams = {
          ...params,
          tools: [
            {
              name: returnTool.name,
              description: returnTool.description,
              input_schema: returnTool.input_schema,
            },
          ],
        } as LLMParameters;

        messages.push({
          role: 'user',
          content:
            'Maximum number of steps reached. Please return the best result possible with the return_output tool.',
        });

        const { roundMessages: finalRoundMessages } = await this.executeSingleRound(
          messages,
          returnOnlyParams,
          new Map([[returnTool.name, returnTool]]),
          context
        );
        messages.push(...finalRoundMessages);
      }
    }

    // Get and clean up output value
    const output = context.variables.get('__action_output');
    context.variables.delete('__action_output');

    if (output === undefined) {
      console.warn('Action completed without returning a value');
      return {};
    }

    return output;
  }

  private formatSystemPrompt(): string {
    return `You are a task executor. You need to complete the task specified by the user, using the tools provided. When you need to store results or outputs, use the write_context tool. When you are ready to return the final output, use the return_output tool.

    Remember to:
    1. Use tools when needed to accomplish the task
    2. Store important results using write_context, including intermediate and final results
    3. Think step by step about what needs to be done`;
  }

  private formatUserPrompt(context: ExecutionContext, input: unknown): string {
    // Create a description of the current context
    const contextDescription = Array.from(context.variables.entries())
      .map(([key, value]) => `${key}: ${JSON.stringify(value)}`)
      .join('\n');

    return `You are executing the action "${this.name}". The specific instructions are: "${this.description}". You have access to the following context:

    ${contextDescription || 'No context variables set'}

    You have been provided with the following input:
    ${(typeof input === 'string' ? input : JSON.stringify(input, null, 2)) || 'No additional input provided'}
    `;
  }

  // Static factory method
  static createPromptAction(
    name: string,
    description: string,
    tools: Tool<any, any>[],
    llmProvider: LLMProvider,
    llmConfig?: LLMParameters
  ): Action {
    return new ActionImpl('prompt', name, description, tools, llmProvider, llmConfig);
  }
}
