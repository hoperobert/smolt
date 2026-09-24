import { expect, it } from "vitest";
import { getBuiltinModel } from "../src/providers/all.ts";

it("exposes GLM-4.6V on the China Coding Plan catalog", () => {
	const model = getBuiltinModel("zai-coding-cn", "glm-4.6v");

	expect(model).toMatchObject({
		id: "glm-4.6v",
		provider: "zai-coding-cn",
		api: "openai-completions",
		baseUrl: "https://open.bigmodel.cn/api/coding/paas/v4",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 0.3, output: 0.9, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 32768,
		compat: {
			maxTokensField: "max_tokens",
			thinkingFormat: "zai",
			zaiToolStream: true,
		},
	});
});

it("uses API-equivalent reference costs for Coding Plan models", () => {
	expect(getBuiltinModel("zai", "glm-5.2").cost).toEqual({
		input: 1.4,
		output: 4.4,
		cacheRead: 0.26,
		cacheWrite: 0,
	});
	expect(getBuiltinModel("zai-coding-cn", "glm-5.1").cost).toEqual({
		input: 1.4,
		output: 4.4,
		cacheRead: 0.26,
		cacheWrite: 0,
	});
	expect(getBuiltinModel("zai-coding-cn", "glm-5v-turbo").cost).toEqual({
		input: 1.2,
		output: 4,
		cacheRead: 0.24,
		cacheWrite: 0,
	});
	for (const provider of ["zai", "zai-coding-cn"] as const) {
		expect(getBuiltinModel(provider, "glm-5.3").cost).toEqual({
			input: 1.4,
			output: 4.4,
			cacheRead: 0.26,
			cacheWrite: 0,
		});
	}
});

it("keeps a Coding Plan model whose API catalogue has no price", () => {
	// models.dev's public z.ai listing carries no glm-5.2-highspeed price, so the
	// plan model keeps its zero cost rather than inventing one.
	expect(getBuiltinModel("zai-coding-cn", "glm-4.6v").cost.input).toBe(0.3);
	expect(getBuiltinModel("zai-coding-cn", "glm-5.1").cost).toEqual({
		input: 1.4,
		output: 4.4,
		cacheRead: 0.26,
		cacheWrite: 0,
	});
});
