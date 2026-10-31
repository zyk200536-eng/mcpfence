/**
 * The stdio->stdio proxy core.
 *
 * Topology:
 *
 *   downstream MCP client  <--stdio-->  [this process]  <--child stdio-->  real MCP server
 *
 * The real server is spawned as a child process and spoken to through the SDK
 * `Client`; a mirrored `Server` is exposed on our own stdio. Every request the
 * downstream client makes is forwarded upstream (capability-aware) and recorded
 * by the UsageLogger on the way through.
 */
import type {
  RequestHandlerExtra,
  RequestOptions,
} from "@modelcontextprotocol/sdk/shared/protocol.js";
import type {
  ClientCapabilities,
  ServerNotification,
  ServerRequest,
} from "@modelcontextprotocol/sdk/types.js";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  CompleteRequestSchema,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListToolsRequestSchema,
  LoggingMessageNotificationSchema,
  PromptListChangedNotificationSchema,
  ReadResourceRequestSchema,
  ResourceListChangedNotificationSchema,
  ResourceUpdatedNotificationSchema,
  RootsListChangedNotificationSchema,
  ResourceUpdatedNotification,
  SetLevelRequestSchema,
  ToolListChangedNotificationSchema,
} from "@modelcontextprotocol/sdk/types.js";

import {
  ToolCatalogEntry,
  UsageLogger,
} from "./logger.js";
import { PolicyStore } from "./policy.js";
import { promptToolPermission } from "./prompt.js";

/** ResultSchema accepts any successful result shape, for pass-through calls. */
const PROXY_NAME = "mcpfence";
const PROXY_VERSION = "0.1.0";

