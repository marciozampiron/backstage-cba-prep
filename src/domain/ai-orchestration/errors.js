// Domain-safe errors for AI orchestration. Infrastructure adapters MUST map
// provider/SDK exceptions (AWS Bedrock, Strands) into these — the domain and
// application layers never catch a raw SDK error type.

export class AIProviderError extends Error {
  constructor(message, { code = 'ai_provider_error', provider = null, cause = null } = {}) {
    super(message);
    this.name = 'AIProviderError';
    this.code = code;
    this.provider = provider;
    if (cause) this.cause = cause;
  }
}

export class ModelAccessError extends AIProviderError {
  constructor(message, { provider = null, cause = null } = {}) {
    super(message, { code: 'access_denied', provider, cause });
    this.name = 'ModelAccessError';
  }
}

export class ModelNotConfiguredError extends AIProviderError {
  constructor(message, { provider = null, cause = null } = {}) {
    super(message, { code: 'not_configured', provider, cause });
    this.name = 'ModelNotConfiguredError';
  }
}

export class ModelInvocationError extends AIProviderError {
  constructor(message, { provider = null, cause = null } = {}) {
    super(message, { code: 'invocation_failed', provider, cause });
    this.name = 'ModelInvocationError';
  }
}

export class OrchestratorError extends AIProviderError {
  constructor(message, { provider = null, cause = null } = {}) {
    super(message, { code: 'orchestrator_failed', provider, cause });
    this.name = 'OrchestratorError';
  }
}
