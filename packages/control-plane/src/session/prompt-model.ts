/**
 * The per-prompt model override, checked where the person who typed it can be
 * told the answer.
 *
 * What this replaces: a model that was not in the hardcoded list in
 * `@open-inspect/shared` was dropped with a server-side log warning and nothing
 * else, and the prompt then ran on whatever the session was already using. The
 * homestead-reported catalog deliberately contains models that list has never
 * heard of, so this fired for legitimate selections — the user picked a model,
 * the UI showed it selected, and a different one answered.
 *
 * The authoritative list is the connected homestead's harness catalog, which this
 * Durable Object cannot read cheaply and which was already consulted when the
 * session was created. So the check here is only that the override names a
 * provider at all; a well-formed model the harness cannot serve is refused by
 * the harness, in the turn, naming the model.
 *
 * Either way the prompt is refused rather than quietly rerouted.
 */

import { isModelReference, normalizeModelId } from "@open-inspect/shared";

/**
 * A prompt that cannot run as asked. Carried to the caller's transport —
 * `{ type: "error" }` on the session socket, HTTP 400 on the internal prompt
 * route — so the refusal reaches the person, not just the log.
 */
export class PromptModelError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PromptModelError";
  }
}

/**
 * Validate a per-prompt model override and return it in canonical form.
 *
 * @param model the override as the client sent it
 */
export function validatePromptModel(model: string): string {
  if (!isModelReference(model)) {
    throw new PromptModelError(
      `Cannot run this prompt: "${model}" is not a model reference (expected "provider/model-id"). ` +
        "The prompt was not sent."
    );
  }

  return normalizeModelId(model);
}
