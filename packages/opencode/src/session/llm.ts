import { Provider } from "@/provider/provider"
import * as Log from "@opencode-ai/core/util/log"
import { Context, Effect, Layer, Record, Exit, Cause } from "effect"
import * as Stream from "effect/Stream"
import { streamText, wrapLanguageModel, type ModelMessage, type Tool, tool, jsonSchema } from "ai"
import { mergeDeep } from "remeda"
import { GitLabWorkflowLanguageModel } from "gitlab-ai-provider"
import { ProviderTransform } from "@/provider/transform"
import { Config } from "@/config/config"
import { InstanceState } from "@/effect/instance-state"
import type { Agent } from "@/agent/agent"
import { MessageV2 } from "./message-v2"
import { Plugin } from "@/plugin"
import { SystemPrompt } from "./system"
import { Flag } from "@opencode-ai/core/flag/flag"
import { Permission } from "@/permission"
import { PermissionID } from "@/permission/schema"
import { Bus } from "@/bus"
import { Wildcard } from "@/util/wildcard"
import { SessionID } from "@/session/schema"
import { Auth } from "@/auth"
import { Installation } from "@/installation"
import { InstallationVersion } from "@opencode-ai/core/installation/version"
import { EffectBridge } from "@/effect/bridge"
import * as Option from "effect/Option"
import * as OtelTracer from "@effect/opentelemetry/Tracer"
import { CooldownManager, isRetryable } from "./fallback"
import { ProviderID, ModelID } from "@/provider/schema"

const log = Log.create({ service: "llm" })
const cooldown = new CooldownManager()
export const OUTPUT_TOKEN_MAX = ProviderTransform.OUTPUT_TOKEN_MAX
type Result = Awaited<ReturnType<typeof streamText>>

// Avoid re-instantiating remeda's deep merge types in this hot LLM path; the runtime behavior is still mergeDeep.
const mergeOptions = (target: Record<string, any>, source: Record<string, any> | undefined): Record<string, any> =>
  mergeDeep(target, source ?? {}) as Record<string, any>

export type StreamInput = {
  user: MessageV2.User
  sessionID: string
  parentSessionID?: string
  model: Provider.Model
  agent: Agent.Info
  permission?: Permission.Ruleset
  system: string[]
  messages: ModelMessage[]
  small?: boolean
  tools: Record<string, Tool>
  retries?: number
  toolChoice?: "auto" | "required" | "none"
  fallbacks?: Array<{ providerID: string; modelID: string }>
}

export type StreamRequest = StreamInput & {
  abort: AbortSignal
}

export type Event = Result["fullStream"] extends AsyncIterable<infer T> ? T : never

export interface Interface {
  readonly stream: (input: StreamInput) => Stream.Stream<Event, unknown>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/LLM") {}

const live: Layer.Layer<
  Service,
  never,
  Auth.Service | Config.Service | Provider.Service | Plugin.Service | Permission.Service
> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const auth = yield* Auth.Service
    const config = yield* Config.Service
    const provider = yield* Provider.Service
    const plugin = yield* Plugin.Service
    const perm = yield* Permission.Service

    const cooldownDuration = (err: Record<string, any>, cooldownSeconds: number) => {
      const headers = (err as any)?.data?.responseHeaders ?? {}
      const retryAfterMs = headers["retry-after-ms"]
      if (retryAfterMs) {
        const parsed = Number.parseFloat(retryAfterMs)
        if (!Number.isNaN(parsed)) return Math.ceil(parsed)
      }
      const retryAfter = headers["retry-after"]
      if (retryAfter) {
        const parsed = Number.parseFloat(retryAfter) * 1000
        if (!Number.isNaN(parsed)) return Math.ceil(parsed)
      }
      return cooldownSeconds * 1000
    }

