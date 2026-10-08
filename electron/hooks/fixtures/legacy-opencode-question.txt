const askGraphicalQuestion = async (input, url, token) => {
  const questions = input.questions.map((item, index) => ({
    id: `q_${index}`, header: item.header, question: item.question,
    multiSelect: item.multiple === true, allowCustomAnswer: item.custom !== false,
    options: item.options
  }));
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: crypto.randomUUID(), method: "tools/call",
      params: { name: "ask_user_question", arguments: { questions } } })
  });
  if (!response.ok) throw new Error(`Pannel Handle 提问通道返回 HTTP ${response.status}。`);
  const reply = await response.json();
  if (reply.error || reply.result?.isError) throw new Error(reply.error?.message || reply.result?.content?.[0]?.text || "提问已取消。");
  const answers = JSON.parse(reply.result?.content?.[0]?.text || "{}").answers;
  if (!answers || typeof answers !== "object") throw new Error("Pannel Handle 提问通道返回了无效答案。");
  const formatted = questions.map(question => `"${question.question}"="${(answers[question.id] || []).join(", ")}"`).join(", ");
  return { content: `User has answered your questions: ${formatted}. You can now continue with the user's answers in mind.`,
    metadata: { answers: questions.map(question => answers[question.id] || []) } };
};

export default {
  id: "pannel-handle-graphical-question",
  async setup(ctx) {
    const url = process.env.PANNEL_HANDLE_OPENCODE_QUESTION_URL;
    const token = process.env.PANNEL_HANDLE_OPENCODE_QUESTION_TOKEN;
    if (!url || !token) return;
    await ctx.tool.transform(editor => {
      editor.add({
        name: "question",
        description: "Ask the user one or more questions and wait for their answers in Pannel Handle.",
        input: { type: "object", additionalProperties: false, required: ["questions"], properties: {
          questions: { type: "array", minItems: 1, items: { type: "object", additionalProperties: false,
            required: ["header", "question", "options"], properties: {
              header: { type: "string" }, question: { type: "string" }, multiple: { type: "boolean" },
              custom: { type: "boolean" }, options: { type: "array", items: { type: "object",
                additionalProperties: false, required: ["label"], properties: {
                  label: { type: "string" }, description: { type: "string" }
                } } }
            } } }
        } },
        execute: input => askGraphicalQuestion(input, url, token)
      });
    });
  }
};
