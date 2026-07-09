// Structured JSON logging on stdout — Loki scrapes the container's stdout, so
// every line is one JSON object it can index by field. In dev, set
// LOG_PRETTY=1 for human-readable colourised output instead.
//
// The mixin stamps each line with the active OpenTelemetry trace/span id, so a
// log line in Loki links straight to its trace in Tempo (configure a derived
// field on `trace_id` in Grafana's Loki datasource).
import pino from "pino";
import { trace, context } from "@opentelemetry/api";

const pretty = process.env.LOG_PRETTY === "1";

export const logger = pino({
  level: process.env.LOG_LEVEL || "info",
  base: {
    service: process.env.OTEL_SERVICE_NAME || "telegram-bot",
    env: process.env.NODE_ENV || "development",
  },
  // Loki-friendly: `level` as a string label rather than pino's numeric code.
  formatters: { level: (label) => ({ level: label }) },
  timestamp: pino.stdTimeFunctions.isoTime,
  mixin() {
    const span = trace.getSpan(context.active());
    if (!span) return {};
    const { traceId, spanId } = span.spanContext();
    return { trace_id: traceId, span_id: spanId };
  },
  ...(pretty
    ? { transport: { target: "pino-pretty", options: { colorize: true } } }
    : {}),
});
