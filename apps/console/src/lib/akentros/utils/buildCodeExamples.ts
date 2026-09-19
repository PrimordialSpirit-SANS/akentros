export type CodeLanguage = "curl" | "javascript" | "typescript" | "python";

export interface CodeExample {
  label: string;
  language: string;
  code: string;
}

export function buildCodeExamples(apiRoot: string, model: string): Record<CodeLanguage, CodeExample> {
  const endpoint = `${apiRoot}/chat/completions`;

  return {
    curl: {
      label: "cURL",
      language: "bash",
      code: `curl ${endpoint} \\
  -H "Authorization: Bearer $AKENTROS_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "${model}",
    "messages": [
      { "role": "user", "content": "YOUR_MESSAGE" }
    ],
    "stream": true
  }'`,
    },
    javascript: {
      label: "JavaScript",
      language: "javascript",
      code: `import OpenAI from "openai";

const client = new OpenAI({
  apiKey: process.env.AKENTROS_API_KEY,
  baseURL: "${apiRoot}",
});

const stream = await client.chat.completions.create({
  model: "${model}",
  messages: [
    { role: "user", content: "YOUR_MESSAGE" },
  ],
  stream: true,
});

for await (const chunk of stream) {
  process.stdout.write(chunk.choices[0]?.delta?.content ?? "");
}`,
    },
    typescript: {
      label: "TypeScript",
      language: "typescript",
      code: `import OpenAI from "openai";

const client = new OpenAI({
  apiKey: process.env.AKENTROS_API_KEY!,
  baseURL: "${apiRoot}",
});

const stream = await client.chat.completions.create({
  model: "${model}",
  messages: [
    { role: "user", content: "YOUR_MESSAGE" },
  ],
  stream: true,
});

for await (const chunk of stream) {
  process.stdout.write(chunk.choices[0]?.delta?.content ?? "");
}`,
    },
    python: {
      label: "Python",
      language: "python",
      code: `import os
from openai import OpenAI

client = OpenAI(
    api_key=os.environ["AKENTROS_API_KEY"],
    base_url="${apiRoot}",
)

stream = client.chat.completions.create(
    model="${model}",
    messages=[
        {"role": "user", "content": "YOUR_MESSAGE"}
    ],
    stream=True,
)

for chunk in stream:
    if chunk.choices:
        print(chunk.choices[0].delta.content or "", end="")`,
    },
  };
}
