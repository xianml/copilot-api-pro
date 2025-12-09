import { Hono } from "hono"

import { handleResponseEndpoint } from "./handler"

export const responsesRoutes = new Hono()

responsesRoutes.post("/", handleResponseEndpoint)
