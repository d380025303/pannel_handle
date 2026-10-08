export const IMAGE_INPUT_UNSUPPORTED = "当前模型不支持图片输入";
export const isCodexImageFile = (name: string) => /\.(png|jpe?g|gif|webp|bmp)$/i.test(name);

export function supportsCodexImageInput(snapshot: {
  provider?: string; model?: string | null;
  models?: Array<{ id: string; inputModalities?: string[] }>;
} | null | undefined): boolean {
  if (!snapshot || snapshot.provider && snapshot.provider !== "codex") return true;
  const modalities = snapshot.models?.find(model => model.id === snapshot.model)?.inputModalities;
  return !Array.isArray(modalities) || modalities.length === 0
    || !modalities.every(value => typeof value === "string" && value.trim().length > 0)
    || modalities.includes("image");
}
