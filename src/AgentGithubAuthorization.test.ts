import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import AgentGithubAuthorization from "./AgentGithubAuthorization";

const authorization = { connection_id: "public-id", authorization_url: "https://github.com/login/oauth/authorize?state=public-state", expires_at: Date.now() + 600_000 };
test("GitHub authorization preserves the signed-in tab without opener access", () => {
  const html = renderToStaticMarkup(createElement(AgentGithubAuthorization, { authorization }));
  expect(html).toContain('target="_blank"');
  expect(html).toContain('rel="noopener noreferrer"');
  expect(html).toContain("Load my repositories");
  expect(html).toContain("https://github.com/login/oauth/authorize?state=public-state");
});
test("expired or unexpected authorization URLs cannot be followed", () => {
  expect(renderToStaticMarkup(createElement(AgentGithubAuthorization, { authorization: { ...authorization, expires_at: 0 } }))).not.toContain("<a");
  expect(() => renderToStaticMarkup(createElement(AgentGithubAuthorization, { authorization: { ...authorization, authorization_url: "https://evil.example/authorize" } }))).toThrow();
});
