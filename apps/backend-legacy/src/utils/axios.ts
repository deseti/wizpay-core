import axios from "axios";
import { env } from "../config/env.js";

/**
 * Pre-configured Axios instance for Circle StableFX API calls.
 * Currently returns a base client; headers will be populated once
 * Circle credentials are available.
 */
export const circleClient = axios.create({
  baseURL: env.circleApiBaseUrl,
  timeout: 15_000,
  headers: {
    "Content-Type": "application/json",
    ...(env.circleApiKey
      ? { Authorization: `Bearer ${env.circleApiKey}` }
      : {}),
  },
});

/**
 * Generic Axios instance for external HTTP calls (e.g. price feeds).
 */
export const httpClient = axios.create({
  timeout: 10_000,
  headers: { "Content-Type": "application/json" },
});
