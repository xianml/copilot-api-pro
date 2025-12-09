import consola from "consola"
import { events } from "fetch-event-stream"

import { copilotBaseUrl, copilotHeaders } from "~/lib/api-config"
import { HTTPError } from "~/lib/error"
import { state } from "~/lib/state"

export interface ResponsesPayload {
  model: string
  input?: unknown
  messages?: unknown
  tools?: unknown
  tool_choice?: unknown
  temperature?: number | null
  top_p?: number | null
  max_output_tokens?: number | null
  max_tokens?: number | null
  stream?: boolean | null
  response_format?: { type: "json_object" } | null
  user?: string | null
}

export const createResponses = async (payload: ResponsesPayload) => {
  if (!state.copilotToken) throw new Error("Copilot token not found")

  const response = await fetch(`${copilotBaseUrl(state)}/responses`, {
    method: "POST",
    headers: copilotHeaders(state),
    body: JSON.stringify(payload),
  })

  if (!response.ok) {
    consola.error("Failed to create responses", response)
    throw new HTTPError("Failed to create responses", response)
  }

  if (payload.stream) {
    return events(response)
  }

  return (await response.json()) as ResponsesResponse
}

export interface ResponsesResponse {
  id: string
  object: "response"
  model: string
  created: number
  output: Array<unknown>
  output_text?: string
  stop_reason?: string | null
  stop_sequence?: string | null
  usage?: {
    prompt_tokens: number
    completion_tokens: number
    total_tokens: number
  }
}
