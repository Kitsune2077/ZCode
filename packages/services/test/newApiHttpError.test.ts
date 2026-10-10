import assert from "node:assert/strict";
import test from "node:test";
import {
  NewApiProvisioningError,
  requestNewApiJson,
} from "../src/model-provider/newApiHttp.js";

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    headers: { "Content-Type": "application/json" },
    status,
  });
}

test("non-2xx failures keep the server error code and message", async () => {
  const fetchImpl: typeof fetch = async () =>
    jsonResponse(
      { success: false, message: "token scope is denied", code: "ACCESS_TOKEN_SCOPE_DENIED" },
      403,
    );

  await assert.rejects(
    requestNewApiJson(
      { fetch: fetchImpl },
      { code: "token-list-failed", method: "GET", url: "https://relay.example.com/api/token/" },
    ),
    (error) =>
      error instanceof NewApiProvisioningError &&
      error.message.includes("HTTP 403") &&
      error.message.includes("ACCESS_TOKEN_SCOPE_DENIED") &&
      error.message.includes("token scope is denied"),
  );
});

test("non-2xx failures without a JSON envelope still report the status", async () => {
  const fetchImpl: typeof fetch = async () =>
    new Response("<html>Bad Gateway</html>", { status: 502 });

  await assert.rejects(
    requestNewApiJson(
      { fetch: fetchImpl },
      { code: "token-list-failed", method: "GET", url: "https://relay.example.com/api/token/" },
    ),
    (error) =>
      error instanceof NewApiProvisioningError &&
      error.message === "NewAPI request https://relay.example.com/api/token/ failed with HTTP 502.",
  );
});

test("2xx non-JSON responses still fail as non-JSON", async () => {
  const fetchImpl: typeof fetch = async () =>
    new Response("<html>unexpected</html>", { status: 200 });

  await assert.rejects(
    requestNewApiJson(
      { fetch: fetchImpl },
      { code: "token-list-failed", method: "GET", url: "https://relay.example.com/api/token/" },
    ),
    (error) =>
      error instanceof NewApiProvisioningError &&
      error.message === "NewAPI returned non-JSON response.",
  );
});
