import Schema from "@deepseek-ai/schemastery";

//#region src/config.ts
const Config = Schema.object({ enabled: Schema.boolean().default(true) });
const defaults = { enabled: true };
function resolveConfig(config = {}) {
	return {
		...defaults,
		...config
	};
}

//#endregion
//#region src/index.ts
const name = "dsh-privacy-gateway";
function apply(ctx, config = {}) {
	if (!resolveConfig(config).enabled) {
		ctx.logger.info("dsh-privacy-gateway: disabled by config");
		return;
	}
	ctx.logger.info("dsh-privacy-gateway: loaded (masking not implemented yet)");
}

//#endregion
export { Config, apply, name };