import { createRequire } from "node:module";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
// Run with node --test and PANNEL_PGLITE_MODULE pointing to an external PGlite installation.
function expect(actual) {
  return {
    toBe: expected => assert.equal(actual, expected),
    toEqual: expected => assert.deepEqual(actual, expected),
    toHaveLength: expected => assert.equal(actual.length, expected),
    toBeLessThan: expected => assert.ok(actual < expected),
    toBeUndefined: () => assert.equal(actual, undefined),
    toMatchObject: expected => {
      const match = (value, subset) => {
        for (const [key, item] of Object.entries(subset)) {
          if (item && typeof item === "object") match(value[key], item);
          else assert.equal(value[key], item);
        }
      };
      match(actual, expected);
    }
  };
}
const require = createRequire(import.meta.url);
const { getRemoteDashboard } = require("./remote-dashboard.cjs");
const sqlTest = process.env.PANNEL_PGLITE_MODULE ? it : it.skip;

describe("remote dashboard SQL integration (PANNEL_PGLITE_MODULE)", () => {
  sqlTest("filters 100000 expired sessions in PostgreSQL and preserves aggregate/page isolation", async () => {
    const { PGlite } = require(process.env.PANNEL_PGLITE_MODULE);
    const db = new PGlite();
    const device = "00000000-0000-0000-0000-000000000001";
    const other = "00000000-0000-0000-0000-000000000002";
    const now = Date.now();
    const returned = [];
    const client = { async query(sql, params) {
      const result = await db.query(sql, params);
      returned.push(result.rows);
      return result;
    } };
    try {
      await db.exec("CREATE TABLE ph_stat_rows (device_id uuid, table_name text, row_key text, data jsonb, PRIMARY KEY(device_id, table_name, row_key))");
      await db.query(`INSERT INTO ph_stat_rows SELECT $1::uuid, 'token_sessions', n::text,
        jsonb_build_object('id', n::text, 'provider', 'codex', 'updated_at', 1, 'total_tokens', 999)
        FROM generate_series(1,100000) n`, [device]);
      const insert = async (dev, table, key, data) => db.query("INSERT INTO ph_stat_rows VALUES ($1,$2,$3,$4)", [dev,table,key,JSON.stringify(data)]);
      const session = { id:"recent", provider:"codex", updated_at:now, started_at:now-100, total_tokens:20 };
      await insert(device,"token_sessions","recent",session);
      await insert(device,"token_session_skills","skill",{session_id:"recent",name:"read",count:3});
      await insert(device,"token_session_mcp_tools","tool",{session_id:"recent",server_name:"srv",tool_name:"tool",count:4});
      await insert(device,"token_session_models","model",{session_id:"recent",model:"model-a"});
      await insert(device,"token_session_skills","expired",{session_id:"1",name:"expired",count:999});
      await insert(device,"token_session_skills","wrong-epoch",{session_id:"recent",backup_epoch:10,name:"wrong",count:999});
      await insert(other,"token_sessions","recent",{...session,total_tokens:80});
      await insert(other,"token_session_skills","skill",{session_id:"recent",name:"read",count:7});
      await insert(device,"token_sessions","claude",{...session,id:"claude",provider:"claude",updated_at:now-1,total_tokens:30});
      await insert(device,"token_sessions","qwen",{...session,id:"qwen",provider:"qwen",total_tokens:999});
      const today=new Date(now).toISOString().slice(0,10);
      await insert(device,"token_daily","today",{date:today,provider:"codex",total_tokens:20});
      await insert(device,"token_daily","old",{date:"1970-01-01",provider:"codex",total_tokens:999});
      await insert(device,"token_daily","qwen",{date:today,provider:"qwen",total_tokens:999});
      await db.exec("ANALYZE ph_stat_rows");
      const result=await getRemoteDashboard(client,{deviceId:device,range:"7d",provider:"codex",limit:50});
      expect(result.summary).toMatchObject({sessionCount:1,averageTokens:20,skillCalls:3,mcpCalls:4,tokens:{totalTokens:20}});
      expect(result.sessions).toHaveLength(1);
      expect(result.sessions[0]).toMatchObject({models:["model-a"],capabilities:{skills:{totalCalls:3},mcp:{totalCalls:4}}});
      expect(result.dailyTrend).toEqual([{date:today,tokens:result.summary.tokens}]);
      expect(result.topSkills).toEqual([{name:"read",count:3}]);
      expect(returned[0]).toHaveLength(8);
      expect(JSON.stringify(returned[0]).length).toBeLessThan(4000);
      const first=await getRemoteDashboard(client,{deviceId:device,range:"7d",limit:1});
      const second=await getRemoteDashboard(client,{deviceId:device,range:"7d",limit:1,offset:1});
      expect(first.totalCount).toBe(2);
      expect(first.summary.tokens.totalTokens).toBe(50);
      expect(first.summary).toEqual(second.summary);
      expect(second.sessions[0].provider).toBe("claude");
      expect(second.sessions[0].capabilities.skills.totalCalls).toBe(0);
      const empty=await getRemoteDashboard(client,{deviceId:device,range:"7d",limit:1,offset:9});
      expect(empty.sessions).toEqual([]);
      expect(empty.summary).toEqual(first.summary);
      const all=await getRemoteDashboard(client,{range:"7d",provider:"codex"});
      expect(all.summary).toMatchObject({sessionCount:2,skillCalls:10,tokens:{totalTokens:100}});
      expect(all.sessions).toHaveLength(2);
      const history=await getRemoteDashboard(client,{deviceId:device,range:"all",provider:"codex",limit:1});
      expect(history.totalCount).toBe(100001);
      expect(history.sessions).toHaveLength(1);
      expect(history.summary.tokens.totalTokens).toBe(99900020);
      if (process.env.PANNEL_DASHBOARD_BASELINE) {
        const baseline = require(process.env.PANNEL_DASHBOARD_BASELINE).getRemoteDashboard;
        const normalize = value => {
          const { generatedAt, ...rest } = value;
          rest.sessions.sort((a, b) => a.id.localeCompare(b.id));
          return rest;
        };
        for (const options of [
          {deviceId:device, range:"7d", provider:"codex"},
          {deviceId:device, range:"7d", limit:1, offset:1},
          {range:"7d", provider:"codex"},
          {deviceId:device, range:"all", provider:"codex", limit:1}
        ]) {
          assert.deepEqual(normalize(await getRemoteDashboard(client, options)),
            normalize(await baseline(db, options)));
        }
      }
    } finally { await db.close(); }
  });
});
