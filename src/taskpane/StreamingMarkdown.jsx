import { useEffect, useRef } from "react";
import {
  default_add_text,
  default_add_token,
  default_end_token,
  default_renderer,
  default_set_attr,
  parser as createParser,
  parser_end,
  parser_write
} from "streaming-markdown";

function createCompositeRenderer(container, sink) {
  const domRenderer = default_renderer(container);
  const sinkRenderer = sink?.renderer ?? null;

  return {
    data: {
      dom: domRenderer.data,
      sink: sinkRenderer?.data ?? null
    },
    add_token(data, type) {
      default_add_token(data.dom, type);
      sinkRenderer?.add_token?.(data.sink, type);
    },
    end_token(data) {
      default_end_token(data.dom);
      sinkRenderer?.end_token?.(data.sink);
    },
    add_text(data, text) {
      default_add_text(data.dom, text);
      sinkRenderer?.add_text?.(data.sink, text);
    },
    set_attr(data, type, value) {
      default_set_attr(data.dom, type, value);
      sinkRenderer?.set_attr?.(data.sink, type, value);
    }
  };
}

function resetParserState(container, parserRef, renderedRef, endedRef, sinkRef) {
  container.innerHTML = "";
  parserRef.current = createParser(createCompositeRenderer(container, sinkRef.current));
  renderedRef.current = "";
  endedRef.current = false;
}

export default function StreamingMarkdown({ content, streaming, sink = null }) {
  const containerRef = useRef(null);
  const parserRef = useRef(null);
  const renderedContentRef = useRef("");
  const endedRef = useRef(false);
  const sinkRef = useRef(sink);

  useEffect(() => {
    sinkRef.current = sink;
  }, [sink]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return;
    }

    const nextContent = String(content ?? "");
    if (!parserRef.current) {
      resetParserState(
        container,
        parserRef,
        renderedContentRef,
        endedRef,
        sinkRef
      );
    }

    if (!nextContent.startsWith(renderedContentRef.current)) {
      resetParserState(
        container,
        parserRef,
        renderedContentRef,
        endedRef,
        sinkRef
      );
    }

    const delta = nextContent.slice(renderedContentRef.current.length);
    if (delta) {
      parser_write(parserRef.current, delta);
      renderedContentRef.current = nextContent;
    }

    if (!streaming && !endedRef.current) {
      parser_end(parserRef.current);
      sinkRef.current?.finish?.();
      endedRef.current = true;
    }
  }, [content, streaming, sink]);

  useEffect(() => {
    return () => {
      parserRef.current = null;
      renderedContentRef.current = "";
      endedRef.current = false;
    };
  }, []);

  if (!content) {
    return <div className="bubble-placeholder">{streaming ? "..." : ""}</div>;
  }

  return <div ref={containerRef} className="bubble-markdown" />;
}
