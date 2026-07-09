// Thin wrapper over the OTel API for the manual spans we add by hand (the
// auto-instrumentation only sees the outbound http/fetch calls, not our own
// message-handling logic). No-ops cleanly when tracing is disabled.
import { trace, SpanStatusCode } from "@opentelemetry/api";

const tracer = trace.getTracer("telegram-bot");

/**
 * Run `fn` inside a span named `name`, recording exceptions and setting the
 * span status. `attrs` are attached up front. Returns whatever `fn` returns.
 */
export function withSpan(name, attrs, fn) {
  return tracer.startActiveSpan(name, { attributes: attrs }, async (span) => {
    try {
      return await fn(span);
    } catch (err) {
      span.recordException(err);
      span.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
      throw err;
    } finally {
      span.end();
    }
  });
}
