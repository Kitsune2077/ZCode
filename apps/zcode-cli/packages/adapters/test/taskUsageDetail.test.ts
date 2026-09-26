import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { queryTaskUsageDetail } from "../src/storage/session-store/repositories/usage.js";

/**
 * 用内存 SQLite 建出 usage 三表的最小列集合，直接跑真实 SQL——
 * 列名/聚合/排序只有在真库上执行才能证明，纯类型检查拦不住写错的列。
 */
function createDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    create table model_usage (
      id text primary key,
      session_id text not null,
      turn_id text,
      query_source text not null default 'main_turn',
      model_id text not null,
      status text not null,
      started_at integer not null,
      first_token_at integer,
      completed_at integer,
      duration_ms integer,
      time_to_first_token_ms integer,
      output_tokens integer not null default 0,
      input_tokens integer not null default 0,
      computed_total_tokens integer not null default 0,
      provider_total_tokens integer
    );
    create table turn_usage (
      session_id text not null,
      turn_id text not null,
      status text not null,
      started_at integer not null,
      completed_at integer,
      duration_ms integer,
      time_to_first_token_ms integer,
      model_request_count integer not null default 0,
      tool_call_count integer not null default 0,
      tool_error_count integer not null default 0,
      input_tokens integer not null default 0,
      output_tokens integer not null default 0,
      reasoning_tokens integer not null default 0,
      cache_creation_input_tokens integer not null default 0,
      cache_read_input_tokens integer not null default 0,
      computed_total_tokens integer not null default 0,
      primary key (session_id, turn_id)
    );
    create table tool_usage (
      id text primary key,
      session_id text not null,
      turn_id text,
      tool_call_id text not null,
      tool_name text not null,
      status text not null,
      started_at integer not null,
      duration_ms integer
    );
  `);
  return db;
}

function insertTurn(
  db: DatabaseSync,
  row: { turnId: string; startedAt: number; totalTokens: number; toolErrors?: number },
): void {
  db.prepare(
    `insert into turn_usage (
       session_id, turn_id, status, started_at, duration_ms, time_to_first_token_ms,
       model_request_count, tool_call_count, tool_error_count,
       input_tokens, output_tokens, reasoning_tokens,
       cache_creation_input_tokens, cache_read_input_tokens, computed_total_tokens
     ) values (?, ?, 'completed', ?, 65000, 900, 6, 4, ?, 10000, 2000, 300, 400, 6000, ?)`,
  ).run("sess-1", row.turnId, row.startedAt, row.toolErrors ?? 0, row.totalTokens);
}

test("queryTaskUsageDetail returns the latest request, turn and tool breakdown", async () => {
  const db = createDb();
  try {
    // 两条请求：只有较新的一条应作为 latestRequest，且 generationMs = completed - first_token。
    db.prepare(
      `insert into model_usage (id, session_id, turn_id, model_id, status, started_at,
         first_token_at, completed_at, duration_ms, time_to_first_token_ms, output_tokens, input_tokens,
         computed_total_tokens)
       values ('req-1', 'sess-1', 'turn-1', 'glm-5.3', 'completed', 1000, 1500, 12000, 11000, 500, 800, 100, 900)`,
    ).run();
    db.prepare(
      `insert into model_usage (id, session_id, turn_id, model_id, status, started_at,
         first_token_at, completed_at, duration_ms, time_to_first_token_ms, output_tokens, input_tokens,
         computed_total_tokens)
       values ('req-2', 'sess-1', 'turn-2', 'glm-5.3-flash', 'completed', 20000, 21000, 30000, 10000, 1000, 1000, 200, 1200)`,
    ).run();
    // 进行中的请求：generationMs 必须为 null，不能被当成已完成参与速率。
    db.prepare(
      `insert into model_usage (id, session_id, turn_id, model_id, status, started_at,
         first_token_at, completed_at, duration_ms, time_to_first_token_ms, output_tokens, input_tokens,
         computed_total_tokens)
       values ('req-3', 'sess-1', 'turn-3', 'glm-5.3-flash', 'running', 40000, 41000, null, null, 1000, 300, 50, 400)`,
    ).run();

    insertTurn(db, { turnId: "turn-1", startedAt: 500, totalTokens: 900 });
    insertTurn(db, { turnId: "turn-2", startedAt: 19_000, totalTokens: 12_000, toolErrors: 1 });

    db.prepare(
      `insert into tool_usage (id, session_id, tool_call_id, tool_name, status, started_at, duration_ms)
       values ('t1', 'sess-1', 'c1', 'read', 'completed', 100, 12)`,
    ).run();
    db.prepare(
      `insert into tool_usage (id, session_id, tool_call_id, tool_name, status, started_at, duration_ms)
       values ('t2', 'sess-1', 'c2', 'read', 'completed', 200, 20)`,
    ).run();
    db.prepare(
      `insert into tool_usage (id, session_id, tool_call_id, tool_name, status, started_at, duration_ms)
       values ('t3', 'sess-1', 'c3', 'bash', 'error', 300, null)`,
    ).run();

    const result = await queryTaskUsageDetail(db, { sessionID: "sess-1" });

    assert.equal(result.latestRequest?.requestId, "req-3");
    assert.equal(result.latestRequest?.status, "running");
    assert.equal(result.latestRequest?.generationMs, null);
    assert.equal(result.latestTurn?.turnId, "turn-2");
    assert.equal(result.latestTurn?.totalTokens, 12_000);
    assert.equal(result.latestTurn?.toolErrorCount, 1);
    assert.equal(result.latestTurn?.cacheReadTokens, 6_000);
    assert.equal(result.latestTurn?.durationMs, 65_000);
    assert.equal(result.toolSummary.toolCallCount, 3);
    assert.equal(result.toolSummary.toolErrorCount, 1);
    // 按调用次数排序：read 2 次在前。
    assert.equal(result.toolSummary.items[0]?.toolName, "read");
    assert.equal(result.toolSummary.items[0]?.callCount, 2);
    assert.equal(result.toolSummary.items[1]?.toolName, "bash");
    assert.equal(result.toolSummary.items[1]?.errorCount, 1);
  } finally {
    db.close();
  }
});

test("queryTaskUsageDetail reports empty detail for a session without usage rows", async () => {
  const db = createDb();
  try {
    const result = await queryTaskUsageDetail(db, { sessionID: "sess-empty" });
    assert.equal(result.latestRequest, null);
    assert.equal(result.latestTurn, null);
    assert.deepEqual(result.toolSummary, { toolCallCount: 0, toolErrorCount: 0, items: [] });
  } finally {
    db.close();
  }
});

test("completed requests expose the generation window for the speed metric", async () => {
  const db = createDb();
  try {
    db.prepare(
      `insert into model_usage (id, session_id, model_id, status, started_at,
         first_token_at, completed_at, duration_ms, time_to_first_token_ms, output_tokens, input_tokens,
         computed_total_tokens)
       values ('req-1', 'sess-1', 'glm-5.3', 'completed', 1000, 2000, 12000, 11000, 1000, 1000, 200, 1200)`,
    ).run();

    const result = await queryTaskUsageDetail(db, { sessionID: "sess-1" });
    assert.equal(result.latestRequest?.generationMs, 10_000);
    assert.equal(result.latestRequest?.timeToFirstTokenMs, 1000);
    assert.equal(result.latestRequest?.outputTokens, 1000);
  } finally {
    db.close();
  }
});
