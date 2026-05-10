[2026-05-09T21:49:21.820Z] [INFO] [ui] User submitted a generation request. {"promptLength":3}
[2026-05-09T21:49:21.828Z] [INFO] [generation] streamCompletion called with settings. {"hasApiKey":"true","apiKeyLength":73,"model":"inclusionai/ring-2.6-1t:free","baseUrl":"https://openrouter.ai/api/v1"}
[2026-05-09T21:49:21.829Z] [INFO] [generation] createRequestBody called. {"model":"inclusionai/ring-2.6-1t:free","modelTrimmed":"inclusionai/ring-2.6-1t:free","temperature":0.5,"messagesCount":1}
[2026-05-09T21:49:21.829Z] [INFO] [generation] Preparing streamed completion request. {"provider":"openrouter","model":"inclusionai/ring-2.6-1t:free"}
[2026-05-09T21:49:21.829Z] [INFO] [relay] Starting local relay health check. {"url":"http://127.0.0.1:3888/health"}
[2026-05-09T21:49:21.836Z] [INFO] [relay] Relay health check succeeded. {"attempt":1,"status":200}
[2026-05-09T21:49:21.837Z] [INFO] [generation] Sending streamed completion request. {"url":"http://127.0.0.1:3888/openrouter/v1/chat/completions","viaRelay":"true","upstreamBaseUrl":"https://openrouter.ai/api/v1"}
[2026-05-09T21:49:21.837Z] [INFO] [stream] Opening relay streaming request. {"url":"http://127.0.0.1:3888/openrouter/v1/chat/completions"}
[2026-05-09T21:49:21.885Z] [INFO] [stream] Relay returned the first response bytes. {"status":200,"bytes":15}
[2026-05-09T21:49:23.006Z] [INFO] [generation] Received the first relay event.
[2026-05-09T21:49:23.006Z] [ERROR] [generation] Streamed completion failed. {"error":"Internal Server Error"}
[2026-05-09T21:49:23.007Z] [ERROR] [ui] Generation ended with an error. {"error":"Internal Server Error"}
[2026-05-09T21:49:23.007Z] [INFO] [stream] Relay streaming request completed. {"status":200,"bytes":107}
[2026-05-09T22:02:18.537Z] [INFO] [bootstrap] Loading relay bootstrap settings.
[2026-05-09T22:02:18.579Z] [INFO] [bootstrap] Relay bootstrap settings loaded.
[2026-05-09T22:18:27.440Z] [INFO] [bootstrap] Loading relay bootstrap settings.
[2026-05-09T22:18:27.478Z] [INFO] [bootstrap] Relay bootstrap settings loaded.
[2026-05-09T22:18:30.968Z] [INFO] [openrouter] Testing OpenRouter connection. {"model":"inclusionai/ring-2.6-1t:free"}
[2026-05-09T22:18:30.968Z] [INFO] [relay] Starting local relay health check. {"url":"http://127.0.0.1:3888/health"}
[2026-05-09T22:18:30.976Z] [INFO] [relay] Relay health check succeeded. {"attempt":1,"status":200}
[2026-05-09T22:18:33.781Z] [INFO] [openrouter] Testing OpenRouter connection. {"model":"inclusionai/ring-2.6-1t:free"}
[2026-05-09T22:18:33.781Z] [INFO] [relay] Starting local relay health check. {"url":"http://127.0.0.1:3888/health"}
[2026-05-09T22:18:33.795Z] [INFO] [relay] Relay health check succeeded. {"attempt":1,"status":200}
[2026-05-09T22:18:35.964Z] [INFO] [openrouter] Testing OpenRouter connection. {"model":"inclusionai/ring-2.6-1t:free"}
[2026-05-09T22:18:35.965Z] [INFO] [relay] Starting local relay health check. {"url":"http://127.0.0.1:3888/health"}
[2026-05-09T22:18:35.972Z] [INFO] [relay] Relay health check succeeded. {"attempt":1,"status":200}
[2026-05-09T22:18:37.903Z] [INFO] [openrouter] Testing OpenRouter connection. {"model":"inclusionai/ring-2.6-1t:free"}
[2026-05-09T22:18:37.903Z] [INFO] [relay] Starting local relay health check. {"url":"http://127.0.0.1:3888/health"}
[2026-05-09T22:18:37.910Z] [INFO] [relay] Relay health check succeeded. {"attempt":1,"status":200}
[2026-05-09T22:18:43.851Z] [INFO] [ui] User submitted a generation request. {"promptLength":3}
[2026-05-09T22:18:43.856Z] [INFO] [generation] streamCompletion called with settings. {"hasApiKey":"true","apiKeyLength":73,"model":"inclusionai/ring-2.6-1t:free","baseUrl":"https://openrouter.ai/api/v1"}
[2026-05-09T22:18:43.856Z] [INFO] [generation] createRequestBody called. {"model":"inclusionai/ring-2.6-1t:free","modelTrimmed":"inclusionai/ring-2.6-1t:free","temperature":0.5,"messagesCount":3}
[2026-05-09T22:18:43.857Z] [INFO] [generation] Preparing streamed completion request. {"provider":"openrouter","model":"inclusionai/ring-2.6-1t:free"}
[2026-05-09T22:18:43.857Z] [INFO] [relay] Starting local relay health check. {"url":"http://127.0.0.1:3888/health"}
[2026-05-09T22:18:43.871Z] [INFO] [relay] Relay health check succeeded. {"attempt":1,"status":200}
[2026-05-09T22:18:43.871Z] [INFO] [generation] Sending streamed completion request. {"url":"http://127.0.0.1:3888/openrouter/v1/chat/completions","viaRelay":"true","upstreamBaseUrl":"https://openrouter.ai/api/v1"}
[2026-05-09T22:18:43.872Z] [INFO] [stream] Opening relay streaming request. {"url":"http://127.0.0.1:3888/openrouter/v1/chat/completions"}
[2026-05-09T22:18:43.917Z] [INFO] [stream] Relay returned the first response bytes. {"status":200,"bytes":15}
[2026-05-09T22:18:45.136Z] [INFO] [generation] Received the first relay event.
[2026-05-09T22:18:45.136Z] [ERROR] [generation] Streamed completion failed. {"error":"(22) The requested URL returned error: 500"}
[2026-05-09T22:18:45.137Z] [ERROR] [ui] Generation ended with an error. {"error":"(22) The requested URL returned error: 500"}
[2026-05-09T22:18:45.137Z] [INFO] [stream] Relay streaming request completed. {"status":200,"bytes":128}
[2026-05-10T08:14:51.485Z] [INFO] [bootstrap] Loading relay bootstrap settings.
[2026-05-10T08:14:51.525Z] [INFO] [bootstrap] Relay bootstrap settings loaded.
[2026-05-10T08:15:12.317Z] [INFO] [ui] User submitted a generation request. {"promptLength":3,"provider":"openrouter"}
[2026-05-10T08:15:12.324Z] [INFO] [generation] Preparing streamed completion. {"provider":"openrouter","model":"inclusionai/ring-2.6-1t:free"}
[2026-05-10T08:15:12.324Z] [INFO] [relay] Starting local relay health check. {"url":"http://127.0.0.1:3888/health"}
[2026-05-10T08:15:12.333Z] [INFO] [relay] Relay health check succeeded. {"attempt":1}
[2026-05-10T08:15:12.334Z] [INFO] [generation] Sending streamed completion. {"url":"http://127.0.0.1:3888/openrouter/v1/chat/completions"}
[2026-05-10T08:15:12.334Z] [INFO] [stream] Opening relay streaming request. {"url":"http://127.0.0.1:3888/openrouter/v1/chat/completions"}
[2026-05-10T08:15:14.833Z] [ERROR] [generation] Streamed completion failed. {"error":"(22) The requested URL returned error: 500"}
[2026-05-10T08:15:50.020Z] [INFO] [ui] User submitted a generation request. {"promptLength":3,"provider":"openrouter"}
[2026-05-10T08:15:50.023Z] [INFO] [generation] Preparing streamed completion. {"provider":"openrouter","model":"inclusionai/ring-2.6-1t:free"}
[2026-05-10T08:15:50.023Z] [INFO] [relay] Starting local relay health check. {"url":"http://127.0.0.1:3888/health"}
[2026-05-10T08:15:50.033Z] [INFO] [relay] Relay health check succeeded. {"attempt":1}
[2026-05-10T08:15:50.034Z] [INFO] [generation] Sending streamed completion. {"url":"http://127.0.0.1:3888/openrouter/v1/chat/completions"}
[2026-05-10T08:15:50.034Z] [INFO] [stream] Opening relay streaming request. {"url":"http://127.0.0.1:3888/openrouter/v1/chat/completions"}
[2026-05-10T08:15:56.894Z] [ERROR] [generation] Streamed completion failed. {"error":"(22) The requested URL returned error: 500"}
[2026-05-10T08:26:31.586Z] [INFO] [bootstrap] Loading relay bootstrap settings.
[2026-05-10T08:26:31.633Z] [INFO] [bootstrap] Relay bootstrap settings loaded.
[2026-05-10T08:26:42.712Z] [INFO] [models] Loading models through the local relay. {"provider":"openrouter"}
[2026-05-10T08:26:42.713Z] [INFO] [relay] Starting local relay health check. {"url":"http://127.0.0.1:3888/health"}
[2026-05-10T08:26:42.722Z] [INFO] [relay] Relay health check succeeded. {"attempt":1}
[2026-05-10T08:26:45.511Z] [INFO] [models] Model list loaded. {"count":367}
[2026-05-10T08:26:53.831Z] [INFO] [ui] User submitted a generation request. {"promptLength":3,"provider":"openrouter"}
[2026-05-10T08:26:53.842Z] [INFO] [generation] Preparing streamed completion. {"provider":"openrouter","model":"inclusionai/ring-2.6-1t:free"}
[2026-05-10T08:26:53.842Z] [INFO] [relay] Starting local relay health check. {"url":"http://127.0.0.1:3888/health"}
[2026-05-10T08:26:53.855Z] [INFO] [relay] Relay health check succeeded. {"attempt":1}
[2026-05-10T08:26:53.856Z] [INFO] [generation] Sending streamed completion. {"url":"http://127.0.0.1:3888/openrouter/v1/chat/completions"}
[2026-05-10T08:26:53.857Z] [INFO] [stream] Opening relay streaming request. {"url":"http://127.0.0.1:3888/openrouter/v1/chat/completions"}
[2026-05-10T08:26:55.046Z] [ERROR] [generation] Streamed completion failed. {"error":"Internal Server Error"}
[2026-05-10T08:26:56.702Z] [INFO] [ui] User submitted a generation request. {"promptLength":3,"provider":"openrouter"}
[2026-05-10T08:26:56.706Z] [INFO] [generation] Preparing streamed completion. {"provider":"openrouter","model":"inclusionai/ring-2.6-1t:free"}
[2026-05-10T08:26:56.706Z] [INFO] [relay] Starting local relay health check. {"url":"http://127.0.0.1:3888/health"}
[2026-05-10T08:26:56.717Z] [INFO] [relay] Relay health check succeeded. {"attempt":1}
[2026-05-10T08:26:56.717Z] [INFO] [generation] Sending streamed completion. {"url":"http://127.0.0.1:3888/openrouter/v1/chat/completions"}
[2026-05-10T08:26:56.718Z] [INFO] [stream] Opening relay streaming request. {"url":"http://127.0.0.1:3888/openrouter/v1/chat/completions"}
[2026-05-10T08:26:57.861Z] [ERROR] [generation] Streamed completion failed. {"error":"Internal Server Error"}
[2026-05-10T08:26:58.690Z] [INFO] [ui] User submitted a generation request. {"promptLength":3,"provider":"openrouter"}
[2026-05-10T08:26:58.695Z] [INFO] [generation] Preparing streamed completion. {"provider":"openrouter","model":"inclusionai/ring-2.6-1t:free"}
[2026-05-10T08:26:58.696Z] [INFO] [relay] Starting local relay health check. {"url":"http://127.0.0.1:3888/health"}
[2026-05-10T08:26:58.706Z] [INFO] [relay] Relay health check succeeded. {"attempt":1}
[2026-05-10T08:26:58.706Z] [INFO] [generation] Sending streamed completion. {"url":"http://127.0.0.1:3888/openrouter/v1/chat/completions"}
[2026-05-10T08:26:58.707Z] [INFO] [stream] Opening relay streaming request. {"url":"http://127.0.0.1:3888/openrouter/v1/chat/completions"}
[2026-05-10T08:26:59.897Z] [ERROR] [generation] Streamed completion failed. {"error":"Internal Server Error"}
[2026-05-10T08:27:53.223Z] [INFO] [ui] User submitted a generation request. {"promptLength":3,"provider":"openrouter"}
[2026-05-10T08:27:53.228Z] [INFO] [generation] Preparing streamed completion. {"provider":"openrouter","model":"inclusionai/ring-2.6-1t:free"}
[2026-05-10T08:27:53.229Z] [INFO] [relay] Starting local relay health check. {"url":"http://127.0.0.1:3888/health"}
[2026-05-10T08:27:53.238Z] [INFO] [relay] Relay health check succeeded. {"attempt":1}
[2026-05-10T08:27:53.238Z] [INFO] [generation] Sending streamed completion. {"url":"http://127.0.0.1:3888/openrouter/v1/chat/completions"}
[2026-05-10T08:27:53.239Z] [INFO] [stream] Opening relay streaming request. {"url":"http://127.0.0.1:3888/openrouter/v1/chat/completions"}
[2026-05-10T08:29:22.347Z] [ERROR] [generation] The relay stream closed without returning any events.
[2026-05-10T08:29:22.347Z] [ERROR] [generation] Streamed completion failed. {"error":"The relay stream closed without returning any events."}
[2026-05-10T08:29:23.902Z] [INFO] [ui] User submitted a generation request. {"promptLength":3,"provider":"openrouter"}
[2026-05-10T08:29:23.908Z] [INFO] [generation] Preparing streamed completion. {"provider":"openrouter","model":"inclusionai/ring-2.6-1t:free"}
[2026-05-10T08:29:23.908Z] [INFO] [relay] Starting local relay health check. {"url":"http://127.0.0.1:3888/health"}
[2026-05-10T08:29:23.919Z] [INFO] [relay] Relay health check succeeded. {"attempt":1}
[2026-05-10T08:29:23.919Z] [INFO] [generation] Sending streamed completion. {"url":"http://127.0.0.1:3888/openrouter/v1/chat/completions"}
[2026-05-10T08:29:23.919Z] [INFO] [stream] Opening relay streaming request. {"url":"http://127.0.0.1:3888/openrouter/v1/chat/completions"}
[2026-05-10T08:29:26.998Z] [ERROR] [generation] Streamed completion failed. {"error":"Internal Server Error"}