    const withFallback = <A>(
      input: StreamRequest,
      call: (model: Provider.Model, providerID: string, modelID: string) => Effect.Effect<A>,
      l: ReturnType<typeof log.clone>,
    ): Effect.Effect<A, unknown> =>
      Effect.gen(function* () {
        const cfg = yield* config.get()
        const cooldownSeconds = cfg.cooldown_seconds ?? 300
        const fallbacks = input.fallbacks ?? []

        if (fallbacks.length === 0) {
          return yield* call(input.model, input.model.providerID, input.model.id)
        }

        const chain: Array<{ providerID: string; modelID: string }> = [
          { providerID: input.model.providerID, modelID: input.model.id },
          ...fallbacks,
        ]

        let lastError: unknown

        for (let i = 0; i < chain.length; i++) {
          const entry = chain[i]
          const el = l.clone().tag("providerID", entry.providerID).tag("modelID", entry.modelID)

          if (input.abort.aborted) return yield* Effect.fail(new Error("Request aborted"))
          if (cooldown.isCooledDown(entry.providerID, entry.modelID)) {
            el.info("skipping cooled-down entry")
            continue
          }

          let model: Provider.Model
          if (i === 0) {
            model = input.model
          } else {
            const resolved = yield* provider.getModel(ProviderID.make(entry.providerID), ModelID.make(entry.modelID))
              .pipe(Effect.option)
            if (!Option.isSome(resolved)) {
              el.info("fallback model not found, skipping")
              continue
            }
            model = resolved.value
          }

          const result = yield* Effect.exit(call(model, entry.providerID, entry.modelID))

          if (Exit.isSuccess(result)) return result.value

          const err = MessageV2.fromError(Cause.squash(result.cause), { providerID: ProviderID.make(entry.providerID) })
          lastError = err

          if (!isRetryable(err)) {
            el.info("non-retryable error, failing")
            return yield* Effect.fail(err)
          }

          const durationMs = cooldownDuration(err, cooldownSeconds)
          cooldown.put(entry.providerID, entry.modelID, durationMs)
          el.info("retryable error, trying next fallback", { cooldownMs: durationMs })
        }

        return yield* Effect.fail(lastError ?? new Error("All fallback entries skipped"))
      })

