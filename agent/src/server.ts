import {
  createServer,
  type IncomingMessage,
  type ServerResponse
} from "node:http";

import { WebSocketServer } from "ws";

import * as acp from "@agentclientprotocol/sdk";

import {
  createNodeHttpHandler,
  createNodeWebSocketUpgradeHandler
} from "@agentclientprotocol/sdk/experimental/node";

import {
  AcpServer
} from "@agentclientprotocol/sdk/experimental/server";

import {
  BedrockRuntimeClient,
  ConverseCommand
} from "@aws-sdk/client-bedrock-runtime";

import {
  Client,
  StreamableHTTPClientTransport
} from "@modelcontextprotocol/client";


/* -------------------------------------------------------
   CONFIGURATION
------------------------------------------------------- */

const AWS_REGION =
  process.env.AWS_REGION ??
  "ap-southeast-2";

const CHAT_MODEL =
  process.env.BEDROCK_CHAT_MODEL ??
  "nvidia.nemotron-super-3-120b";

const MCP_ENDPOINT =
  process.env.MCP_ENDPOINT ??
  "http://127.0.0.1:3000/mcp";

const HOST =
  process.env.HOST ??
  "127.0.0.1";

const PORT =
  Number(process.env.PORT ?? 7331);


/* -------------------------------------------------------
   TYPES
------------------------------------------------------- */

interface ConversationTurn {
  user: string;
  assistant: string;
}

interface SessionState {
  history: ConversationTurn[];
  pending: AbortController | null;
}

interface ToolDecision {
  tool:
    | "get_repository_info"
    | "list_open_issues"
    | "get_issue"
    | "search_repository_context"
    | "get_recent_analysis"
    | "none";

  arguments: Record<string, unknown>;
}


/* -------------------------------------------------------
   AWS
------------------------------------------------------- */

const bedrock =
  new BedrockRuntimeClient({
    region: AWS_REGION
  });


/* -------------------------------------------------------
   MCP CLIENT
------------------------------------------------------- */

let mcpClient: Client | null = null;


async function getMcpClient(): Promise<Client> {

  if (mcpClient) {
    return mcpClient;
  }

  console.log(
    `[agent] Connecting to MCP: ${MCP_ENDPOINT}`
  );

  const client =
    new Client({
      name: "n12371661-repository-agent",
      version: "1.0.0"
    });

  const transport =
    new StreamableHTTPClientTransport(
      new URL(MCP_ENDPOINT)
    );

  await client.connect(transport);

  console.log(
    "[agent] Connected to MCP server"
  );

  mcpClient = client;

  return client;
}


/* -------------------------------------------------------
   BEDROCK
------------------------------------------------------- */

async function askNemotron(
  prompt: string,
  systemText: string
): Promise<string> {

  const response =
    await bedrock.send(
      new ConverseCommand({

        modelId: CHAT_MODEL,

        system: [
          {
            text: systemText
          }
        ],

        messages: [
          {
            role: "user",
            content: [
              {
                text: prompt
              }
            ]
          }
        ],

        inferenceConfig: {
          maxTokens: 900,
          temperature: 0.2
        }
      })
    );

  const content =
    response.output?.message?.content ?? [];

  const text =
    content
      .map(part =>
        "text" in part
          ? part.text ?? ""
          : ""
      )
      .join("")
      .trim();

  if (!text) {
    throw new Error(
      "Bedrock returned an empty response."
    );
  }

  return text;
}


/* -------------------------------------------------------
   ACP HELPERS
------------------------------------------------------- */

function extractPromptText(
  prompt: readonly acp.ContentBlock[]
): string {

  return prompt
    .flatMap(part =>
      part.type === "text"
        ? [part.text]
        : []
    )
    .join("\n")
    .trim();
}


async function sendText(
  sessionId: string,
  text: string,
  context: acp.AgentContext
): Promise<void> {

  await context.notify(
    acp.methods.client.session.update,
    {
      sessionId,

      update: {
        sessionUpdate:
          "agent_message_chunk",

        content: {
          type: "text",
          text
        }
      }
    }
  );
}


/* -------------------------------------------------------
   TOOL ROUTING
------------------------------------------------------- */

