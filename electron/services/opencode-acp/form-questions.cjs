// OpenCode's question tool uses string choices, string arrays and optional *_custom fields.
function readFormQuestions(schema) {
  if (schema?.type !== "object" || !schema.properties || typeof schema.properties !== "object"
    || Array.isArray(schema.properties) || schema.required !== undefined && !Array.isArray(schema.required)) return null;
  const properties = schema.properties;
  if (Object.keys(properties).some(key => ["__proto__", "constructor", "prototype"].includes(key))) return null;
  const required = schema.required || [];
  if (required.some(key => typeof key !== "string" || !Object.hasOwn(properties, key))) return null;
  const customFields = Object.fromEntries(Object.entries(properties).flatMap(([key, field]) => {
    const base = key.endsWith("_custom") ? key.slice(0, -7) : null;
    return base && Object.hasOwn(properties, base) && field?.type === "string" && !required.includes(key)
      ? [[base, key]] : [];
  }));
  const customKeys = new Set(Object.values(customFields));
  const fields = [];
  for (const [key, field] of Object.entries(properties)) {
    if (customKeys.has(key)) continue;
    if (!field || (field.type !== "string" && field.type !== "array")
      || field.type === "array" && field.items?.type !== "string") return null;
    const valueSchema = field.type === "array" ? field.items : field;
    const raw = valueSchema.oneOf || valueSchema.anyOf || valueSchema.enum || [];
    if (!Array.isArray(raw)) return null;
    const options = raw.map(option => typeof option === "string" ? { label: option, value: option, description: "" }
      : typeof option?.const === "string" ? { label: option.title || option.const, value: option.const, description: option.description || "" } : null);
    if (options.some(option => !option || typeof option.label !== "string" || !option.label.trim())
      || new Set(options.map(option => option.label)).size !== options.length
      || field.type === "array" && !options.length) return null;
    fields.push({ key, field, options, customField: customFields[key], required: required.includes(key) });
  }
  if (!fields.length) return null;
  return { fields, questions: fields.map(({ key, field, options, customField, required: isRequired }) => ({
    id: key, header: field.title || key, question: field.description || field.title || key,
    multiSelect: field.type === "array", isOther: Boolean(customField) || !options.length,
    required: isRequired, options: options.map(({ label, description }) => ({ label, description }))
  })) };
}

function formAnswerContent(form, answers) {
  if (!answers || typeof answers !== "object" || Array.isArray(answers)
    || Object.keys(answers).some(key => !form.fields.some(field => field.key === key))) throw new Error("问题答案无效。");
  const content = Object.create(null);
  for (const { key, field, options, customField, required } of form.fields) {
    const answer = answers[key];
    if (answer !== undefined && (!answer || typeof answer !== "object" || Array.isArray(answer)
      || !Array.isArray(answer.answers))) throw new Error("问题答案无效。");
    const values = answer?.answers || [];
    const custom = answer?.customAnswer;
    if (!Array.isArray(values) || values.some(value => typeof value !== "string" || !value.trim())
      || custom !== undefined && (typeof custom !== "string" || !custom.trim() || !customField)) throw new Error("问题答案无效。");
    // UI retains the custom answer in answers for the conversation record, and marks it explicitly.
    const selected = [...values];
    if (custom !== undefined) {
      if (selected.at(-1) !== custom) throw new Error("自定义答案无效。");
      selected.pop();
    }
    if (field.type === "string" && selected.length > 1
      || new Set(selected).size !== selected.length) throw new Error("问题答案无效。");
    const converted = selected.map(value => {
      if (!options.length) return value;
      const option = options.find(option => option.label === value);
      if (!option) throw new Error("问题答案不在可用选项中。");
      return option.value;
    });
    if (!converted.length && custom === undefined) {
      if (required) throw new Error("请回答所有必填问题。");
      continue;
    }
    if (custom !== undefined) content[customField] = custom;
    if (field.type === "array") content[key] = converted;
    else if (converted.length) content[key] = converted[0];
    // OpenCode replaces the base selection with the custom text. Supply a valid base value
    // when the schema requires it even for a custom-only answer.
    else if (required) content[key] = options[0]?.value || custom;
  }
  return content;
}

module.exports = { readFormQuestions, formAnswerContent };
