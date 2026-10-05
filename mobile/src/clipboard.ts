export async function copyMobileText(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) { try { await navigator.clipboard.writeText(text); return; } catch { /* LAN HTTP may lack clipboard permission. */ } }
  const active = document.activeElement as HTMLElement | null;
  const field = document.createElement("textarea");
  field.value = text; field.style.position = "fixed"; field.style.opacity = "0";
  document.body.appendChild(field); field.select();
  try { if (!document.execCommand?.("copy")) throw new Error("浏览器无法复制，请长按选择文本。"); }
  finally { field.remove(); active?.focus(); }
}
