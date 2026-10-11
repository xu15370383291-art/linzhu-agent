export function toolSuccess(content, details) {
  return { content: typeof content === 'string' ? content : JSON.stringify(content), isError: false, ...(details === undefined ? {} : { details }) };
}

export function toolError(code, content, { terminate = false, details } = {}) {
  return { content, isError: true, errorCode: code, terminate, ...(details === undefined ? {} : { details }) };
}
