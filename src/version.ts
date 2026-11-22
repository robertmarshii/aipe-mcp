// Versions sent in the User-Agent. test/unit/version.test.ts checks both against package.json
// and the vendored SDK pin, so they cannot drift.
export const MCP_VERSION = '1.0.3';
export const SDK_VERSION = '1.0.6';
export const USER_AGENT = `aipe-mcp/${MCP_VERSION} aipe-sdk/${SDK_VERSION}`;
