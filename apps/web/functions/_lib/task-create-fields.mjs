// Shared by the Pages create route and source-checkout partner publisher.
// Validation never trims, coerces, sorts or otherwise changes signed fields.
export const TASK_CREATE_LIMITS = Object.freeze({
  title: 160, description: 6000, reward: 512, capabilities: 16,
  minTimeoutMs: 60000, maxTimeoutMs: 86400000, bodyBytes: 49152,
});
const token = /^[a-zA-Z0-9][a-zA-Z0-9_.:+-]{0,63}$/;
const text = (value, max) => typeof value === 'string' && value.length > 0
  && value.length <= max && !value.includes('\0') && value.isWellFormed();

export function validTaskCreatePayload(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const { title, description, reward = null, requiredCapabilities = [], timeoutMs = 3600000 } = value;
  return text(title, TASK_CREATE_LIMITS.title) && text(description, TASK_CREATE_LIMITS.description)
    && (reward === null || text(reward, TASK_CREATE_LIMITS.reward))
    && Array.isArray(requiredCapabilities) && requiredCapabilities.length <= TASK_CREATE_LIMITS.capabilities
    && requiredCapabilities.every(c => typeof c === 'string' && token.test(c))
    && Number.isSafeInteger(timeoutMs) && timeoutMs >= TASK_CREATE_LIMITS.minTimeoutMs
    && timeoutMs <= TASK_CREATE_LIMITS.maxTimeoutMs;
}
