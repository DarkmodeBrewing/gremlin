const maximumMetadataBytes = 32 * 1024;
const maximumMetadataDepth = 8;

const forbiddenMetadataKeys = new Set([
  "accesstoken",
  "apikey",
  "authorization",
  "clientsecret",
  "cookie",
  "credentials",
  "passwd",
  "password",
  "privatekey",
  "refreshtoken",
  "secret",
  "sessionid",
  "setcookie",
  "token"
]);

const unsafeObjectKeys = new Set(["__proto__", "constructor", "prototype"]);

function normalizedKey(key: string): string {
  return key.toLowerCase().replaceAll(/[^a-z0-9]/g, "");
}

function isSensitiveKey(key: string): boolean {
  const normalized = normalizedKey(key);

  return (
    forbiddenMetadataKeys.has(normalized) ||
    [
      "apikey",
      "authorization",
      "clientsecret",
      "cookie",
      "credentials",
      "passwd",
      "password",
      "privatekey",
      "secret",
      "sessionid",
      "token"
    ].some((suffix) => normalized.endsWith(suffix))
  );
}

function findUnsafeMetadata(
  value: unknown,
  path: readonly string[],
  depth: number
): string | null {
  if (depth > maximumMetadataDepth) {
    return "metadata nesting is too deep";
  }

  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      const issue = findUnsafeMetadata(item, [...path, String(index)], depth + 1);

      if (issue !== null) {
        return issue;
      }
    }

    return null;
  }

  if (value === null || typeof value !== "object") {
    return null;
  }

  for (const [key, child] of Object.entries(value)) {
    const keyPath = [...path, key].join(".");

    if (unsafeObjectKeys.has(key)) {
      return `unsafe metadata key: ${keyPath}`;
    }

    if (isSensitiveKey(key)) {
      return `sensitive metadata key: ${keyPath}`;
    }

    const issue = findUnsafeMetadata(child, [...path, key], depth + 1);

    if (issue !== null) {
      return issue;
    }
  }

  return null;
}

export function validateMetadata(metadata: Record<string, unknown>): string | null {
  const serialized = JSON.stringify(metadata);

  if (Buffer.byteLength(serialized, "utf8") > maximumMetadataBytes) {
    return "metadata exceeds 32 KiB";
  }

  return findUnsafeMetadata(metadata, [], 0);
}
