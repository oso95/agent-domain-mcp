export class AgentError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly action: string,
    public readonly provider: string,
    public readonly raw?: string,
  ) {
    super(message);
    this.name = 'AgentError';
  }

  toJSON() {
    return {
      error: {
        code: this.code,
        message: this.message,
        action: this.action,
        provider: this.provider,
        ...(this.raw ? { raw: this.raw } : {}),
      },
    };
  }
}

export function isAgentError(err: unknown): err is AgentError {
  return err instanceof AgentError;
}

/** Returns structured error object (not serialized). Use for embedding in response objects. */
export function errorToObject(err: unknown): { code: string; message: string; action: string; provider?: string; raw?: string } {
  if (err instanceof AgentError) {
    return {
      code: err.code,
      message: err.message,
      action: err.action,
      provider: err.provider,
      ...(err.raw ? { raw: err.raw } : {}),
    };
  }
  if (err instanceof Error) {
    return { code: 'ERROR', message: err.message, action: 'Try again or check your credentials and network connectivity.' };
  }
  return { code: 'ERROR', message: String(err), action: 'Try again or check your credentials and network connectivity.' };
}

/** Returns serialized error string for MCP tool text responses. */
export function formatErrorForAgent(err: unknown): string {
  return JSON.stringify({ error: errorToObject(err) });
}
