// Emulate grouped database results for service tests; SQL execution is tested separately.
export function dashboardRows(rows, [device, provider, start, limit, offset, date]) {
  const sessions = rows.filter(r => r.table_name === "token_sessions" && (!device || r.device_id === device)
    && r.data.provider !== "qwen" && (provider === "all" || r.data.provider === provider) && Number(r.data.updated_at || 0) >= start);
  const matches = (r, s) => r.device_id === s.device_id && (r.data.backup_epoch || 0) === (s.data.backup_epoch || 0) && r.data.session_id === s.data.id;
  const related = rows.filter(r => ["token_session_models", "token_session_skills", "token_session_mcp_tools"].includes(r.table_name)
    && sessions.some(s => matches(r, s)));
  const page = [...sessions].sort((a,b) => b.data.updated_at-a.data.updated_at).slice(offset, offset+limit);
  const result = [...page, ...related.filter(r => page.some(s => matches(r,s)))];
  const groups = new Map();
  const fields = ["input_tokens", "cached_input_tokens", "cache_write_input_tokens", "output_tokens", "reasoning_output_tokens", "total_tokens"];
  for (const r of sessions) {
    const key = `session:${r.data.provider}`;
    if (!groups.has(key)) groups.set(key, {table_name:"session_totals",data:{provider:r.data.provider,session_count:0}});
    const data=groups.get(key).data; data.session_count++;
    for (const f of fields) data[f]=Number(data[f]||0)+Number(r.data[f]||0);
  }
  for (const r of rows.filter(r => r.table_name === "token_daily" && (!device || r.device_id === device)
    && r.data.provider !== "qwen" && (provider === "all" || r.data.provider === provider) && r.data.date >= date)) {
    const key=`daily:${r.data.date}`;
    if (!groups.has(key)) groups.set(key,{table_name:"token_daily",data:{date:r.data.date}});
    const data=groups.get(key).data;
    for (const f of fields) data[f]=Number(data[f]||0)+Number(r.data[f]||0);
  }
  for (const r of related.filter(r => r.table_name !== "token_session_models")) {
    const table=r.table_name === "token_session_skills" ? "skill_totals" : "tool_totals";
    const key=JSON.stringify([table,r.data.name,r.data.server_name,r.data.tool_name]);
    if (!groups.has(key)) groups.set(key,{table_name:table,data:{...r.data,count:0}});
    groups.get(key).data.count+=Number(r.data.count||0);
  }
  return [...result,...groups.values()];
}
