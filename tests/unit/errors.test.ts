import { describe, it, expect } from 'vitest';
import { AgentError, isAgentError, formatErrorForAgent, errorToObject } from '../../src/errors.js';

describe('AgentError', () => {
  it('creates error with all fields', () => {
    const err = new AgentError(
      'AUTH_FAILED',
      'Authentication failed.',
      'Check your API key.',
      'porkbun',
      'raw error message',
    );
    expect(err.code).toBe('AUTH_FAILED');
    expect(err.message).toBe('Authentication failed.');
    expect(err.action).toBe('Check your API key.');
    expect(err.provider).toBe('porkbun');
    expect(err.raw).toBe('raw error message');
    expect(err.name).toBe('AgentError');
  });

  it('is an instance of Error', () => {
    const err = new AgentError('CODE', 'msg', 'action', 'provider');
    expect(err).toBeInstanceOf(Error);
  });

  it('serializes to JSON without raw field', () => {
    const err = new AgentError('CODE', 'message', 'action', 'porkbun');
    const json = err.toJSON();
    expect(json.error.code).toBe('CODE');
    expect(json.error.message).toBe('message');
    expect(json.error.action).toBe('action');
    expect(json.error.provider).toBe('porkbun');
  });
});

describe('isAgentError', () => {
  it('returns true for AgentError', () => {
    expect(isAgentError(new AgentError('X', 'y', 'z', 'p'))).toBe(true);
  });

  it('returns false for regular Error', () => {
    expect(isAgentError(new Error('test'))).toBe(false);
  });

  it('returns false for non-error values', () => {
    expect(isAgentError(null)).toBe(false);
    expect(isAgentError('string')).toBe(false);
    expect(isAgentError(42)).toBe(false);
  });
});

describe('errorToObject', () => {
  it('returns object (not string) for AgentError', () => {
    const err = new AgentError('AUTH_FAILED', 'Auth failed.', 'Check key.', 'porkbun');
    const obj = errorToObject(err);
    expect(typeof obj).toBe('object');
    expect(obj.code).toBe('AUTH_FAILED');
    expect(obj.action).toBe('Check key.');
    expect(obj.provider).toBe('porkbun');
  });

  it('includes raw field when present on AgentError', () => {
    const err = new AgentError('AUTH_FAILED', 'Auth failed.', 'Check key.', 'porkbun', 'raw provider response');
    const obj = errorToObject(err);
    expect(obj.raw).toBe('raw provider response');
  });

  it('omits raw field when not set on AgentError', () => {
    const err = new AgentError('CODE', 'msg', 'action', 'provider');
    const obj = errorToObject(err);
    expect('raw' in obj).toBe(false);
  });

  it('returns object for plain Error', () => {
    const obj = errorToObject(new Error('something broke'));
    expect(obj.code).toBe('ERROR');
    expect(obj.message).toBe('something broke');
    expect(obj.action).toContain('Try again');
  });
});

describe('formatErrorForAgent', () => {
  it('formats AgentError with code and action', () => {
    const err = new AgentError('AUTH_FAILED', 'Auth failed.', 'Check key.', 'porkbun');
    const formatted = formatErrorForAgent(err);
    expect(formatted).toContain('AUTH_FAILED');
    expect(formatted).toContain('Auth failed.');
    expect(formatted).toContain('Check key.');
    expect(formatted).toContain('porkbun');
  });

  it('formats regular Error', () => {
    const err = new Error('Something broke');
    const formatted = formatErrorForAgent(err);
    expect(formatted).toContain('Something broke');
  });

  it('formats unknown values', () => {
    const formatted = formatErrorForAgent('just a string');
    expect(formatted).toContain('just a string');
  });

  it('always returns valid JSON', () => {
    const cases = [
      new AgentError('CODE', 'msg', 'action', 'provider'),
      new Error('regular error'),
      'string error',
      42,
      null,
    ];
    for (const c of cases) {
      expect(() => JSON.parse(formatErrorForAgent(c))).not.toThrow();
    }
  });

  it('AgentError output has error.code and error.action fields', () => {
    const err = new AgentError('AUTH_FAILED', 'Auth failed.', 'Check key.', 'porkbun');
    const parsed = JSON.parse(formatErrorForAgent(err));
    expect(parsed.error.code).toBe('AUTH_FAILED');
    expect(parsed.error.action).toBe('Check key.');
    expect(parsed.error.provider).toBe('porkbun');
  });
});
