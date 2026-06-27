import { startServer, stopServer } from "../server.js";

const port = 3131;

async function request(path, options = {}) {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, options);
  const body = await response.json();
  return { status: response.status, body };
}

try {
  await startServer({ port, oscPort: 12001 });

  const health = await request("/health");
  if (!health.body.ok) throw new Error("Health check failed.");

  const page = await fetch(`http://127.0.0.1:${port}/`);
  if (!page.ok) throw new Error("Recorder page did not load.");

  const browserMode = await request("/config", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ audioInputMode: "browser" }),
  });
  if (browserMode.body.audioInputMode !== "browser") throw new Error("Browser mode was not saved.");

  const browserCreate = await request("/whispers", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      source: "browser",
      transcript: "a small browser test whisper",
      audioMime: "audio/webm",
      audioBase64: Buffer.from("fake audio").toString("base64"),
      features: {
        amplitude: 0.28,
        brightness: 0.62,
        noisiness: 0.41,
        tremble: 0.18,
      },
      tags: ["test"],
    }),
  });

  if (browserCreate.status !== 201) throw new Error(`Expected 201, got ${browserCreate.status}`);
  if (!browserCreate.body.audioFile) throw new Error("Browser whisper did not save audio.");

  const maxMode = await request("/config", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ audioInputMode: "max" }),
  });
  if (maxMode.body.audioInputMode !== "max") throw new Error("Max mode was not saved.");

  const maxCreate = await request("/whispers", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      source: "max-msp",
      audioFile: "recordings/max_test.wav",
      features: { amplitude: 0.18, brightness: 0.24, noisiness: 0.4, tremble: 0.12 },
    }),
  });

  if (maxCreate.status !== 201) throw new Error(`Expected 201, got ${maxCreate.status}`);
  if (maxCreate.body.audioFile !== "recordings/max_test.wav") throw new Error("Max audioFile path was not preserved.");

  const list = await request("/whispers");
  if (!Array.isArray(list.body.whispers)) throw new Error("Whisper list is not an array.");

  console.log(`OK saved ${browserCreate.body.id} and ${maxCreate.body.id}`);
} finally {
  await stopServer();
}
