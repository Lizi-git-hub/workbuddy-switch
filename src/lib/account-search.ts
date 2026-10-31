
/** 归一化：小写、去首尾空白。 */
function normalize(value: string): string {
  return value.trim().toLowerCase();
}

/**
 * 把账号的可搜索字段拼成一个**归一化**字符串（小写、去空白）。
 *
 * 字段之间用空格分隔，因此「昵称 + 邮箱」这类跨字段关键词不会被误命中；
 * 缺失字段按空串跳过（不产生多余空格）。
 */
export function accountSearchText(fields: {
  name?: string | null;
  email?: string | null;
  uid?: string | null;
  remark?: string | null;
  group?: string | null;
}): string {
  const parts: string[] = [];
  for (const value of [fields.name, fields.email, fields.uid, fields.remark, fields.group]) {
    if (typeof value === "string" && value.length > 0) parts.push(value);
  }
  return normalize(parts.join(" "));
}

/**
 * 命中判断。空查询恒 `true`（列表不过滤）。
 *
 * 判据是**子串**：`searchText` 与 `query` 都已归一，`includes` 即可。
 */
export function matchesAccountQuery(searchText: string, query: string): boolean {
  const q = normalize(query);
  if (!q) return true;
  return searchText.includes(q);
}
