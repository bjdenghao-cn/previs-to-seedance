import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import fetch from "node-fetch";

const SEEDANCE_API = process.env.SEEDANCE_API_ENDPOINT;
const SEEDANCE_KEY = process.env.SEEDANCE_API_KEY;

if (!SEEDANCE_API || !SEEDANCE_KEY) {
  throw new Error(
    "SEEDANCE_API_ENDPOINT and SEEDANCE_API_KEY must be set before starting my-seedance."
  );
}

const server = new Server(
  { name: "my-seedance", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "seedance_generate_video",
      description:
        "Call a private Seedance API using a Blender playblast as motion reference.",
      inputSchema: {
        type: "object",
        required: ["prompt"],
        properties: {
          prompt: { type: "string" },
          negative_prompt: { type: "string" },
          duration: { type: "number" },
          motion_reference_video: {
            type: "string",
            description: "Public Blender playblast MP4 URL used for motion lock.",
          },
          reference_image: { type: "string" },
          fps: { type: "number", default: 24 },
          width: { type: "number", default: 1920 },
          height: { type: "number", default: 1080 },
        },
      },
    },
  ],
}));

async function readJsonResponse(response, context) {
  const body = await response.text();
  let data;
  try {
    data = body ? JSON.parse(body) : {};
  } catch {
    throw new Error(`${context} returned non-JSON data (HTTP ${response.status}).`);
  }

  if (!response.ok) {
    const detail = data.error || data.message || `HTTP ${response.status}`;
    throw new Error(`${context} failed: ${detail}`);
  }
  return data;
}

async function submitSeedanceTask(payload) {
  const response = await fetch(`${SEEDANCE_API.replace(/\/$/, "")}/tasks`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${SEEDANCE_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  const data = await readJsonResponse(response, "Seedance task submission");
  if (!data.task_id) throw new Error("Seedance response did not include task_id.");
  return data.task_id;
}

async function pollTask(taskId) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const response = await fetch(
      `${SEEDANCE_API.replace(/\/$/, "")}/tasks/${encodeURIComponent(taskId)}`,
      { headers: { Authorization: `Bearer ${SEEDANCE_KEY}` } }
    );
    const data = await readJsonResponse(response, "Seedance task poll");
    if (data.status === "succeeded") {
      if (!data.output_video_url) {
        throw new Error("Succeeded Seedance task did not include output_video_url.");
      }
      return data.output_video_url;
    }
    if (data.status === "failed") {
      throw new Error(`Seedance task failed: ${data.error || "unknown error"}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }
  throw new Error("Seedance poll timeout after 120 attempts.");
}

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params;
  if (name !== "seedance_generate_video") {
    throw new Error(`Unknown tool: ${name}`);
  }

  const taskId = await submitSeedanceTask({
    ...args,
    fps: args.fps ?? 24,
    width: args.width ?? 1920,
    height: args.height ?? 1080,
  });
  const videoUrl = await pollTask(taskId);
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({ task_id: taskId, final_video_url: videoUrl }),
      },
    ],
  };
});

const transport = new StdioServerTransport();
await server.connect(transport);