export async function runProxy(options: {
  command: string;
  args: string[];
  name?: string;
  logDir?: string;
  /** "observe" (default): log everything, allow everything. "ask": enforce. */
  mode?: "observe" | "ask";
}): Promise<void> {
  const mode = options.mode ?? "observe";
  const logger = await UsageLogger.create({
    logDir: options.logDir,
    name: options.name,
    command: options.command,
    args: options.args,
  });
  const policy = PolicyStore.load(logger.serverDir);

  const label = options.name ?? options.command;

  // --- upstream: the real MCP server, as a child process -------------------
  const client = new Client(
    { name: PROXY_NAME, version: PROXY_VERSION },
    { capabilities: {} as ClientCapabilities },
  );

  const clientTransport = new StdioClientTransport({
    command: options.command,
    args: options.args,
    stderr: "inherit",
  });

  try {
    await client.connect(clientTransport);
  } catch (error) {
    console.error(
      `[mcpfence] failed to start upstream server "${label}":`,
      error instanceof Error ? error.message : error,
    );
    throw error;
  }

  const serverCapabilities = client.getServerCapabilities() ?? {};
  const serverVersion = client.getServerVersion();

  console.error(
    `[mcpfence] upstream "${label}" connected ` +
      `(server ${serverVersion?.name ?? "?"} ${serverVersion?.version ?? "?"}); ` +
      `capabilities: ${Object.keys(serverCapabilities).join(", ") || "none"}`,
  );

  // --- downstream: the mirrored server on our own stdio --------------------
  const server = new Server(
    serverVersion ?? { name: PROXY_NAME, version: PROXY_VERSION },
    { capabilities: serverCapabilities },
  );

  // Forwards a downstream request upstream, inheriting the caller's lifetime
  // (abort signal) and re-emitting progress notifications with the caller's
  // token so the client can match them.
  const forwardOptions = (
    extra: RequestHandlerExtra<ServerRequest, ServerNotification>,
  ): RequestOptions => {
    const progressToken = extra._meta?.progressToken;
    return {
      signal: extra.signal,
      ...(progressToken === undefined
        ? {}
        : {
            onprogress: (progress) => {
              void extra
                .sendNotification({
                  method: "notifications/progress",
                  params: { ...progress, progressToken },
                })
                .catch((error: unknown) => {
                  console.error("[mcpfence] error forwarding progress:", error);
                });
            },
          }),
    };
  };

  /** Times a forwarded call and records the observation. */
  const observed = async <T>(
    method: string,
    target: string | undefined,
    params: unknown,
    doForward: () => Promise<T>,
  ): Promise<T> => {
    const start = Date.now();
    try {
      const result = await doForward();
      await logger.record({
        ts: new Date().toISOString(),
        method,
        target,
        paramsBytes: byteSize(params),
        durationMs: Date.now() - start,
        ok: true,
      });
      return result;
    } catch (error) {
      await logger.record({
        ts: new Date().toISOString(),
        method,
        target,
        paramsBytes: byteSize(params),
        durationMs: Date.now() - start,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  };

  const byteSize = (value: unknown): number => {
    try {
      return Buffer.byteLength(JSON.stringify(value) ?? "", "utf8");
    } catch {
      return 0;
    }
  };

  // Capability-gated handlers: a method the upstream never advertised is
  // answered "method not found" locally instead of a wasted round trip.
  if (serverCapabilities.tools) {
    server.setRequestHandler(ListToolsRequestSchema, async (request, extra) => {
      const result = await observed(
        "tools/list",
        undefined,
        request.params,
        () => client.listTools(request.params, forwardOptions(extra)),
      );
      // Refresh the declared-tool catalog: this is the "declared" column of
      // the later permission report.
      const catalog: ToolCatalogEntry[] = result.tools.map((tool) => ({
        name: tool.name,
        ...(tool.description === undefined ? {} : { description: tool.description }),
      }));
      void logger.recordToolCatalog(catalog);
      return result;
    });

    server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
      const toolName = request.params.name;
      void logger.recordToolCall({
        ts: new Date().toISOString(),
        tool: toolName,
        argsBytes: byteSize(request.params.arguments),
      });

      // Intercept in ask mode: decide before anything touches the upstream.
      if (mode === "ask" && policy.decide(toolName) !== "allow") {
        let allowed = false;
        if (policy.decide(toolName) === "ask") {
          const answer = promptToolPermission({
            server: label,
            tool: toolName,
            signal: extra.signal,
          });
          if (answer === "allowAlways" || answer === "denyAlways") {
            policy.remember(toolName, answer === "allowAlways" ? "allow" : "deny");
          }
          allowed = answer === "allow" || answer === "allowAlways";
        }
        // Explicit "deny" from policy, an unrecognized prompt answer, or no
        // terminal at all: all fail closed.
        if (!allowed) {
          await logger.record({
            ts: new Date().toISOString(),
            method: "tools/call",
            target: toolName,
            paramsBytes: byteSize(request.params.arguments),
            ok: false,
            error: "blocked by policy",
          });
          return {
            content: [
              {
                type: "text" as const,
                text:
                  `mcpfence: tool "${toolName}" was denied by the local permission firewall ` +
                  `(not pre-approved and no terminal answered). Pre-approve it via policy.json.`,
              },
            ],
            isError: true,
          };
        }
      }

      return observed(
        "tools/call",
        toolName,
        request.params,
        () => client.callTool(request.params, undefined, forwardOptions(extra)),
      );
    });
  }

  if (serverCapabilities.resources) {
    server.setRequestHandler(
      ListResourcesRequestSchema,
      async (request, extra) =>
        observed("resources/list", undefined, request.params, () =>
          client.listResources(request.params, forwardOptions(extra)),
        ),
    );

    server.setRequestHandler(
      ListResourceTemplatesRequestSchema,
      async (request, extra) =>
        observed("resources/templates/list", undefined, request.params, () =>
          client.listResourceTemplates(request.params, forwardOptions(extra)),
        ),
    );

    server.setRequestHandler(
      ReadResourceRequestSchema,
      async (request, extra) =>
        observed(
          "resources/read",
          request.params.uri,
          request.params,
          () => client.readResource(request.params, forwardOptions(extra)),
        ),
    );
  }

  if (serverCapabilities.prompts) {
    server.setRequestHandler(
      ListPromptsRequestSchema,
      async (request, extra) =>
        observed("prompts/list", undefined, request.params, () =>
          client.listPrompts(request.params, forwardOptions(extra)),
        ),
    );

    server.setRequestHandler(GetPromptRequestSchema, async (request, extra) =>
      observed("prompts/get", request.params.name, request.params, () =>
        client.getPrompt(request.params, forwardOptions(extra)),
      ),
    );
  }

  if (serverCapabilities.completions) {
    server.setRequestHandler(
      CompleteRequestSchema,
      async (request, extra) =>
        observed("completion/complete", undefined, request.params, () =>
          client.complete(request.params, forwardOptions(extra)),
        ),
    );
  }

  if (serverCapabilities.logging) {
    // Answered locally (one connection, one level) then applied upstream.
    server.setRequestHandler(SetLevelRequestSchema, async (request) => {
      await client.setLoggingLevel(request.params.level);
      return {};
    });
  }

  // --- upstream -> downstream notifications --------------------------------
  const forwardNotification = (send: () => Promise<void>): void => {
    if (server.transport === undefined) return;
    send().catch((error: unknown) => {
      console.error("[mcpfence] error forwarding notification:", error);
    });
  };

  for (const [schema, method] of [
    [ToolListChangedNotificationSchema, "notifications/tools/list_changed"],
    [
      ResourceListChangedNotificationSchema,
      "notifications/resources/list_changed",
    ],
    [
      PromptListChangedNotificationSchema,
      "notifications/prompts/list_changed",
    ],
  ] as const) {
    client.setNotificationHandler(schema, () =>
      forwardNotification(() => server.notification({ method })),
    );
  }

  client.setNotificationHandler(ResourceUpdatedNotificationSchema, (params) =>
    forwardNotification(() =>
      server.notification({
        method: "notifications/resources/updated",
        params: params.params,
      }),
    ),
  );

  client.setNotificationHandler(LoggingMessageNotificationSchema, (params) =>
    forwardNotification(() =>
      server.notification({
        method: "notifications/message",
        params: params.params,
      }),
    ),
  );

  // --- downstream -> upstream notifications --------------------------------
  // `notifications/initialized` is handled by the SDK on both sides; the one
  // notification a client may legitimately send mid-session is roots changes.
  server.setNotificationHandler(RootsListChangedNotificationSchema, async () => {
    try {
      await client.notification({ method: "notifications/roots/list_changed" });
    } catch (error) {
      console.error("[mcpfence] error forwarding roots change:", error);
    }
  });

  // --- lifecycle ------------------------------------------------------------
  // Upstream died -> tell the downstream client by closing our stdio server.
  client.onclose = () => {
    console.error(`[mcpfence] upstream "${label}" exited`);
    void server.close().catch(() => {});
  };

  server.onclose = () => {
    void client.close().catch(() => {});
  };

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`[mcpfence] proxying "${label}" on stdio`);
}
