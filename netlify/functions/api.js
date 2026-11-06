export { default as default } from "../../src/serverless.js";

export const config = {
  path: ["/health", "/keys", "/kv/*"]
};
