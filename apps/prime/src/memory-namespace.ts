import { z } from "zod";

export const memoryNamespaceJsonSchemaPattern = "^[a-z0-9][a-z0-9/-]*$";

function isLowercaseAlphaNumeric(character: string): boolean {
  const codePoint = character.codePointAt(0);

  return (
    codePoint !== undefined &&
    ((codePoint >= 48 && codePoint <= 57) ||
      (codePoint >= 97 && codePoint <= 122))
  );
}

function isValidNamespace(namespace: string): boolean {
  return namespace.split("/").every((segment) => {
    if (
      segment.length === 0 ||
      !isLowercaseAlphaNumeric(segment[0]!) ||
      !isLowercaseAlphaNumeric(segment.at(-1)!)
    ) {
      return false;
    }

    let previousWasHyphen = false;

    for (const character of segment) {
      if (character === "-") {
        if (previousWasHyphen) {
          return false;
        }

        previousWasHyphen = true;
        continue;
      }

      if (!isLowercaseAlphaNumeric(character)) {
        return false;
      }

      previousWasHyphen = false;
    }

    return true;
  });
}

export const memoryNamespaceSchema = z
  .string()
  .min(1)
  .max(200)
  .refine(isValidNamespace);
