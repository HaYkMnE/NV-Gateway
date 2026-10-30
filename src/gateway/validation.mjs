import https from 'node:https';
import { createBoundedBuffer, resolveMaxBufferedResponseBytes } from './bounded-buffer.mjs';
import { redact } from '../shared/redaction.mjs';

export function validateKey(key) {
    return new Promise((resolve) => {
        // Validate against the account-level model catalog: a 200 from /v1/models
        // proves NVIDIA accepts the key. We deliberately do NOT call any hardcoded
        // chat-completion test model — a key that lacks access to one specific model
        // would otherwise be misclassified as rejected (403) when it is fully valid.
        const req = https.request({
            hostname: 'integrate.api.nvidia.com',
            port: 443,
            path: '/v1/models',
            method: 'GET',
            headers: {
                'Authorization': 'Bearer ' + key,
                'Accept': 'application/json'
            },
            timeout: 10000
        }, (res) => {
            collectValidationResponse(res, resolveMaxBufferedResponseBytes()).then(resolve);
        });

        req.on('error', () => resolve(sanitizeValidationResult({ valid: null, reason: 'upstream_error', error: 'Validation request failed.' })));
        req.on('timeout', () => {
            req.destroy();
            resolve(sanitizeValidationResult({ valid: null, reason: 'upstream_error', error: 'Validation request timed out.' }));
        });

        req.end();
    });
}

export function collectValidationResponse(res, maxBytes) {
    return new Promise((resolve) => {
        const collector = createBoundedBuffer(maxBytes);
        let settled = false;
        const settle = (result) => { if (!settled) { settled = true; resolve(result); } };
        res.on('data', (chunk) => {
            if (settled) return;
            if (!collector.push(chunk)) {
                settle({ valid: false, error: 'Response too large' });
                res.destroy();
            }
        });
        res.on('end', () => {
            if (settled) return;
            const statusCode = res.statusCode;
            if (statusCode >= 200 && statusCode < 300) {
                settle(sanitizeValidationResult(buildValidModelsResult(collector)));
            } else if (statusCode === 401) {
                settle(sanitizeValidationResult({ valid: false, statusCode, reason: 'unauthorized', error: 'Validation request was rejected.' }));
            } else if (statusCode === 403) {
                settle(sanitizeValidationResult({ valid: false, statusCode, reason: 'rejected', error: 'Validation request was rejected.' }));
            } else if (statusCode === 429) {
                settle(sanitizeValidationResult({ valid: true, rateLimited: true, statusCode: 429, reason: 'rate_limited' }));
            } else if (statusCode >= 500 && statusCode <= 599) {
                settle(sanitizeValidationResult({ valid: null, statusCode, reason: 'upstream_error', error: 'Validation request failed.' }));
            } else {
                settle(sanitizeValidationResult({ valid: false, statusCode, reason: 'rejected', error: 'Validation request was rejected.' }));
            }
        });
        res.on('error', () => settle(sanitizeValidationResult({ valid: null, reason: 'upstream_error', error: 'Validation request failed.' })));
        res.on('aborted', () => settle(sanitizeValidationResult({ valid: null, reason: 'upstream_error', error: 'Response aborted.' })));
    });
}

export function sanitizeValidationResult(result) {
    if (result?.valid === true) {
        if (result?.rateLimited === true || result?.reason === 'rate_limited') {
            return {
                valid: true,
                rateLimited: true,
                statusCode: 429,
                reason: 'rate_limited'
            };
        }
        const accessibleModels = Array.isArray(result?.accessibleModels)
            ? result.accessibleModels.filter((id) => typeof id === 'string')
            : [];
        return {
            valid: true,
            accessibleModels,
            accessibleModelCount: Number.isInteger(result?.accessibleModelCount)
                ? result.accessibleModelCount
                : accessibleModels.length
        };
    }

    if (result?.valid === null) {
        const statusCode = Number.isInteger(result?.statusCode) && result.statusCode >= 100 && result.statusCode <= 599
            ? result.statusCode
            : undefined;
        const fallback = 'Validation request failed.';
        const error = typeof result?.error === 'string' ? String(redact(result.error)).slice(0, 256) : fallback;
        const safeError = ['Response too large', 'Response aborted.', 'Validation request timed out.', 'Validation request was rejected.', 'Validation request failed.'].includes(error)
            ? error
            : fallback;
        return {
            valid: null,
            ...(statusCode === undefined ? {} : { statusCode }),
            reason: result?.reason || 'upstream_error',
            error: safeError
        };
    }

    const statusCode = Number.isInteger(result?.statusCode) && result.statusCode >= 100 && result.statusCode <= 599
        ? result.statusCode
        : undefined;
    const fallback = statusCode === undefined ? 'Validation request failed.' : 'Validation request was rejected.';
    const error = typeof result?.error === 'string' ? String(redact(result.error)).slice(0, 256) : fallback;
    const safeError = ['Response too large', 'Response aborted.', 'Validation request timed out.', 'Validation request was rejected.', 'Validation request failed.'].includes(error)
        ? error
        : fallback;
    const reason = result?.reason || (statusCode === 401 ? 'unauthorized' : statusCode === 403 ? 'rejected' : undefined);

    return {
        valid: false,
        ...(statusCode === undefined ? {} : { statusCode }),
        ...(reason ? { reason } : {}),
        error: safeError
    };
}

function buildValidModelsResult(collector) {
    const accessibleModels = extractAccessibleModels(collector);
    return { valid: true, accessibleModels, accessibleModelCount: accessibleModels.length };
}

function extractAccessibleModels(collector) {
    try {
        const parsed = JSON.parse(collector.toBuffer().toString('utf8'));
        if (parsed && Array.isArray(parsed.data)) {
            const ids = [];
            for (const entry of parsed.data) {
                if (entry && typeof entry.id === 'string' && entry.id.length > 0) {
                    ids.push(String(redact(entry.id)));
                    if (ids.length >= 5000) break;
                }
            }
            return ids;
        }
    } catch {
        // Unparseable or unexpected shape: the key is still valid (HTTP 200 from
        // /v1/models proves account-level acceptance); we simply have no model list.
    }
    return [];
}

function validationFailure(statusCode, error = 'Validation request failed.', reason = undefined) {
    return sanitizeValidationResult({ valid: false, statusCode, error, reason });
}
