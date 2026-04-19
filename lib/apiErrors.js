export function zodToFieldErrors(issues = []) {
  const out = {};
  for (const issue of issues) {
    const key = Array.isArray(issue?.path) && issue.path.length ? String(issue.path[0]) : null;
    if (!key) continue;
    if (!out[key]) out[key] = issue.message;
  }
  return out;
}

export function sendError(res, status, code, message, opts = {}) {
  const { fieldErrors, issues, ...rest } = opts;
  const payload = {
    error: code,
    message: message || undefined,
    ...(fieldErrors ? { fieldErrors } : {}),
    ...(issues ? { issues } : {}),
    ...rest,
  };
  return res.status(status).json(payload);
}

export function validationError(res, issues, message = "Validation failed") {
  return sendError(res, 400, "VALIDATION_ERROR", message, {
    fieldErrors: zodToFieldErrors(issues),
    issues,
  });
}
