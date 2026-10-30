/** 轻量类名合并：过滤假值后以空格拼接（不引入第三方依赖）。 */
export type ClassValue = string | false | null | undefined;

export function cn(...parts: ClassValue[]): string {
  return parts.filter(Boolean).join(" ");
}
