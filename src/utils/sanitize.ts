export const sanitizePayload = (obj: any): any => {
  if (obj === null || obj === undefined) return obj;

  if (Array.isArray(obj)) {
    return obj.map(sanitizePayload);
  }

  if (typeof obj === 'object') {
    const result: any = {};
    for (const [key, value] of Object.entries(obj)) {
      if (/password|token|secret|key/i.test(key)) {
        result[key] = '[REDACTED]';
      } else {
        result[key] = sanitizePayload(value);
      }
    }
    return result;
  }

  return obj;
};
