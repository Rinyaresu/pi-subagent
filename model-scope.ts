export const MODEL_SCOPE_ENV = "PI_SUBAGENT_SCOPED_MODELS";

export interface ScopedModel {
	provider: string;
	id: string;
	thinkingLevel?: string;
}

export function readModelScope(): ScopedModel[] {
	const value = process.env[MODEL_SCOPE_ENV];
	if (!value) throw new Error("Subagent model scope is unavailable. Run /reload in the parent Pi session.");
	const models: unknown = JSON.parse(value);
	if (!Array.isArray(models) || models.some((model) =>
		!model || typeof model.provider !== "string" || typeof model.id !== "string" ||
		(model.thinkingLevel !== undefined && typeof model.thinkingLevel !== "string")
	)) throw new Error("Invalid subagent model scope. Run /reload in the parent Pi session.");
	if (models.length === 0) throw new Error("Subagent spawning requires Scoped Models. Select models with /scoped-models first.");
	return models;
}

export function requireScopedModel(provider: string, id: string): ScopedModel {
	const models = readModelScope();
	const selected = models.find((model) => model.provider === provider && model.id === id);
	if (!selected) throw new Error(`Subagent model ${provider}/${id} is outside the parent session's Scoped Models. Allowed: ${models.map((model) => `${model.provider}/${model.id}`).join(", ")}`);
	return selected;
}

export function modelScopePrompt(models: ScopedModel[]): string {
	return "Subagent model scope:\n" + (models.length === 0
		? "Subagent spawning is blocked until the user selects Scoped Models."
		: "Use only these provider/model pairs for subagent spawn; models outside this list are rejected:\n" +
			models.map((model) => `- ${model.provider}/${model.id}${model.thinkingLevel ? ` (thinking: ${model.thinkingLevel})` : ""}`).join("\n")) +
		"\nChoose an eligible model for the task. Existing provider, project-scope, and authorization restrictions still apply. If no listed model is eligible, report the blocker; do not use an unlisted fallback or change the scope.";
}
