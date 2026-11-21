// Generate art assets via CLIProxyAPI (local OpenAI-compatible proxy at :8317).
// Usage: node test/genimg.mjs
import { execSync } from "node:child_process";
import { writeFileSync } from "node:fs";

import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const TOKEN =
  process.env.OA_LLM_TOKEN ??
  execSync(join(homedir(), ".local/libexec/codex2-cliproxy-token")).toString().trim();
const OUT = join(dirname(fileURLToPath(import.meta.url)), "../src/client/public/tex");

const JOBS = [
  {
    file: "ground.png",
    size: "1024x1024",
    prompt:
      "Seamless tileable top-down terrain texture for a dark sci-fi real-time strategy game. " +
      "Very dark desaturated green-black scorched battlefield soil with subtle tonal variation, " +
      "faint worn patches and sparse tiny debris, completely flat ambient lighting, no shadows, " +
      "no objects, no text, uniform density so it tiles edge-to-edge seamlessly.",
  },
  {
    file: "sky.png",
    size: "1024x1024",
    prompt:
      "Extremely dark deep-space starfield texture, near-black midnight blue space with sparse dim " +
      "pin-point stars and a very faint whisper of dark teal nebula in one corner, no bright objects, " +
      "no planets, subtle and moody, background texture for a dark sci-fi game.",
  },
  {
    file: "lobby-bg.png",
    size: "1536x1024",
    prompt:
      "Dark cinematic key art for a sci-fi real-time strategy game, isometric night battlefield, " +
      "futuristic low-poly tanks with glowing red and cyan team lights advancing across dark terrain, " +
      "glowing amber ore crystal clusters, faint muzzle flashes, dramatic rim lighting, deep shadows, " +
      "video game concept art, moody, no text, no logo, no watermark.",
  },
];

for (const job of JOBS) {
  console.log("generating", job.file);
  const res = await fetch("http://127.0.0.1:8317/v1/images/generations", {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: "gpt-image-2.5-flare", prompt: job.prompt, size: job.size, n: 1 }),
  });
  const d = await res.json();
  const b64 = d?.data?.[0]?.b64_json;
  if (!b64) {
    console.log("FAILED", job.file, JSON.stringify(d).slice(0, 300));
    continue;
  }
  writeFileSync(`${OUT}/${job.file}`, Buffer.from(b64, "base64"));
  console.log("wrote", job.file);
}
console.log("done");