function fallbackToolDecision(
  input: string
): ToolDecision {

  const text =
    input.toLowerCase();

  const issueMatch =
    text.match(
      /(?:issue\s*#?|#)(\d+)/
    );

  if (issueMatch) {

    return {
      tool: "get_issue",
      arguments: {
        issueNumber:
          Number(issueMatch[1])
      }
    };
  }

  if (
    text.includes("open issue") ||
    text.includes("list issue") ||
    text.includes("all issue")
  ) {

    return {
      tool: "list_open_issues",
      arguments: {
        limit: 10
      }
    };
  }

  if (
    text.includes("repository info") ||
    text.includes("repository information") ||
    text.includes("about the repository")
  ) {

    return {
      tool: "get_repository_info",
      arguments: {}
    };
  }

  if (
    text.includes("recent analysis") ||
    text.includes("previous analysis") ||
    text.includes("issue analysis")
  ) {

    return {
      tool: "get_recent_analysis",
      arguments: {
        limit: 5
      }
    };
  }

  /*
     Default to semantic retrieval.

     This is useful because normal repository
     questions become retrieval-grounded instead
     of being answered from model memory.
  */

  return {
    tool: "search_repository_context",
    arguments: {
      query: input,
      topK: 3
    }
  };
}


function parseToolDecision(
  response: string,
  originalInput: string
): ToolDecision {

  try {

    const start =
      response.indexOf("{");

    const end =
      response.lastIndexOf("}");

    if (
      start === -1 ||
      end === -1
    ) {

      return fallbackToolDecision(
        originalInput
      );
    }

    const parsed =
      JSON.parse(
        response.slice(
          start,
          end + 1
        )
      );

    const allowed =
      new Set([
        "get_repository_info",
        "list_open_issues",
        "get_issue",
        "search_repository_context",
        "get_recent_analysis",
        "none"
      ]);

    if (
      !allowed.has(parsed.tool)
    ) {

      return fallbackToolDecision(
        originalInput
      );
    }

    return {
      tool: parsed.tool,
      arguments:
        parsed.arguments ?? {}
    };

  } catch {

    return fallbackToolDecision(
      originalInput
    );
  }
}


async function chooseTool(
  input: string
): Promise<ToolDecision> {

  const routingPrompt = `
User question:

${input}

Choose exactly one Repository Custodian MCP tool.

Available tools:

1. get_repository_info
Use for general repository metadata.

2. list_open_issues
Use when the user asks to list or summarise open issues.
Arguments:
{"limit":10}

3. get_issue
Use for one specific GitHub issue.
Arguments:
{"issueNumber":1}

4. search_repository_context
Use for semantic questions about bugs, authentication,
documentation, API behaviour, README information,
or other repository knowledge.
Arguments:
{"query":"the user's question","topK":3}

5. get_recent_analysis
Use for analysis records previously stored in DynamoDB.
Arguments:
{"limit":5}

Return ONLY JSON.

Example:

{
  "tool": "search_repository_context",
  "arguments": {
    "query": "authentication problems",
    "topK": 3
  }
}
`;

  const answer =
    await askNemotron(
      routingPrompt,

      `You are the tool-routing component of
       the n12371661 Repository Custodian.
       Select the most appropriate tool.
       Do not answer the user's question.
       Return only valid JSON.`
    );

  const decision =
    parseToolDecision(
      answer,
      input
    );

  console.log(
    `[agent] Selected tool: ${decision.tool}`
  );

  console.log(
    `[agent] Arguments:`,
    decision.arguments
  );

  return decision;
}


/* -------------------------------------------------------
   MCP TOOL EXECUTION
------------------------------------------------------- */

async function callMcpTool(
  decision: ToolDecision
): Promise<string> {

  if (
    decision.tool === "none"
  ) {

    return "No repository tool was required.";
  }

  const client =
    await getMcpClient();

  const response =
    await client.callTool({
      name: decision.tool,
      arguments: decision.arguments
    });

  const content =
    (response.content ?? []) as any[];

  const text =
    content
      .filter(
        part =>
          part.type === "text"
      )
      .map(
        part =>
          part.text
      )
      .join("\n")
      .trim();

  if (!text) {

    return JSON.stringify(
      response,
      null,
      2
    );
  }

  return text;
}


/* -------------------------------------------------------
   FINAL RESPONSE
------------------------------------------------------- */

async function createFinalAnswer(
  userInput: string,
  decision: ToolDecision,
  toolResult: string,
  history: ConversationTurn[]
): Promise<string> {

  const historyText =
    history
      .slice(-4)
      .map(
        turn =>
          `User: ${turn.user}
Assistant: ${turn.assistant}`
      )
      .join("\n\n");

  const prompt = `
Previous conversation:

${historyText || "(none)"}

Current user question:

${userInput}

Repository tool used:

${decision.tool}

Repository tool result:

${toolResult}

Answer the user's current question.

Rules:

- Base repository-specific claims on the supplied tool result.
- Do not invent GitHub issues or repository facts.
- Be concise and helpful.
- Mention issue numbers where useful.
- If the tool result does not contain enough information,
  say what information is missing.
`;

  const response =
    await askNemotron(

      prompt,

      `You are the n12371661 CAB432
       Repository Custodian.

       You help users understand and
       maintain the demonstration GitHub
       repository.

       Repository facts must come from the
       MCP tool result supplied to you.`
    );

  return (
    `${response}\n\n` +
    `_Repository tool used: ${decision.tool}_`
  );
}


/* -------------------------------------------------------
   ACP AGENT
------------------------------------------------------- */

class RepositoryCustodianAgent {

  private readonly sessions =
    new Map<string, SessionState>();


  initialize(
    _params: acp.InitializeRequest
  ): acp.InitializeResponse {

    return {
      protocolVersion:
        acp.PROTOCOL_VERSION,

      agentCapabilities: {
        loadSession: false
      }
    };
  }


  newSession(
    _params: acp.NewSessionRequest
  ): acp.NewSessionResponse {

    const sessionId =
      crypto.randomUUID();

    this.sessions.set(
      sessionId,
      {
        history: [],
        pending: null
      }
    );

    console.log(
      `[agent] New ACP session: ${sessionId}`
    );

    return {
      sessionId
    };
  }


  async prompt(
    params: acp.PromptRequest,
    context: acp.AgentContext
  ): Promise<acp.PromptResponse> {

    const session =
      this.sessions.get(
        params.sessionId
      );

    if (!session) {

      throw new Error(
        `Unknown session: ${params.sessionId}`
      );
    }

    session.pending?.abort();

    const controller =
      new AbortController();

    session.pending =
      controller;

    try {

      const userText =
        extractPromptText(
          params.prompt
        );

      const imagePart =
        params.prompt.find(
          part =>
            part.type === "image"
        );

      /*
         Nemotron Super is text-only.
         We still support ACP inline image
         send/receive by acknowledging and
         returning the image.
      */

      if (
        imagePart &&
        !userText
      ) {

        await sendText(
          params.sessionId,

          "I received the image successfully. " +
          "The current CAB432 Nemotron model is " +
          "text-only, so I am returning the image " +
          "inline to confirm ACP image transport.",

          context
        );

        await context.notify(
          acp.methods.client.session.update,
          {
            sessionId:
              params.sessionId,

            update: {
              sessionUpdate:
                "agent_message_chunk",

              content:
                imagePart
            }
          }
        );

        return {
          stopReason: "end_turn"
        };
      }


      const question =
        userText ||
        "The user supplied an image.";

      const decision =
        await chooseTool(
          question
        );


      if (
        controller.signal.aborted
      ) {

        return {
          stopReason: "cancelled"
        };
      }


      const toolResult =
        await callMcpTool(
          decision
        );


      console.log(
        `[agent] MCP result received for ${decision.tool}`
      );


      const answer =
        await createFinalAnswer(
          question,
          decision,
          toolResult,
          session.history
        );


      if (
        controller.signal.aborted
      ) {

        return {
          stopReason: "cancelled"
        };
      }


      await sendText(
        params.sessionId,
        answer,
        context
      );


      /*
         If an image was included together
         with text, echo it back inline after
         answering the text question.
      */

      if (imagePart) {

        await sendText(
          params.sessionId,

          "\n\nImage attachment received successfully:",

          context
        );

        await context.notify(
          acp.methods.client.session.update,
          {
            sessionId:
              params.sessionId,

            update: {
              sessionUpdate:
                "agent_message_chunk",

              content:
                imagePart
            }
          }
        );
      }


      session.history.push({
        user:
          question,

        assistant:
          answer
      });


      /*
         Keep memory small for this
         assessment demo.
      */

      if (
        session.history.length > 10
      ) {

        session.history =
          session.history.slice(-10);
      }


      return {
        stopReason: "end_turn"
      };

    } catch (error) {

      const message =
        error instanceof Error
          ? error.message
          : String(error);

      console.error(
        "[agent] Error:",
        error
      );

      await sendText(
        params.sessionId,

        `Repository Custodian error: ${message}`,

        context
      );

      return {
        stopReason: "end_turn"
      };

    } finally {

      if (
        session.pending === controller
      ) {

        session.pending =
          null;
      }
    }
  }


  cancel(
    params: acp.CancelNotification
  ): void {

    this.sessions
      .get(params.sessionId)
      ?.pending
      ?.abort();
  }
}


/* -------------------------------------------------------
   HTTP HELPERS
------------------------------------------------------- */

function pathName(
  request: IncomingMessage
): string {

  return new URL(
    request.url ?? "/",
    `http://${request.headers.host ?? "localhost"}`
  ).pathname;
}


function sendResponse(
  response: ServerResponse,
  status: number,
  body: string,
  contentType: string
): void {

  const payload =
    Buffer.from(
      body,
      "utf8"
    );

  response.writeHead(
    status,
    {
      "Content-Type":
        contentType,

      "Content-Length":
        payload.byteLength,

      "Cache-Control":
        "no-store"
    }
  );

  response.end(
    payload
  );
}


/* -------------------------------------------------------
   CREATE ACP SERVER
------------------------------------------------------- */

const implementation =
  new RepositoryCustodianAgent();


const agent =
  acp
    .agent({
      name:
        "n12371661-repository-custodian"
    })

    .onRequest(
      acp.methods.agent.initialize,

      context =>
        implementation.initialize(
          context.params
        )
    )

    .onRequest(
      acp.methods.agent.session.new,

      context =>
        implementation.newSession(
          context.params
        )
    )

    .onRequest(
      acp.methods.agent.session.prompt,

      context =>
        implementation.prompt(
          context.params,
          context.client
        )
    )

    .onNotification(
      acp.methods.agent.session.cancel,

      context =>
        implementation.cancel(
          context.params
        )
    );


const acpServer =
  new AcpServer({
    agent
  });


const acpHttpHandler =
  createNodeHttpHandler(
    acpServer
  );


const webSocketServer =
  new WebSocketServer({
    noServer: true
  });


const acpWebSocketUpgradeHandler =
  createNodeWebSocketUpgradeHandler(
    acpServer,
    webSocketServer
  );


/* -------------------------------------------------------
   HTTP SERVER
------------------------------------------------------- */

const server =
  createServer(
    (request, response) => {

      const pathname =
        pathName(request);


      if (
        pathname === "/healthz"
      ) {

        sendResponse(
          response,
          200,

          JSON.stringify({
            status: "ok",
            service:
              "n12371661-repository-custodian-agent",
            model:
              CHAT_MODEL,
            mcp:
              MCP_ENDPOINT,
            region:
              AWS_REGION
          }),

          "application/json; charset=utf-8"
        );

        return;
      }


      if (
        pathname === "/acp"
      ) {

        acpHttpHandler(
          request,
          response
        );

        return;
      }


      sendResponse(
        response,
        404,
        "Not found\n",
        "text/plain; charset=utf-8"
      );
    }
  );


server.on(
  "upgrade",

  (
    request,
    socket,
    head
  ) => {

    if (
      pathName(request) !== "/acp"
    ) {

      socket.destroy();

      return;
    }

    acpWebSocketUpgradeHandler(
      request,
      socket,
      head
    );
  }
);


/* -------------------------------------------------------
   START
------------------------------------------------------- */

server.listen(
  PORT,
  HOST
);


server.on(
  "listening",
  () => {

    console.log(
      `Repository Custodian ACP Agent`
    );

    console.log(
      `WebSocket: ws://${HOST}:${PORT}/acp`
    );

    console.log(
      `Health: http://${HOST}:${PORT}/healthz`
    );

    console.log(
      `Bedrock model: ${CHAT_MODEL}`
    );

    console.log(
      `MCP endpoint: ${MCP_ENDPOINT}`
    );
  }
);


process.once(
  "SIGINT",
  async () => {

    await mcpClient?.close();

    server.close();
  }
);


process.once(
  "SIGTERM",
  async () => {

    await mcpClient?.close();

    server.close();
  }
);