    const run = Effect.fn("LLM.run")(function* (input: StreamRequest) {
      const l = log
        .clone()
        .tag("providerID", input.model.providerID)
        .tag("modelID", input.model.id)
        .tag("session.id", input.sessionID)
        .tag("small", (input.small ?? false).toString())
        .tag("agent", input.agent.name)
        .tag("mode", input.agent.mode)
      l.info("stream", {
        modelID: input.model.id,
        providerID: input.model.providerID,
      })

      const language = yield* provider.getLanguage(input.model)
      const [cfg, item, info] = yield* Effect.all(
        [
          config.get(),
          provider.getProvider(input.model.providerID),
          auth.get(input.model.providerID),
        ],
        { concurrency: "unbounded" },
      )

      // TODO: move this to a proper hook
      const isOpenaiOauth = item.id === "openai" && info?.type === "oauth"

      const system: string[] = []
      system.push(
        [
          // use agent prompt otherwise provider prompt
          ...(input.agent.prompt ? [input.agent.prompt] : SystemPrompt.provider(input.model)),
          // any custom prompt passed into this call
          ...input.system,
          // any custom prompt from last user message
          ...(input.user.system ? [input.user.system] : []),
        ]
          .filter((x) => x)
          .join("\n"),
      )

      const header = system[0]
      yield* plugin.trigger(
        "experimental.chat.system.transform",
        { sessionID: input.sessionID, model: input.model },
        { system },
      )
      // rejoin to maintain 2-part structure for caching if header unchanged
      if (system.length > 2 && system[0] === header) {
        const rest = system.slice(1)
        system.length = 0
        system.push(header, rest.join("\n"))
      }

      const variant =
        !input.small && input.model.variants && input.user.model.variant
          ? input.model.variants[input.user.model.variant]
          : {}
      const base = input.small
        ? ProviderTransform.smallOptions(input.model)
        : ProviderTransform.options({
            model: input.model,
            sessionID: input.sessionID,
            providerOptions: item.options,
          })
      const options = mergeOptions(mergeOptions(mergeOptions(base, input.model.options), input.agent.options), variant)
      if (isOpenaiOauth) {
        options.instructions = system.join("\n")
      }

      const isWorkflow = language instanceof GitLabWorkflowLanguageModel
      const messages = isOpenaiOauth
        ? input.messages
        : isWorkflow
          ? input.messages
          : [
              ...system.map(
                (x): ModelMessage => ({
                  role: "system",
                  content: x,
                }),
              ),
              ...input.messages,
            ]

      const params = yield* plugin.trigger(
        "chat.params",
        {
          sessionID: input.sessionID,
          agent: input.agent.name,
          model: input.model,
          provider: item,
          message: input.user,
        },
        {
          temperature: input.model.capabilities.temperature
            ? (input.agent.temperature ?? ProviderTransform.temperature(input.model))
            : undefined,
          topP: input.agent.topP ?? ProviderTransform.topP(input.model),
          topK: ProviderTransform.topK(input.model),
          maxOutputTokens: ProviderTransform.maxOutputTokens(input.model),
          options,
        },
      )

      const { headers } = yield* plugin.trigger(
        "chat.headers",
        {
          sessionID: input.sessionID,
          agent: input.agent.name,
          model: input.model,
          provider: item,
          message: input.user,
        },
        {
          headers: {},
        },
      )

      const tools = resolveTools(input)

      // LiteLLM and some Anthropic proxies require the tools parameter to be present
      // when message history contains tool calls, even if no tools are being used.
      // Add a dummy tool that is never called to satisfy this validation.
      // This is enabled for:
      // 1. Providers with "litellm" in their ID or API ID (auto-detected)
      // 2. Providers with explicit "litellmProxy: true" option (opt-in for custom gateways)
      const isLiteLLMProxy =
        item.options?.["litellmProxy"] === true ||
        input.model.providerID.toLowerCase().includes("litellm") ||
        input.model.api.id.toLowerCase().includes("litellm")

      // LiteLLM/Bedrock rejects requests where the message history contains tool
      // calls but no tools param is present. When there are no active tools (e.g.
      // during compaction), inject a stub tool to satisfy the validation requirement.
      // The stub description explicitly tells the model not to call it.
      if (
        (isLiteLLMProxy || input.model.providerID.includes("github-copilot")) &&
        Object.keys(tools).length === 0 &&
        hasToolCalls(input.messages)
      ) {
        tools["_noop"] = tool({
          description: "Do not call this tool. It exists only for API compatibility and must never be invoked.",
          inputSchema: jsonSchema({
            type: "object",
            properties: {
              reason: { type: "string", description: "Unused" },
            },
          }),
          execute: async () => ({ output: "", title: "", metadata: {} }),
        })
      }

      // Wire up toolExecutor for DWS workflow models so that tool calls
      // from the workflow service are executed via opencode's tool system
      // and results sent back over the WebSocket.
      if (language instanceof GitLabWorkflowLanguageModel) {
        const workflowModel = language as GitLabWorkflowLanguageModel & {
          sessionID?: string
          sessionPreapprovedTools?: string[]
          approvalHandler?: (approvalTools: { name: string; args: string }[]) => Promise<{ approved: boolean }>
        }
        workflowModel.sessionID = input.sessionID
        workflowModel.systemPrompt = system.join("\n")
        workflowModel.toolExecutor = async (toolName, argsJson, _requestID) => {
          const t = tools[toolName]
          if (!t || !t.execute) {
            return { result: "", error: `Unknown tool: ${toolName}` }
          }
          try {
            const result = await t.execute!(JSON.parse(argsJson), {
              toolCallId: _requestID,
              messages: input.messages,
              abortSignal: input.abort,
            })
            const output = typeof result === "string" ? result : (result?.output ?? JSON.stringify(result))
            return {
              result: output,
              metadata: typeof result === "object" ? result?.metadata : undefined,
              title: typeof result === "object" ? result?.title : undefined,
            }
          } catch (e: any) {
            return { result: "", error: e.message ?? String(e) }
          }
        }

        const ruleset = Permission.merge(input.agent.permission ?? [], input.permission ?? [])
        workflowModel.sessionPreapprovedTools = Object.keys(tools).filter((name) => {
          const match = ruleset.findLast((rule) => Wildcard.match(name, rule.permission))
          return !match || match.action !== "ask"
        })

        const bridge = yield* EffectBridge.make()
        const approvedToolsForSession = new Set<string>()
        workflowModel.approvalHandler = InstanceState.bind(async (approvalTools) => {
          const uniqueNames = [...new Set(approvalTools.map((t: { name: string }) => t.name))] as string[]
          // Auto-approve tools that were already approved in this session
          // (prevents infinite approval loops for server-side MCP tools)
          if (uniqueNames.every((name) => approvedToolsForSession.has(name))) {
            return { approved: true }
          }

          const id = PermissionID.ascending()
          let unsub: (() => void) | undefined
          try {
            unsub = Bus.subscribe(Permission.Event.Replied, (evt) => {
              if (evt.properties.requestID === id) void evt.properties.reply
            })
            const toolPatterns = approvalTools.map((t: { name: string; args: string }) => {
              try {
                const parsed = JSON.parse(t.args) as Record<string, unknown>
                const title = (parsed?.title ?? parsed?.name ?? "") as string
                return title ? `${t.name}: ${title}` : t.name
              } catch {
                return t.name
              }
            })
            const uniquePatterns = [...new Set(toolPatterns)] as string[]
            await bridge.promise(
              perm.ask({
                id,
                sessionID: SessionID.make(input.sessionID),
                permission: "workflow_tool_approval",
                patterns: uniquePatterns,
                metadata: { tools: approvalTools },
                always: uniquePatterns,
                ruleset: [],
              }),
            )
            for (const name of uniqueNames) approvedToolsForSession.add(name)
            workflowModel.sessionPreapprovedTools = [...(workflowModel.sessionPreapprovedTools ?? []), ...uniqueNames]
            return { approved: true }
          } catch {
            return { approved: false }
          } finally {
            unsub?.()
          }
        })
      }

      const tracer = cfg.experimental?.openTelemetry
        ? Option.getOrUndefined(yield* Effect.serviceOption(OtelTracer.OtelTracer))
        : undefined
      const telemetryTracer = tracer
        ? new Proxy(tracer, {
            get(target, prop, receiver) {
              if (prop !== "startSpan") return Reflect.get(target, prop, receiver)
              return (...args: Parameters<typeof target.startSpan>) => {
                const span = target.startSpan(...args)
                span.setAttribute("session.id", input.sessionID)
                return span
              }
            },
          })
        : undefined

      const opencodeProjectID = input.model.providerID.startsWith("opencode")
        ? (yield* InstanceState.context).project.id
        : undefined

      const tryProvider = (model: Provider.Model, providerID: string, _modelID: string) =>
        Effect.gen(function* () {
          const language = yield* provider.getLanguage(model)
          return streamText({
            onError(error) {
              l.error("stream error", {
                error,
              })
            },
            async experimental_repairToolCall(failed) {
              const lower = failed.toolCall.toolName.toLowerCase()
              if (lower !== failed.toolCall.toolName && tools[lower]) {
                l.info("repairing tool call", {
                  tool: failed.toolCall.toolName,
                  repaired: lower,
                })
                return {
                  ...failed.toolCall,
                  toolName: lower,
                }
              }
              return {
                ...failed.toolCall,
                input: JSON.stringify({
                  tool: failed.toolCall.toolName,
                  error: failed.error.message,
                }),
                toolName: "invalid",
              }
            },
            temperature: params.temperature,
            topP: params.topP,
            topK: params.topK,
            providerOptions: ProviderTransform.providerOptions(model, params.options),
            activeTools: Object.keys(tools).filter((x) => x !== "invalid"),
            tools,
            toolChoice: input.toolChoice,
            maxOutputTokens: params.maxOutputTokens,
            abortSignal: input.abort,
            headers: {
              ...(providerID.startsWith("opencode")
                ? {
                    "x-opencode-project": opencodeProjectID,
                    "x-opencode-session": input.sessionID,
                    "x-opencode-request": input.user.id,
                    "x-opencode-client": Flag.OPENCODE_CLIENT,
                    "User-Agent": `opencode/${InstallationVersion}`,
                  }
                : {
                    "x-session-affinity": input.sessionID,
                    ...(input.parentSessionID ? { "x-parent-session-id": input.parentSessionID } : {}),
                    "User-Agent": `opencode/${InstallationVersion}`,
                  }),
              ...model.headers,
              ...headers,
            },
            maxRetries: input.retries ?? 0,
            messages,
            model: wrapLanguageModel({
              model: language,
              middleware: [
                {
                  specificationVersion: "v3" as const,
                  async transformParams(args) {
                    if (args.type === "stream") {
                      // @ts-expect-error
                      args.params.prompt = ProviderTransform.message(args.params.prompt, model, options)
                    }
                    return args.params
                  },
                },
              ],
            }),
            experimental_telemetry: {
              isEnabled: cfg.experimental?.openTelemetry,
              functionId: "session.llm",
              tracer: telemetryTracer,
              metadata: {
                userId: cfg.username ?? "unknown",
                sessionId: input.sessionID,
              },
            },
          })
        })

      return yield* withFallback(input, tryProvider, l)
    })

