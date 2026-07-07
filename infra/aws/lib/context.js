// Pure context helpers for the CDK app — no CDK imports, so they unit-test offline.

function getContext(node, key, fallback) {
  const value = node.tryGetContext(key);
  return value === undefined ? fallback : value;
}

// CDK delivers `-c key=value` as a STRING. Accept a real array (the in-code default) or a
// JSON-array string, and validate it is a non-empty list of ARN strings. This exists because
// spreading a raw string into an IAM policy Resource scatters it character-by-character
// ("-","/","1",...) — a silent, deploy-breaking bug on exactly the override path the runbook
// tells operators to use. Fail synth loudly instead.
function parseArnList(value, contextKey) {
  let list = value;
  if (typeof value === 'string') {
    try {
      list = JSON.parse(value);
    } catch {
      throw new Error(
        `context "${contextKey}" must be a JSON array of ARN strings, ` +
          `e.g. -c '${contextKey}=["arn:aws:bedrock:us-east-1::foundation-model/..."]' (received: ${value})`,
      );
    }
  }
  if (
    !Array.isArray(list) ||
    list.length === 0 ||
    !list.every((x) => typeof x === 'string' && x.startsWith('arn:'))
  ) {
    throw new Error(
      `context "${contextKey}" must be a non-empty array of ARN strings (each starting with "arn:"); received: ${JSON.stringify(list)}`,
    );
  }
  return list;
}

module.exports = { getContext, parseArnList };
