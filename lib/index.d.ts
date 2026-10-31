import Schema from "@deepseek-ai/schemastery";

//#region src/config.d.ts

/**
 * Plugin configuration (cordis config object, injected via cordis.patch.yml).
 *
 * Never put `.transform()` or any other callback-bearing node in this schema:
 * dsh-settings rebuilds the form from `Config.toJSON()` and serializes it a
 * second time, the callback is lost on that rebuild, and the settings card
 * never leaves its loading state. Validate at the edit and request boundaries.
 */
interface PrivacyGatewayConfig {
  /** Master switch. */
  enabled?: boolean;
}
declare const Config: Schema<PrivacyGatewayConfig>;
//#endregion
//#region src/index.d.ts
/**
 * dsh-privacy-gateway cordis plugin entry. Design: docs/local/privacy-gateway-design.md
 * (not tracked). The undici dispatcher, the redaction engine and the
 * `/privacy` command are not implemented yet.
 */
interface PluginContext {
  logger: {
    info(...args: unknown[]): void;
    warn(...args: unknown[]): void;
    error(...args: unknown[]): void;
  };
}
declare const name = "dsh-privacy-gateway";
declare function apply(ctx: PluginContext, config?: PrivacyGatewayConfig): void;
//#endregion
export { Config, PluginContext, apply, name };