// Observability bootstrap: OpenTelemetry tracing (-> Tempo) and continuous
// profiling (-> Pyroscope). Loaded via `node --import ./src/telemetry.js`
// BEFORE the app so the auto-instrumentations can monkey-patch http/undici
// (global fetch) before Telegraf and the tool clients grab references.
//
// Every subsystem is opt-in behind an env var so the bot still runs locally
// with no Grafana stack around — nothing is exported, nothing errors.
import "dotenv/config";

const SERVICE_NAME = process.env.OTEL_SERVICE_NAME || "telegram-bot";
const SERVICE_VERSION = process.env.OTEL_SERVICE_VERSION || "0.1.0";

// --- Tracing → Tempo (OTLP/HTTP protobuf, default Tempo port 4318) ---------
if (process.env.OTEL_EXPORTER_OTLP_ENDPOINT || process.env.OTEL_TRACES_ENABLED === "1") {
  const { NodeSDK } = await import("@opentelemetry/sdk-node");
  const { OTLPTraceExporter } = await import("@opentelemetry/exporter-trace-otlp-proto");
  const { getNodeAutoInstrumentations } = await import(
    "@opentelemetry/auto-instrumentations-node"
  );
  const { resourceFromAttributes } = await import("@opentelemetry/resources");
  const { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } = await import(
    "@opentelemetry/semantic-conventions"
  );

  const sdk = new NodeSDK({
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: SERVICE_NAME,
      [ATTR_SERVICE_VERSION]: SERVICE_VERSION,
    }),
    // Endpoint defaults to http://localhost:4318/v1/traces; the exporter reads
    // OTEL_EXPORTER_OTLP_ENDPOINT and appends the signal path automatically.
    traceExporter: new OTLPTraceExporter(),
    instrumentations: [
      getNodeAutoInstrumentations({
        // fs spans are pure noise for a network-bound bot.
        "@opentelemetry/instrumentation-fs": { enabled: false },
      }),
    ],
  });

  sdk.start();
  console.log(`[telemetry] tracing → ${process.env.OTEL_EXPORTER_OTLP_ENDPOINT || "http://localhost:4318"}`);

  const shutdown = () => sdk.shutdown().catch(() => {}).finally(() => process.exit(0));
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
}

// --- Continuous profiling → Pyroscope --------------------------------------
if (process.env.PYROSCOPE_SERVER_ADDRESS) {
  const Pyroscope = (await import("@pyroscope/nodejs")).default;
  Pyroscope.init({
    serverAddress: process.env.PYROSCOPE_SERVER_ADDRESS,
    appName: SERVICE_NAME,
    // Tag every profile with the service version so Grafana can split flame
    // graphs by deploy.
    tags: { version: SERVICE_VERSION },
    // Pull auth token / basic-auth from env when talking to Grafana Cloud.
    authToken: process.env.PYROSCOPE_AUTH_TOKEN || undefined,
    basicAuthUser: process.env.PYROSCOPE_BASIC_AUTH_USER || undefined,
    basicAuthPassword: process.env.PYROSCOPE_BASIC_AUTH_PASSWORD || undefined,
  });
  Pyroscope.start();
  console.log(`[telemetry] profiling → ${process.env.PYROSCOPE_SERVER_ADDRESS}`);

  process.once("SIGTERM", () => Pyroscope.stop().catch(() => {}));
  process.once("SIGINT", () => Pyroscope.stop().catch(() => {}));
}