    const stream: Interface["stream"] = (input) =>
      Stream.scoped(
        Stream.unwrap(
          Effect.gen(function* () {
            const ctrl = yield* Effect.acquireRelease(
              Effect.sync(() => new AbortController()),
              (ctrl) => Effect.sync(() => ctrl.abort()),
            )

            const result = yield* run({ ...input, abort: ctrl.signal })

            return Stream.fromAsyncIterable(result.fullStream, (e) => (e instanceof Error ? e : new Error(String(e))))
          }),
        ),
      )

    return Service.of({ stream })
  }),
)

export const layer = live.pipe(Layer.provide(Permission.defaultLayer))

export const defaultLayer = Layer.suspend(() =>
  layer.pipe(
    Layer.provide(Auth.defaultLayer),
    Layer.provide(Config.defaultLayer),
    Layer.provide(Provider.defaultLayer),
    Layer.provide(Plugin.defaultLayer),
  ),
)

function resolveTools(input: Pick<StreamInput, "tools" | "agent" | "permission" | "user">) {
  const disabled = Permission.disabled(
    Object.keys(input.tools),
    Permission.merge(input.agent.permission, input.permission ?? []),
  )
  return Record.filter(input.tools, (_, k) => input.user.tools?.[k] !== false && !disabled.has(k))
}

// Check if messages contain any tool-call content
// Used to determine if a dummy tool should be added for LiteLLM proxy compatibility
export function hasToolCalls(messages: ModelMessage[]): boolean {
  for (const msg of messages) {
    if (!Array.isArray(msg.content)) continue
    for (const part of msg.content) {
      if (part.type === "tool-call" || part.type === "tool-result") return true
    }
  }
  return false
}

export * as LLM from "./llm"
