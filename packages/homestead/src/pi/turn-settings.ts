import type { ModelThinkingLevel } from "@openoutposts/outpost-protocol";

import { splitModelSpec } from "./session.js";

/**
 * The part of Pi's `AgentSession` a turn's model and reasoning level need.
 *
 * Declared structurally, like `PromptableSession` in `turn.ts`, so the rules
 * below can be exercised against a stand-in session without a live Pi run —
 * every one of them is a refusal, and a refusal is worth testing precisely
 * because nothing downstream will ever notice if it stops happening.
 */
export interface ConfigurableSession<TModel = unknown> {
  readonly model: { provider: string; id: string } | undefined;
  readonly thinkingLevel: ModelThinkingLevel;
  readonly modelRuntime: {
    getModel(providerId: string, modelId: string): TModel | undefined;
  };
  setModel(model: TModel): Promise<void>;
  setThinkingLevel(level: ModelThinkingLevel): void;
}

/**
 * A turn was asked for something the session cannot be set to.
 *
 * It is always the user's own choice that could not be honoured — the model
 * they picked, the reasoning effort they picked — so every message names the
 * thing that was asked for and says that nothing ran in its place.
 */
export class TurnSettingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TurnSettingError";
  }
}

/** `provider/model-id` of whatever the session is currently set to run. */
export function currentModelSpec(session: ConfigurableSession): string | undefined {
  const model = session.model;
  return model === undefined ? undefined : `${model.provider}/${model.id}`;
}

/**
 * Points the session at the model this turn asked for.
 *
 * The product lets a user change the model of a session that is already
 * running, and until this existed the change reached the UI and the database
 * and nothing else: the assignment-time model kept answering under the new
 * model's name. So a turn either runs on the model the user is looking at or it
 * does not run.
 *
 * `credentialProviderId` is the one provider this session holds a credential
 * for. A model from any other provider is refused here rather than handed to
 * Pi, because Pi treats "no credential stored for this provider" as permission
 * to look in the process environment — on a homestead whose operator has a key
 * there, the turn would quietly succeed on the operator's key instead of the
 * session owner's.
 */
export async function applyTurnModel<TModel>(
  session: ConfigurableSession<TModel>,
  spec: string,
  credentialProviderId: string | null
): Promise<void> {
  if (spec === currentModelSpec(session)) return;

  let providerId: string;
  let modelId: string;
  try {
    ({ providerId, modelId } = splitModelSpec(spec));
  } catch {
    throw new TurnSettingError(
      `This turn asked for the model ${spec}, which is not a provider/model-id. ` +
        `The turn was stopped rather than answered by a different model.`
    );
  }

  if (credentialProviderId !== null && credentialProviderId !== providerId) {
    throw new TurnSettingError(
      `This turn asked for ${spec}, but this session's model credential is issued for ` +
        `${credentialProviderId}. Changing provider inside a running session is not supported ` +
        `yet, and the turn was stopped rather than answered by a ${credentialProviderId} model ` +
        `under ${spec}'s name. Start a new session on ${spec}.`
    );
  }

  const model = session.modelRuntime.getModel(providerId, modelId);
  if (model === undefined) {
    throw new TurnSettingError(
      `This turn asked for ${spec}, which this homestead's agent does not have. ` +
        `The turn was stopped rather than answered by a different model.`
    );
  }

  try {
    await session.setModel(model);
  } catch (error) {
    throw new TurnSettingError(
      `This turn asked for ${spec} and the agent refused it: ` +
        `${error instanceof Error ? error.message : String(error)}. ` +
        `The turn was stopped rather than answered by a different model.`
    );
  }

  // Pi's own report of what it will run, not our assumption about what we set.
  const applied = currentModelSpec(session);
  if (applied !== spec) {
    throw new TurnSettingError(
      `This turn asked for ${spec} but the agent is still set to ${applied ?? "no model"}. ` +
        `The turn was stopped rather than answered by a different model.`
    );
  }
}

/**
 * Sets the reasoning level this turn asked for.
 *
 * Pi clamps a level its model does not support down to one it does, silently.
 * That is a reasonable default for an interactive CLI and wrong here: the
 * product shows the user the effort they chose, so an effort that was quietly
 * lowered would be a lie on screen. The level is read back and a mismatch stops
 * the turn.
 */
export function applyTurnThinkingLevel(
  session: ConfigurableSession,
  level: ModelThinkingLevel
): void {
  if (session.thinkingLevel === level) return;
  session.setThinkingLevel(level);
  const applied = session.thinkingLevel;
  if (applied !== level) {
    throw new TurnSettingError(
      `This turn asked for ${level} reasoning, which ${currentModelSpec(session) ?? "this model"} ` +
        `does not support — the agent would have run it at ${applied}. The turn was stopped ` +
        `rather than run at a reasoning level other than the one shown.`
    );
  }
}
